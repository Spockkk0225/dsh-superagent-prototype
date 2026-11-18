import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import type { OutboundMessage } from '../src/core/index.ts'
import { Projects, ProjectInput, ProjectChange } from '../src/app/projects.ts'
import { taskBlocked } from '../src/app/events/task-blocked.ts'
import { dingTalkKind, dingTalkRoute } from '../src/sources/dingtalk.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })
async function pilot(group: string | null = 'project-group') {
  const h = host = await startRuntime()
  const send = vi.fn(async (_message: OutboundMessage) => {})
  h.runtime.sources.register(dingTalkKind(send))
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, dingtalk: { enabled: true, config: {} } },
    policy: { ...settings.policy, sources: { ...settings.policy.sources, request: { allowed: [{ id: 'local' }] } } } })
  const projects = new Projects(h.runtime.store)
  const { id } = projects.create(ProjectInput.parse({ name: 'Blocker pilot', status: 'active', dingTalkGroup: group, autoAdvance: false }))
  const change = (change: ProjectChange['change']) => projects.change(id, ProjectChange.parse({ revision: projects.detail(id).revision, change }))
  change({ kind: 'new-member', value: { name: 'Owner', accounts: [{ provider: 'dingtalk', scope: 'corp', accountId: 'owner' }] } })
  const owner = projects.detail(id).members[0]!
  const task = change({ kind: 'task', value: { title: 'Implement a game', ownerId: owner.id, acceptance: 'Playable result', executionMode: 'agent' } }).tasks[0]!
  if (group) h.runtime.store.set(dingTalkRoute(group), { conversationId: group, corpId: 'corp', expires: 0, webhook: 'https://oapi.dingtalk.com/robot/send', robotCode: 'robot' })
  expect(await h.api('POST', `projects/${id}/tasks/${task.id}/run`, { revision: projects.detail(id).revision })).toMatchObject({ status: 200 })
  await h.runtime.idle()
  const ticketId = projects.detail(id).tasks[0]!.ticketId!
  const report = (state: 'blocked' | 'progress' | 'ready' = 'blocked', summary = 'Cannot create files in a read-only workspace', question: string | null | false = '请为当前任务提供可写的工作目录。') =>
    h.runTool(`worker-${ticketId}`, 'orchestrator_report', { state, summary, ...(question === false ? {} : { human_action: question }) })
  const pause = (paused: boolean) => h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused })
  const sourceEnabled = (enabled: boolean) => {
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, dingtalk: { enabled, config: {} } } })
  }
  const events = () => h.runtime.projectEvents.list({ projectId: id }).filter(event => event.type === 'task.blocked')
  return { h, projects, id, task, ticketId, change, report, send, pause, sourceEnabled, events }
}
it('routes a real local worker blocker to its project group with the actual member mention', async () => {
  const { h, projects, id, ticketId, report, send, events } = await pilot()
  expect(h.runtime.store.tickets.get(ticketId)?.channels[0]?.source).toBe('request')
  await report(); await h.runtime.idle()
  expect(events()).toMatchObject([{ source: 'execution', status: 'applied', data: { ticketId, assignmentId: expect.any(String) } }])
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'notice', text: expect.stringContaining('正在等待人工回答'),
    channel: expect.objectContaining({ source: 'dingtalk', address: { conversationId: 'project-group', mentionUserId: 'owner' } }) }))
  expect(send.mock.calls[0]?.[0]).toMatchObject({ text: expect.stringContaining('可写的工作目录') })
  expect(projects.detail(id).tasks[0]).toMatchObject({ status: 'in-progress' })
  expect(h.runtime.store.tickets.get(ticketId)?.ended).toBeUndefined()
})
it('notifies a question asked with a progress report as well as an explicit blocked report', async () => {
  const { h, report, send, ticketId } = await pilot()
  await report('progress', 'Need a product decision', '键盘布局需要支持 WASD 吗？'); await h.runtime.idle()
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: expect.stringContaining('WASD') }))
})
it('notifies an explicit blocker without requiring a human_action field', async () => {
  const { h, report, send, ticketId } = await pilot()
  await report('blocked', 'Repository credentials are unavailable', false); await h.runtime.idle()
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: expect.stringContaining('执行受阻') }))
  expect(h.runtime.store.tickets.get(ticketId)?.assignments.at(-1)?.report?.summary).toBe('Repository credentials are unavailable')
})
it('coalesces repeated reports and restart recovery about the same pending question', async () => {
  const { h, report, send } = await pilot()
  await report(); await h.runtime.idle()
  await report('blocked', 'More details about the same problem'); await h.runtime.idle()
  h.runtime.taskBlocked.recover(); h.runtime.taskBlocked.recover(); await h.runtime.idle()
  expect(send).toHaveBeenCalledOnce()
})
it('notifies a replacement question and a new episode after the prior problem clears', async () => {
  const { h, report, send } = await pilot()
  await report(); await h.runtime.idle()
  await report('blocked', 'Different problem', '请确认产品标题。'); await h.runtime.idle()
  expect(send).toHaveBeenCalledTimes(2)
  await report('progress', 'The question was answered', null); await h.runtime.idle()
  await new Promise(resolve => setTimeout(resolve, 2))
  await report('blocked', 'Question again', '请确认产品标题。'); await h.runtime.idle()
  expect(send).toHaveBeenCalledTimes(3)
})
it('coalesces identical blockers without a question until work actually progresses', async () => {
  const { h, report, send } = await pilot()
  await report('blocked', 'Cannot read input file', false); await h.runtime.idle()
  await report('blocked', 'Cannot read input file', false); await h.runtime.idle()
  expect(send).toHaveBeenCalledOnce()
  await report('progress', 'Input became available', null); await h.runtime.idle()
  await new Promise(resolve => setTimeout(resolve, 2))
  await report('blocked', 'Cannot read input file', false); await h.runtime.idle()
  expect(send).toHaveBeenCalledTimes(2)
})
it('ignores a queued blocker already answered before event consumption', async () => {
  const { h, report, send, pause, events } = await pilot()
  pause(true); await report(); await report('progress', 'Now working', null)
  pause(false); await h.runtime.idle()
  expect(events()[0]).toMatchObject({ status: 'ignored', reason: expect.stringContaining('no longer current') })
  expect(send).not.toHaveBeenCalled()
})
it('withdraws an unsent project reminder when the question clears', async () => {
  const { h, report, send, sourceEnabled, events } = await pilot()
  sourceEnabled(false); await report(); await h.runtime.idle()
  const noticeId = (events()[0]!.data as { noticeId: string }).noticeId
  expect(h.runtime.store.replyStatus(noticeId)).toBe('pending')
  await report('progress', 'Question resolved', null); await h.runtime.idle()
  expect(h.runtime.store.replyStatus(noticeId)).toBeUndefined()
  expect(h.runtime.effects.pending('reply', noticeId)).toBe(false)
  sourceEnabled(true); await h.runtime.idle()
  expect(send).not.toHaveBeenCalled()
})
it('withdraws an unsent project reminder when the ticket stops', async () => {
  const { h, ticketId, report, send, sourceEnabled, events } = await pilot()
  sourceEnabled(false); await report(); await h.runtime.idle()
  const noticeId = (events()[0]!.data as { noticeId: string }).noticeId
  h.runtime.engine.stopTicket(ticketId); await h.runtime.idle()
  expect(h.runtime.store.replyStatus(noticeId)).toBeUndefined()
  sourceEnabled(true); await h.runtime.idle()
  expect(send).not.toHaveBeenCalled()
})
it('honors the JSON default override independently from delivery.ready', async () => {
  const { h, report, send, events } = await pilot()
  expect(await h.api('PUT', 'projects/workflow', { revision: 0, config: { on: { 'task.blocked': false } } })).toMatchObject({ status: 200 })
  await report(); await h.runtime.idle()
  expect(events()[0]).toMatchObject({ status: 'ignored', reason: expect.stringContaining('Disabled') })
  expect(send).not.toHaveBeenCalled()
  expect(await h.api('PUT', 'projects/workflow', { revision: 1, config: { on: { 'task.blocked': 'Do something automatically' } } })).toMatchObject({ status: 200 })
})
it('does not route a stale event after cancellation or ticket reassociation', async () => {
  const { h, task, change, report, pause, send, events } = await pilot()
  pause(true); await report()
  change({ kind: 'task-status', id: task.id, status: 'cancelled' })
  pause(false); await h.runtime.idle()
  expect(events()[0]?.status).toBe('ignored')
  expect(send).not.toHaveBeenCalled()
})
it('retains blocker evidence without inventing a destination for a project with no group', async () => {
  const { h, report, send, events, ticketId } = await pilot(null)
  await report(); await h.runtime.idle()
  expect(events()[0]?.status).toBe('applied')
  expect(h.runtime.store.tickets.get(ticketId)?.attention?.question).toContain('可写')
  expect(send).not.toHaveBeenCalled()
})
it('rolls back the worker report, blocker event and episode bookkeeping together', async () => {
  const { h, ticketId, events, send } = await pilot()
  expect(() => h.runtime.store.atomic(() => {
    h.runtime.engine.report(ticketId, { state: 'blocked', summary: 'An uncommitted blocker', question: 'Need a decision' })
    throw new Error('transaction rejected')
  })).toThrow('transaction rejected')
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticketId)?.assignments.at(-1)?.report).toBeUndefined()
  expect(events()).toEqual([])
  expect(h.runtime.store.keys(KV.projects.blockage)).toEqual([])
  expect(send).not.toHaveBeenCalled()
})
it('backfills the pre-upgrade blocked ticket through the same event producer', async () => {
  const { h, ticketId, report, events, send } = await pilot()
  // Simulate a report persisted by the earlier version before ticket.reported was a source event.
  const observe = vi.spyOn(h.runtime.taskBlocked, 'observe').mockImplementation(() => {})
  await report(); await h.runtime.idle(); observe.mockRestore()
  expect(events()).toEqual([])
  h.runtime.taskBlocked.recover(); await h.runtime.idle()
  expect(events()).toMatchObject([{ status: 'applied', data: { ticketId } }])
  expect(send).toHaveBeenCalledOnce()
  h.runtime.taskBlocked.recover(); await h.runtime.idle()
  expect(send).toHaveBeenCalledOnce()
})
it('preserves its stable receipt and active problem across a full runtime restart', async () => {
  const { h, id, ticketId, report, projects, events, send } = await pilot()
  await report(); await h.runtime.idle()
  expect(send).toHaveBeenCalledOnce()
  const project = h.runtime.store.get(KV.projects.project(id))!
  const members = projects.members()
  const ticket = h.runtime.store.tickets.get(ticketId)!
  ticket.assignments.at(-1)!.deliveredAt = new Date(Date.parse(ticket.assignments.at(-1)!.report!.at) - 1000).toISOString()
  const trigger = h.runtime.store.triggers.get(ticket.origin.triggerId)!
  const states = h.runtime.store.keys(KV.projects.blockage).map(key => [key, h.runtime.store.get(key)!] as const)
  const previousEvent = events()[0]!
  const noticeId = (previousEvent.data as { noticeId: string }).noticeId
  const receipt = h.runtime.store.receipts.get(noticeId)!
  expect(receipt.status).toBe('sent')
  const rows = h.runtime.store.db.prepare('SELECT * FROM project_event ORDER BY seq').all()
  await h.stop(); host = undefined
  const resumed = host = await startRuntime(store => {
    store.set(KV.projects.project(id), project)
    for (const member of members) store.set(KV.projects.member(member.id), member)
    store.triggers.save(trigger); store.tickets.save(ticket)
    for (const [key, value] of states) store.set(key, value)
    store.db.prepare('INSERT INTO outbox(id,value) VALUES(?,?)').run(noticeId, JSON.stringify(receipt))
    for (const row of rows) store.db.prepare('INSERT INTO project_event(id,value,recorded_at,status,reason) VALUES(?,?,?,?,?)')
      .run(row.id!, row.value!, row.recorded_at!, row.status!, row.reason!)
  })
  await resumed.runtime.idle()
  expect(resumed.runtime.projectEvents.list({ projectId: id }).filter(event => event.type === 'task.blocked')).toMatchObject([{ id: previousEvent.id, status: 'applied' }])
  expect(resumed.runtime.store.get(states[0]![0])?.noticeId).toBe(states[0]![1].noticeId)
  expect(resumed.runtime.store.replyStatus(noticeId)).toBe('sent')
  expect(resumed.runtime.effects.pending('reply', noticeId)).toBe(false)
})
it('ships the event default and configuration documentation', () => {
  const config = JSON.parse(readFileSync(new URL('../config/events/task-blocked.defaults.json', import.meta.url), 'utf8'))
  expect(config).toEqual({ on: { 'task.blocked': taskBlocked.defaults.enabled } })
  expect(readFileSync(new URL(`../${taskBlocked.documentation}`, import.meta.url), 'utf8')).toContain('task.blocked')
})
