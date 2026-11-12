import { afterEach, expect, it, vi } from 'vitest'
import { startRuntime } from './fixtures/host.ts'
import { Commands } from '../src/infra/commands.ts'
import { pollRequests, pollScheduledCi } from '../src/sources/github-events.ts'
import { githubKind, pollRound } from '../src/sources/github.ts'
import { branchCiTrigger, commentTrigger } from '../src/sources/github-trigger.ts'
import { dingTalkKind, DingTalk } from '../src/sources/dingtalk.ts'
import { key, type OutboundMessage } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'

let h: Awaited<ReturnType<typeof startRuntime>> | undefined
afterEach(async () => { await h?.stop(); h = undefined; vi.restoreAllMocks() })
const comment = (id: number, text = '@agent-bot fix this', login = 'alice') => commentTrigger({ id, body: text,
  user: { login, type: 'User' }, html_url: `https://github.com/acme/widgets/pull/7#issuecomment-${id}`,
  created_at: new Date().toISOString() }, { number: 7, isPr: true }, 'conversation', 'agent-bot')

it('delivers review requests as new candidates and lets the main agent route them', async () => {
  h = await startRuntime()
  const original = await h.acceptedTicket(comment(1))
  const events = [{ id: 11, event: 'review_requested', created_at: new Date().toISOString(),
    actor: { login: 'alice', type: 'User' }, requested_reviewer: { login: 'agent-bot' } }]
  vi.spyOn(Commands.prototype, 'pages').mockImplementation(async () => events)
  const source = h.runtime.context(githubKind)
  await pollRequests(source, 7, true, '2000-01-01T00:00:00Z', 'Fix PR', 'Please review')
  await pollRequests(source, 7, true, '2000-01-01T00:00:00Z', 'Fix PR', 'Please review')
  await h.runtime.idle()
  const id = key('github-request', '11')
  expect(h.candidates().filter(candidate => candidate === id)).toHaveLength(1)
  const routed = await h.route({ kind: 'accept', trigger_id: id, title: 'Review PR 7', worktree_name: 'review-pr', acknowledgement: 'Reviewing PR 7.' })
  expect((routed.ticket as { ticket_id: string }).ticket_id).not.toBe(original.ticket.id)
  expect(h.runtime.store.tickets.get(original.ticket.id)!.inputs.some(input => input.kind === 'trigger' && input.triggerId === id)).toBe(false)
  events.push({ ...events[0]!, id: 12 })
  await pollRequests(source, 7, true, '2000-01-01T00:00:00Z', 'Fix PR', 'Please review')
  await h.runtime.idle()
  expect(h.candidates()).toContain(key('github-request', '12'))
  await h.route({ kind: 'attach', trigger_id: key('github-request', '12'), ticket_id: original.ticket.id })
  expect(h.runtime.store.tickets.get(original.ticket.id)!.inputs.some(input => input.kind === 'trigger'
    && input.triggerId === key('github-request', '12'))).toBe(true)
})

it('uses the actual assigner, ignores removed and unrelated requests, and applies the static allowed list', async () => {
  h = await startRuntime()
  let events: Record<string, unknown>[] = [{ id: 20, event: 'assigned', created_at: new Date().toISOString(),
    actor: { login: 'mallory', type: 'User' }, assignee: { login: 'agent-bot' } }]
  vi.spyOn(Commands.prototype, 'pages').mockImplementation(async () => events)
  const source = h.runtime.context(githubKind)
  await pollRequests(source, 20, false, '2000-01-01T00:00:00Z', 'Issue', 'Details')
  await h.runtime.idle()
  expect(h.candidates()).toEqual([])
  expect(h.runtime.store.decisions.byThread('github:request:20')[0]).toMatchObject({ kind: 'ignore' })
  events = [events[0]!, { ...events[0], id: 21, actor: { login: 'alice', type: 'User' } }]
  await pollRequests(source, 20, false, '2000-01-01T00:00:00Z', 'Issue', 'Details')
  await h.runtime.idle()
  expect(h.candidates()).toEqual([key('github-request', '21')])
  events.push({ ...events[1], id: 22, event: 'unassigned' })
  await pollRequests(source, 20, false, '2000-01-01T00:00:00Z', 'Issue', 'Details')
  expect(h.runtime.store.triggers.get(key('github-request', '22'))).toBeUndefined()
})

