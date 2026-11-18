import { readFileSync, existsSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { Projects, ProjectInput, ProjectChange } from '../src/app/projects.ts'
import { deliveryReady } from '../src/app/events/delivery-ready.ts'
import { dingTalkKind, dingTalkRoute } from '../src/sources/dingtalk.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })

async function pilot(group: string | null = 'project-group') {
  const h = host = await startRuntime()
  const send = vi.fn(async () => {})
  h.runtime.sources.register(dingTalkKind(send))
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, dingtalk: { enabled: true, config: {} } },
    policy: { ...settings.policy, sources: { ...settings.policy.sources, request: { allowed: [{ id: 'local' }] } } } })
  const projects = new Projects(h.runtime.store)
  const { id } = projects.create(ProjectInput.parse({ name: 'Delivery event pilot', status: 'active', dingTalkGroup: group, autoAdvance: false }))
  const change = (change: ProjectChange['change']) => projects.change(id, ProjectChange.parse({ revision: projects.detail(id).revision, change }))
  change({ kind: 'new-member', value: { name: 'Reviewer', accounts: [{ provider: 'dingtalk', scope: 'corp', accountId: 'reviewer' }] } })
  const reviewer = projects.detail(id).members[0]!
  change({ kind: 'task', value: { title: 'Inspect results', ownerId: reviewer.id, acceptance: 'Provide results', executionMode: 'agent' } })
  const taskId = projects.detail(id).tasks[0]!.id
  if (group) h.runtime.store.set(dingTalkRoute(group), { conversationId: group, corpId: 'corp', expires: 0,
    webhook: 'https://oapi.dingtalk.com/robot/send', robotCode: 'robot' })
  const response = await h.api('POST', `projects/${id}/tasks/${taskId}/run`, { revision: projects.detail(id).revision })
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  const ticketId = projects.detail(id).tasks[0]!.ticketId!
  await h.runtime.idle()
  const report = () => h.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'ready', summary: 'Results and evidence are ready' })
  return { h, id, taskId, ticketId, projects, change, send, report }
}

it('uses the real worker completion event to transition and notify once without a periodic project scan', async () => {
  const { h, id, projects, report, send, ticketId } = await pilot()
  await report(); await h.runtime.idle()
  expect(projects.detail(id).tasks[0]?.status).toBe('in-review')
  expect(h.runtime.projectEvents.list({ projectId: id }).filter(event => event.type === 'delivery.ready')).toMatchObject([
    { type: 'delivery.ready', source: 'execution', status: 'applied', data: { ticketId } },
  ])
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: expect.stringContaining('待验收'),
    channel: expect.objectContaining({ address: { conversationId: 'project-group', mentionUserId: 'reviewer' } }) }))
  h.runtime.deliveryReady.observe(ticketId)
  await h.runtime.idle()
  expect(send).toHaveBeenCalledOnce()
})

it('ignores a queued completion after the task moved to a newer execution', async () => {
  const { h, id, projects, report, send, taskId, change } = await pilot()
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  await report()
  await new Promise(resolve => setTimeout(resolve, 5))
  change({ kind: 'task-status', id: taskId, status: 'todo' })
  change({ kind: 'task-status', id: taskId, status: 'in-progress' })
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: false })
  await h.runtime.idle()
  expect(projects.detail(id).tasks[0]?.status).toBe('in-progress')
  expect(send).not.toHaveBeenCalled()
  expect(h.runtime.projectEvents.list({ projectId: id }).find(event => event.type === 'delivery.ready')).toMatchObject({ status: 'ignored', reason: 'Report belongs to an earlier execution' })
})

it('honors an event JSON override and preserves an auditable ignored result', async () => {
  const { h, id, projects, report, send } = await pilot()
  expect(await h.api('PUT', 'projects/workflow', { revision: 0, config: { on: { 'delivery.ready': false } } })).toMatchObject({ status: 200 })
  await report(); await h.runtime.idle()
  expect(projects.detail(id).tasks[0]?.status).toBe('in-progress')
  expect(h.runtime.projectEvents.list({ projectId: id })[0]).toMatchObject({ status: 'ignored', reason: expect.stringContaining('Disabled') })
  expect(send).not.toHaveBeenCalled()
})

it('applies the delivery without a DingTalk group and retains the successful execution evidence', async () => {
  const { h, id, projects, report, send } = await pilot(null)
  await report(); await h.runtime.idle()
  expect(projects.detail(id)).toMatchObject({ tasks: [{ status: 'in-review' }], tickets: [{ reportState: 'ready', ended: true }] })
  expect(h.runtime.projectEvents.list({ projectId: id })[0]?.status).toBe('applied')
  expect(send).not.toHaveBeenCalled()
})

it('backfills a legacy completed ticket at recovery and reuses its previous notification receipt', async () => {
  const { h, id, projects, report, send } = await pilot()
  await report(); await h.runtime.idle()
  const legacy = h.runtime.store.get(KV.projects.project(id))!
  legacy.tasks[0]!.status = 'in-progress'
  delete legacy.tasks[0]!.executionStartedAt
  delete legacy.tasks[0]!.reviews
  delete legacy.tasks[0]!.deliveryVersion
  h.runtime.store.set(KV.projects.project(id), legacy)
  h.runtime.store.db.prepare('DELETE FROM project_event').run()
  h.runtime.deliveryReady.recover()
  await h.runtime.idle()
  expect(projects.detail(id).tasks[0]?.status).toBe('in-review')
  expect(send).toHaveBeenCalledOnce()
  expect(h.runtime.projectEvents.list({ projectId: id }).find(event => event.type === 'delivery.ready')?.status).toBe('applied')
})

it('ships the delivery event with matching default JSON and configuration documentation', () => {
  const config = JSON.parse(readFileSync(new URL('../config/events/delivery-ready.defaults.json', import.meta.url), 'utf8'))
  expect(config).toEqual({ on: { 'delivery.ready': deliveryReady.defaults.enabled } })
  expect(existsSync(new URL(`../${deliveryReady.documentation}`, import.meta.url))).toBe(true)
})
