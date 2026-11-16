import { afterEach, expect, it, vi } from 'vitest'
import { startRuntime } from './fixtures/host.ts'
import { dingTalkKind, DingTalk } from '../src/sources/dingtalk.ts'

let h: Awaited<ReturnType<typeof startRuntime>> | undefined
afterEach(async () => { await h?.stop(); h = undefined; vi.restoreAllMocks() })

it('routes local requests like mentions and requires confirmation and a terminal reply on the default group card', async () => {
  let robot: DingTalk
  h = await startRuntime(undefined, 'test-group', trigger => robot.received(trigger),
    (...args) => robot.bindWorkerDelivery(...args))
  const group = dingTalkKind(message => robot.send(message))
  h.runtime.sources.register(group)
  const policy = h.runtime.store.settings().policy
  await h.runtime.settings.save('policy', { ...policy, sources: { ...policy.sources,
    request: { allowed: [{ id: 'local' }] } } }, h.runtime.store.blockRevision('policy'), 'panel')
  const http = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).includes('/oauth2/')
    ? { accessToken: 'token', expireIn: 7200 } : {})))
  robot = new DingTalk(h.runtime.context(group), { clientId: 'robot', clientSecret: 'test' }, () => {}, http, 'card-template')
  const response = await h.api('POST', 'requests', { prompt: 'Check whether CI needs attention' })
  expect(response.status).toBe(200)
  const id = String(response.body.trigger_id)
  await h.runtime.idle()
  expect(h.candidates()).toContain(id)
  expect(h.runtime.store.triggers.get(id)).toMatchObject({ source: 'request', text: 'Check whether CI needs attention',
    channel: { source: 'dingtalk', address: { conversationId: 'test-group' } } })
  const listed = await h.runTool(h.runtime.masterId, 'orchestrator_card_reply', { action: 'list' })
  expect(listed.cards).toEqual([expect.objectContaining({ trigger_id: id })])
  const card = (listed.cards as { card_id: string }[])[0]!.card_id
  await h.runTool(h.runtime.masterId, 'orchestrator_card_reply', { action: 'acknowledge', card_id: card, text: 'Checking CI.' })
  await h.route({ kind: 'ignore', trigger_id: id, reason: 'No action is needed.' })
  expect((await h.runTool(h.runtime.masterId, 'orchestrator_card_reply', { action: 'list' })).cards).toHaveLength(1)
  await h.runTool(h.runtime.masterId, 'orchestrator_card_reply', { action: 'reply', card_id: card, text: 'CI needs no action.' })
  expect((await h.runTool(h.runtime.masterId, 'orchestrator_card_reply', { action: 'list' })).cards).toEqual([])
  const next = await h.api('POST', 'requests', { prompt: 'Investigate the CI failure' })
  const nextId = String(next.body.trigger_id)
  expect(nextId).not.toBe(id)
  await h.runtime.idle()
  const accepted = await h.route({ kind: 'accept', trigger_id: nextId, title: 'Investigate CI',
    worktree_name: 'investigate-ci', acknowledgement: 'Investigating CI.' })
  const ticketId = (accepted.ticket as { ticket_id: string }).ticket_id
  await h.runtime.idle()
  const workerCards = await h.runTool(`worker-${ticketId}`, 'orchestrator_card_reply', { action: 'list' })
  expect(workerCards.cards).toEqual([expect.objectContaining({ trigger_id: nextId, ticket_id: ticketId })])
  expect(h.relays(`worker-${ticketId}`)).toContainEqual(expect.objectContaining({
    reply_card: expect.objectContaining({ ticket_id: ticketId }) }))
  expect(http.mock.calls.some(([url]) => String(url).includes('/card/instances'))).toBe(true)
})

it('rejects local requests when the default output is missing', async () => {
  h = await startRuntime()
  expect(await h.api('POST', 'requests', { prompt: 'Check CI' })).toEqual({ status: 500,
    body: { error: 'Default DingTalk output is not configured or enabled' } })
})