it('reuses branch CI polling on main and keeps the existing admission and reply flow', async () => {
  h = await startRuntime(undefined, 'test-group')
  const sent: OutboundMessage[] = []
  h.runtime.sources.register(dingTalkKind(async message => { sent.push(message) }))
  let check = { name: 'Nightly linux_arm64', status: 'completed', conclusion: 'failure' as string | null }
  const calls = vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => {
    const path = args[1]!.replace(/^repos\/acme\/widgets\/?/, '').split('?')[0]
    if (['issues', 'issues/comments', 'pulls/comments'].includes(path!)) return 'HTTP/2.0 200 OK\r\n\r\n[]'
    if (path === 'commits/main') return JSON.stringify({ sha: 'abc1234567' })
    if (path === 'commits/abc1234567/check-runs') return JSON.stringify([{ check_runs: [check] }])
    if (path === 'commits/abc1234567/statuses') return JSON.stringify([[]])
    if (path === 'actions/runs') return JSON.stringify([{ workflow_runs: [] }])
    throw new Error('Unexpected endpoint: ' + path)
  })
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async function (this: Commands, args) {
    return JSON.parse(await this.run(this.deployment.github.cli, args))
  })
  const original = h.runtime.context(githubKind)
  const source = { ...original, deployment: { ...original.deployment, github: { ...original.deployment.github, auth: 'app' as const } } }
  await pollRound(source); await h.runtime.idle()
  expect(sent).toHaveLength(0)
  expect(h.runtime.store.get(KV.github.branchCi)?.failures).toContain('Nightly linux_arm64')
  const events = () => h!.relays(h!.runtime.masterId).filter(item => item.kind === 'github_event')
  expect(events()).toHaveLength(1)
  expect(events()[0]).toMatchObject({ event: 'GitHub Main CI', human: false,
    meta: { ci: true, branch: 'main' }, reply_channel: { source: 'dingtalk', address: { conversationId: 'test-group' } } })
  expect(JSON.stringify(events()[0])).toContain('Nightly linux_arm64')
  expect(h.candidates()).toEqual([])
  await pollRound(source); await h.runtime.idle()
  expect(sent).toHaveLength(0)
  expect(events()).toHaveLength(1)
  const previous = h.runtime.store.get(KV.github.branchCi)
  calls.mockRejectedValueOnce(new Error('HTTP 503'))
  await expect(pollRound(source)).rejects.toThrow('HTTP 503')
  expect(h.runtime.store.get(KV.github.branchCi)).toEqual(previous)
  check = { ...check, conclusion: null, status: 'in_progress' }
  await pollRound(source); await h.runtime.idle()
  expect(sent).toHaveLength(0)
  check = { ...check, conclusion: 'success', status: 'completed' }
  await pollRound(source); await h.runtime.idle()
  expect(sent).toHaveLength(0)
  expect(h.runtime.store.get(KV.github.branchCi)?.failures).toEqual([])
  expect(events()).toHaveLength(2)
  expect(h.candidates()).toEqual([])
})

it.each(['assignment', 'review_request', 'conversation', 'inline', 'review', 'pr-ci', 'main-ci'])(
  'relays each new %s event to the main agent even when admission would reject it', async kind => {
    h = await startRuntime()
    const trigger = kind === 'main-ci' ? branchCiTrigger('main', 'abc123', 1, 'Nightly failed', 'https://github.com/acme/widgets/commit/abc123')
      : { ...comment(91, 'Original event body', 'guest'), human: !['review', 'pr-ci'].includes(kind),
        addressed: kind === 'pr-ci' ? undefined : 'mention' as const,
        meta: { number: 7, isPr: kind !== 'assignment', kind, ...kind === 'pr-ci' ? { ci: true } : {} } }
    const source = h.runtime.context(githubKind)
    await source.receive(trigger); await h.runtime.idle()
    const events = () => h!.relays(h!.runtime.masterId).filter(item => item.kind === 'github_event')
    expect(events()).toHaveLength(1)
    expect(events()[0]).toMatchObject({ trigger_id: trigger.id, source_url: trigger.url, text: trigger.text })
    expect(h.candidates()).toEqual([])
    await source.receive(trigger); await h.runtime.idle()
    expect(events()).toHaveLength(1)
  })

it('delivers each completed main schedule run regardless of result, including reruns and an older commit', async () => {
  h = await startRuntime(undefined, 'test-group')
  const started = new Date(Date.now() - 60_000).toISOString()
  const run = { id: 100, run_attempt: 1, name: 'Nightly', event: 'schedule', status: 'completed', conclusion: 'success',
    head_branch: 'main', head_sha: 'older-commit', html_url: 'https://github.com/acme/widgets/actions/runs/100',
    updated_at: new Date().toISOString() }
  let runs = [{ ...run, updated_at: new Date(Date.parse(started) - 60_000).toISOString() },
    { ...run, id: 101, status: 'in_progress', conclusion: null }, { ...run, id: 102, event: 'push' },
    { ...run, id: 103, head_branch: 'feature' }]
  const calls = vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => {
    expect(args[1]).toContain('actions/runs?branch=main&event=schedule&status=completed')
    expect(args).toContain('--paginate')
    expect(args).toContain('--slurp')
    return JSON.stringify([{ workflow_runs: runs.slice(0, 1) }, { workflow_runs: runs.slice(1) }])
  })
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async function (this: Commands, args) {
    return JSON.parse(await this.run(this.deployment.github.cli, args))
  })
  const poll = async () => { await pollScheduledCi(h!.runtime.context(githubKind), 'main', started); await h!.runtime.idle() }
  const events = () => h!.relays(h!.runtime.masterId).filter(item => item.kind === 'github_event')
  await poll()
  expect(events()).toHaveLength(0)
  runs = [run, { ...run, id: 101, conclusion: 'failure' }]
  await poll()
  expect(events()).toHaveLength(2)
  expect(events()[0]).toMatchObject({ meta: { event: 'schedule', conclusion: 'success', sha: 'older-commit' },
    reply_channel: { source: 'dingtalk', address: { conversationId: 'test-group' } } })
  expect(events()[1]).toMatchObject({ meta: { event: 'schedule', conclusion: 'failure' } })
  await poll()
  expect(events()).toHaveLength(2)
  runs = [{ ...run, run_attempt: 2 }, { ...run, id: 104 }]
  await poll()
  expect(events()).toHaveLength(4)
  expect(events()[2]).toMatchObject({ meta: { runId: 100, runAttempt: 2, conclusion: 'success' } })
  expect(events()[3]).toMatchObject({ meta: { runId: 104, conclusion: 'success' } })
  await poll()
  expect(events()).toHaveLength(4)
  expect(calls).toHaveBeenCalledTimes(5)
  expect(h.candidates()).toEqual([])
})

it('keeps an own PR subscribed after ready and routes unmentioned comments to its original worker', async () => {
  h = await startRuntime(undefined, 'test-group')
  const sent: OutboundMessage[] = []
  h.runtime.sources.register(dingTalkKind(async message => { sent.push(message) }))
  const source = h.runtime.context(githubKind)
  const githubSent: OutboundMessage[] = []
  const send = h.runtime.sources.send.bind(h.runtime.sources)
  vi.spyOn(h.runtime.sources, 'send').mockImplementation(async (message, commands) => {
    if (message.channel.source === 'github') { githubSent.push(message); return 'sent' }
    return send(message, commands)
  })
  await source.receive(comment(1)); await h.runtime.idle()
  expect(sent).toHaveLength(0)
  const routed = await h.route({ kind: 'accept', trigger_id: comment(1).id, title: 'Fix PR', worktree_name: 'fix-pr', acknowledgement: 'Fixing PR.' })
  const id = (routed.ticket as { ticket_id: string }).ticket_id
  await h.runtime.idle()
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ kind: 'acknowledgement', text: 'Fixing PR.',
    channel: { source: 'dingtalk', address: { conversationId: 'test-group', eventLabel: 'GitHub Comment Mention' } } })
  expect(githubSent).toHaveLength(0)
  h.runtime.engine.bindThread(id, { source: 'github', id: '7' }, true)
  await h.runTool(`worker-${id}`, 'orchestrator_report', { state: 'ready', summary: 'Ready for review' })
  await h.runtime.idle()
  expect(sent).toHaveLength(1)
  expect(h.relays(h.runtime.masterId).some(item => item.kind === 'worker_report' && item.summary === 'Ready for review')).toBe(true)
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: id, purpose: 'result', text: 'Ready for review' })
  await h.runtime.idle()
  expect(sent.at(-1)).toMatchObject({ kind: 'reply', text: 'Ready for review',
    channel: { source: 'dingtalk', address: { conversationId: 'test-group', eventLabel: 'GitHub Comment Mention' } } })
  expect(githubSent).toHaveLength(0)
  expect(h.runtime.store.tickets.get(id)!.ended).toBeUndefined()
  const update = comment(2, 'Please fix this edge case', 'guest')
  await source.receive(update); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(id)!.inputs.some(input => input.kind === 'trigger' && input.triggerId === update.id)).toBe(true)
  expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'github_event' && item.trigger_id === update.id))
    .toMatchObject([{ delivered_to: [id] }])
  expect(h.runtime.store.tickets.open()).toHaveLength(1)
  expect(h.candidates()).toHaveLength(1)
  await h.runTool(`worker-${id}`, 'orchestrator_report', { state: 'blocked', summary: 'Need the failing input to reproduce' })
  await h.runtime.idle()
  expect(sent).toHaveLength(2)
  expect(h.relays(h.runtime.masterId).some(item => item.kind === 'worker_report' && item.summary === 'Need the failing input to reproduce')).toBe(true)
})

it('uses text replies with task and event labels when cards are disabled and no session webhook exists', async () => {
  h = await startRuntime()
  const kind = dingTalkKind(async () => {})
  h.runtime.sources.register(kind)
  const http = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'token', expireIn: 7200 })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ processQueryKey: 'sent' })))
  const robot = new DingTalk(h.runtime.context(kind), { clientId: 'robot-code', clientSecret: 'secret' }, () => {}, http)
  await robot.send({ id: 'notice', ticketId: '77fb51f5cabc0000', kind: 'notice', text: 'Done',
    channel: { source: 'dingtalk', thread: 'dingtalk:test-group', address: { conversationId: 'test-group', eventLabel: 'GitHub Issue Assign' } } })
  expect(http.mock.calls[1]![0]).toBe('https://api.dingtalk.com/v1.0/robot/groupMessages/send')
  const payload = JSON.parse(http.mock.calls[1]![1]!.body as string)
  expect(payload).toMatchObject({ robotCode: 'robot-code', openConversationId: 'test-group' })
  expect(JSON.parse(payload.msgParam).content).toBe('#77fb51f5cabc · GitHub Issue Assign\nDone')
})

it('uses the existing receipt, acknowledgement and result card for a GitHub review request', async () => {
  let robot: DingTalk | undefined
  h = await startRuntime(undefined, 'test-group', trigger => robot!.received(trigger))
  const kind = dingTalkKind(message => robot!.send(message))
  h.runtime.sources.register(kind)
  const githubSent: OutboundMessage[] = []
  const send = h.runtime.sources.send.bind(h.runtime.sources)
  vi.spyOn(h.runtime.sources, 'send').mockImplementation(async (message, commands) => {
    if (message.channel.source === 'github') { githubSent.push(message); return 'sent' }
    return send(message, commands)
  })
  const http = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).includes('/oauth2/')
    ? { accessToken: 'token', expireIn: 7200 } : {})))
  robot = new DingTalk(h.runtime.context(kind), { clientId: 'robot-code', clientSecret: 'secret' }, () => {}, http, 'card-template')
  vi.spyOn(Commands.prototype, 'pages').mockResolvedValue([{ id: 77, event: 'review_requested',
    created_at: new Date().toISOString(), actor: { login: 'alice', type: 'User' }, requested_reviewer: { login: 'agent-bot' } }])
  const source = h.runtime.context(githubKind)
  const poll = () => pollRequests(source, 7, true, '2000-01-01T00:00:00Z', 'Fix PR', 'Please review')
  await poll(); await h.runtime.idle()
  const bodies = () => http.mock.calls.filter(([url]) => String(url).includes('/card/instances'))
    .map(([, init]) => JSON.parse(init!.body as string))
  expect(bodies()).toHaveLength(1)
  expect(githubSent).toHaveLength(0)
  expect(bodies()[0]).toMatchObject({ openSpaceId: 'dtv1.card//IM_GROUP.test-group',
    cardData: { cardParamMap: { flowStatus: '1', status: '处理中' } } })
  await poll(); await h.runtime.idle()
  expect(bodies()).toHaveLength(1)
  const routed = await h.route({ kind: 'accept', trigger_id: key('github-request', '77'), title: 'Review PR',
    worktree_name: 'review-pr', acknowledgement: 'Reviewing PR 7.' })
  const id = (routed.ticket as { ticket_id: string }).ticket_id
  await h.runtime.idle()
  expect(bodies()[1]).toMatchObject({ outTrackId: bodies()[0].outTrackId,
    cardData: { cardParamMap: { flowStatus: '2', status: '输出中' } } })
  expect(bodies()[1].cardData.cardParamMap.markdown).toContain(`#${id.slice(0, 12)} · GitHub PR Review Request`)
  expect(githubSent).toHaveLength(0)
  expect(h.runtime.store.triggers.get(key('github-request', '77'))).toMatchObject({ source: 'github',
    url: 'https://github.com/acme/widgets/pull/7', meta: { number: 7, isPr: true, kind: 'review_request' },
    channel: { source: 'dingtalk', address: { conversationId: 'test-group' } } })
  await h.runTool(`worker-${id}`, 'orchestrator_report', { state: 'ready', summary: 'Review complete.' })
  await h.runtime.idle()
  expect(bodies()).toHaveLength(2)
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: id, purpose: 'result', text: 'Review complete.' })
  await h.runtime.idle()
  expect(bodies()).toHaveLength(3)
  expect(githubSent).toHaveLength(0)
  expect(bodies()[2]).toMatchObject({ outTrackId: bodies()[0].outTrackId,
    cardData: { cardParamMap: { flowStatus: '3', status: '完成' } } })
  expect(bodies()[2].cardData.cardParamMap.markdown).toContain('Reviewing PR 7.\n\n---\n\nReview complete.')
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: id, purpose: 'result', text: 'Review complete.' })
  await h.runtime.idle()
  expect(bodies()).toHaveLength(3)
  expect(githubSent).toHaveLength(0)
  expect(http.mock.calls.filter(([url]) => String(url).includes('groupMessages/send'))).toHaveLength(0)
})
