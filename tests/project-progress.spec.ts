import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { ProjectEvents } from '../src/app/project-events.ts'
import { ProjectProgress, taskReady, checkDue } from '../src/app/project-progress.ts'
import { ProjectInput, ProjectChange, Projects, TaskInput } from '../src/app/projects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { deferred } from './fixtures/async.ts'
import type { ProjectEvent } from '../src/sources/project-events.ts'

let host: Host | undefined
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await host?.stop(); host = undefined; await cleanup?.(); cleanup = undefined; vi.useRealTimers() })
const done = (reply = '') => ({ calls: [], reply })
const call = (tool: string, args: unknown) => ({ tool, arguments: JSON.stringify(args) })
const input = (prompt: string) => JSON.parse(prompt.split('\n\n').at(-1)!)
async function pilot() {
  const propose = vi.fn(async (_prompt: string): Promise<unknown> => done())
  const h = host = await startRuntime(undefined, undefined, undefined, undefined, undefined, { name: 'Event Agent', propose })
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy,
    sources: { ...settings.policy.sources, request: { allowed: [{ id: 'local' }] } } } })
  const projects = new Projects(h.runtime.store)
  const { id } = projects.create(ProjectInput.parse({ name: '2048', status: 'planning', autoAdvance: true }))
  const change = (change: ProjectChange['change']) => projects.change(id, ProjectChange.parse({ revision: projects.detail(id).revision, change }))
  const task = change({ kind: 'task', value: { title: '2048 MVP', acceptance: '可运行并有测试', executionMode: 'agent' } }).tasks[0]!
  const activate = () => change({ kind: 'project', value: { name: '2048', status: 'active', autoAdvance: true } })
  const ready = () => h.runtime.projectEvents.list({ projectId: id }).filter(event => event.type === taskReady.type)
  return { h, projects, id, change, task, activate, propose, ready }
}

it('wakes the existing Agent tool loop from readiness and registers only one ticket across repeated passes', async () => {
  const { h, projects, id, task, activate, propose, ready } = await pilot()
  propose.mockImplementation(async prompt => {
    const context = input(prompt)
    if (context.previousSteps.length) return done('已登记执行，等待实际交付。')
    expect(context.message.actorId).toBeNull()
    expect(context.tools.map((tool: { name: string }) => tool.name)).not.toContain('review.decide')
    expect(prompt).toContain('系统事实唤起')
    return { calls: [call('task.start', { taskId: task.id })], reply: '' }
  })
  activate(); await h.runtime.idle()
  expect(projects.detail(id).tasks[0]).toMatchObject({ status: 'in-progress', ticketId: expect.any(String) })
  expect(h.runtime.projectAgent!.runs(id)[0]).toMatchObject({ status: 'completed', event: { type: taskReady.type }, reply: '已登记执行，等待实际交付。' })
  for (let i = 0; i < 3; i++) { await h.runtime.pump(); await h.runtime.idle() }
  expect(projects.detail(id).tickets).toHaveLength(1)
  expect(ready()).toHaveLength(1)
  expect(propose).toHaveBeenCalledTimes(2)
})

it('lets AI choose a question instead of hardwiring readiness to automatic dispatch', async () => {
  const { h, projects, id, activate, propose } = await pilot()
  propose.mockResolvedValue(done('目标平台未确定，请确认浏览器范围。'))
  activate(); await h.runtime.idle()
  expect(projects.detail(id).tickets).toEqual([])
  expect(h.runtime.projectAgent!.runs(id)[0]?.reply).toContain('浏览器范围')
})

it('revokes a proposal when the project pauses while the Agent is thinking', async () => {
  const { h, projects, id, task, activate, change, propose } = await pilot()
  const pending = deferred<unknown>()
  propose.mockImplementationOnce(() => pending.promise)
  activate(); await vi.waitFor(() => expect(propose).toHaveBeenCalledOnce())
  change({ kind: 'project', value: { name: '2048', status: 'paused' } })
  pending.resolve({ calls: [call('task.start', { taskId: task.id })], reply: '' })
  await h.runtime.idle()
  expect(projects.detail(id).tickets).toEqual([])
  expect(h.runtime.projectAgent!.runs(id)[0]?.status).toBe('failed')
})

it('rejects system proposals to accept delivery, change objectives or act on another task', async () => {
  const { h, projects, id, task, activate, change, propose } = await pilot()
  const other = change({ kind: 'task', value: { title: 'Other', blockedBy: [task.id] } }).tasks[1]!
  propose.mockResolvedValueOnce({ calls: [call('task.start', { taskId: other.id }), call('project.update', { objective: 'Injected objective' })], reply: '' })
    .mockResolvedValueOnce(done())
  activate(); await h.runtime.idle()
  expect(projects.detail(id)).toMatchObject({ objective: '', tickets: [] })
  expect(h.runtime.projectAgent!.runs(id)[0]?.steps[0]?.error).toContain('limited to the event task')
})

it('reacts to a current blocker through the same Agent and continues the original ticket', async () => {
  const { h, projects, id, task, activate, propose } = await pilot()
  propose.mockResolvedValueOnce({ calls: [call('task.start', { taskId: task.id })], reply: '' }).mockResolvedValueOnce(done('已登记执行。'))
  activate(); await h.runtime.idle()
  const ticketId = projects.detail(id).tasks[0]!.ticketId!
  propose.mockImplementation(async prompt => {
    const context = input(prompt)
    if (context.previousSteps.length) return done('已将上下文交给原工单。')
    expect(context.message.text).toContain('task.blocked')
    return { calls: [call('task.follow_up', { taskId: task.id, text: '已有验收条件明确仅支持桌面浏览器，请继续原任务。' })], reply: '' }
  })
  await h.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'blocked', summary: '需要确认是否支持移动端', human_action: '需要支持移动端吗？' })
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.get(ticketId)!
  expect(projects.detail(id).tickets).toHaveLength(1)
  expect(ticket.inputs.some(item => item.kind === 'trigger' && h.runtime.store.triggers.get(item.triggerId)?.text.includes('已有验收条件'))).toBe(true)
  expect(h.runtime.projectAgent!.runs(id).some(run => run.event?.type === 'task.blocked' && run.steps.some(step => step.calls[0]?.tool === 'task.follow_up'))).toBe(true)
})

it('advances B from the actual acceptance event without a new chat instruction', async () => {
  const { h, projects, id, task, activate, change, propose } = await pilot()
  const a = change({ kind: 'task', value: { title: '规则与测试清单', executionMode: 'manual' } }).tasks[1]!
  change({ kind: 'task', id: task.id, value: { ...TaskInput.strip().parse(task), blockedBy: [a.id] } })
  propose.mockImplementation(async prompt => {
    const context = input(prompt)
    const event = JSON.parse(context.message.text)
    return event.taskId === task.id && !context.previousSteps.length
      ? { calls: [call('task.start', { taskId: task.id })], reply: '' } : done(context.previousSteps.length ? '已登记 B 执行。' : '')
  })
  activate(); await h.runtime.idle()
  expect(projects.detail(id).tickets).toHaveLength(0)
  expect(await h.api('POST', `projects/${id}/tasks/${a.id}/deliveries`, { messageId: 'delivery-a', summary: '规则与测试证据完整' })).toMatchObject({ status: 200 })
  await h.runtime.idle()
  expect(projects.detail(id).tickets).toHaveLength(0)
  const review = projects.detail(id).tasks.find(item => item.id === a.id)!.reviews!.at(-1)!
  expect(await h.api('POST', `projects/${id}/tasks/${a.id}/reviews/${review.id}`, { messageId: 'accept-a', outcome: 'accepted', reason: '逐项核验通过' })).toMatchObject({ status: 200 })
  await h.runtime.idle()
  expect(projects.detail(id).tasks[0]).toMatchObject({ id: task.id, status: 'in-progress' })
  expect(projects.detail(id).tickets).toHaveLength(1)
  expect(h.runtime.projectEvents.list({ projectId: id }).some(event => event.type === 'review.accepted' && event.status === 'applied')).toBe(true)
})

it('does not wake another Agent round for repeated reports about one blocked episode', async () => {
  const { h, projects, id, task, activate, propose } = await pilot()
  propose.mockResolvedValueOnce({ calls: [call('task.start', { taskId: task.id })], reply: '' }).mockResolvedValueOnce(done('已登记执行。'))
  activate(); await h.runtime.idle()
  const ticketId = projects.detail(id).tasks[0]!.ticketId!
  propose.mockResolvedValue(done())
  for (let i = 0; i < 2; i++) {
    await h.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'blocked', summary: '同一环境条件仍不满足', human_action: '需要本机管理者处理' })
    await h.runtime.idle()
  }
  expect(h.runtime.projectAgent!.runs(id).filter(run => run.event?.type === 'task.blocked')).toHaveLength(1)
})

it('allows a blocker reaction to remain silent without dispatch or reminder spam', async () => {
  const { h, projects, id, task, activate, propose } = await pilot()
  propose.mockResolvedValueOnce({ calls: [call('task.start', { taskId: task.id })], reply: '' }).mockResolvedValueOnce(done('已登记执行。'))
  activate(); await h.runtime.idle()
  const ticketId = projects.detail(id).tasks[0]!.ticketId!
  propose.mockResolvedValue(done())
  await h.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'blocked', summary: '等待本机操作', human_action: '请本机管理员配置环境' })
  await h.runtime.idle()
  const run = h.runtime.projectAgent!.runs(id).find(run => run.event?.type === 'task.blocked')!
  expect(run).toMatchObject({ status: 'completed', reply: '', steps: [] })
  expect(projects.detail(id).tickets).toHaveLength(1)
})

async function clockPilot() {
  const directory = mkdtempSync(join(tmpdir(), 'project-checks-'))
  const store = new Store(join(directory, 'state.sqlite'))
  const effects = new Effects(store, new HealthBoard())
  const events = new ProjectEvents(store, effects)
  const controller = new AbortController()
  let now = Date.parse('2026-11-18T04:00:00Z')
  const react = vi.fn((_event: ProjectEvent) => {})
  const progress = new ProjectProgress({ store, events, agent: { react } , lifetime: controller.signal, now: () => now })
  const projects = new Projects(store)
  const { id } = projects.create(ProjectInput.parse({ name: 'Clock', status: 'active', autoAdvance: true }))
  const change = (change: ProjectChange['change']) => projects.change(id, ProjectChange.parse({ revision: projects.detail(id).revision, change }))
  const task = change({ kind: 'task', value: { title: '人工检查', executionMode: 'manual' } }).tasks[0]!
  effects.start(); await effects.idle(); react.mockClear()
  cleanup = async () => { controller.abort(); await effects.drain(); store.close(); rmSync(directory, { recursive: true, force: true }) }
  return { directory, store, effects, events, progress, projects, id, task, change, react, controller,
    advance: () => { now += 120_000 }, at: '2026-11-18T04:02:00Z' }
}

it('wakes on the scheduled timer rather than project passes, once per appointment', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { progress, effects, id, task, react, advance, at } = await clockPilot()
  progress.schedule(id, task.id, at, '检查是否已完成试玩', 'operation')
  expect(react).not.toHaveBeenCalled()
  advance(); await vi.advanceTimersByTimeAsync(120_000); await effects.idle()
  expect(react).toHaveBeenCalledOnce()
  expect(react.mock.calls[0]?.[0]).toMatchObject({ source: 'clock', type: checkDue.type, data: { reason: '检查是否已完成试玩' } })
  progress.recover(); await effects.idle()
  expect(react).toHaveBeenCalledOnce()
})

it('recovers an overdue appointment after reconstructing the scheduler', async () => {
  const { directory, store, effects, progress, controller, id, task, react, advance, at } = await clockPilot()
  progress.schedule(id, task.id, at, '重启后检查', 'restart')
  controller.abort(); advance(); await effects.drain(); store.close()
  const reopened = new Store(join(directory, 'state.sqlite'))
  const resumedEffects = new Effects(reopened, new HealthBoard())
  const resumedEvents = new ProjectEvents(reopened, resumedEffects)
  const second = new AbortController()
  const recovered = new ProjectProgress({ store: reopened, events: resumedEvents, agent: { react } , lifetime: second.signal, now: () => Date.parse('2026-11-18T04:03:00Z') })
  cleanup = async () => { second.abort(); await resumedEffects.drain(); reopened.close(); rmSync(directory, { recursive: true, force: true }) }
  recovered.recover(); resumedEffects.start(); await resumedEffects.idle()
  expect(react).toHaveBeenCalledOnce()
  expect(react.mock.calls[0]?.[0]).toMatchObject({ type: checkDue.type, data: { reason: '重启后检查' } })
  recovered.recover(); await resumedEffects.idle(); expect(react).toHaveBeenCalledOnce()
})

it('cancels or replaces obsolete appointments before they can act', async () => {
  const { progress, effects, events, id, task, react, advance, at } = await clockPilot()
  const old = progress.schedule(id, task.id, at, 'old', 'old')
  progress.schedule(id, task.id, at, 'new', 'new')
  advance(); progress.recover(); await effects.idle()
  expect(events.list().filter(event => event.type === checkDue.type)).toHaveLength(1)
  expect(react.mock.calls[0]?.[0].data).toMatchObject({ reason: 'new' })
  expect(progress.current({ source: 'clock', type: checkDue.type, projectId: id, taskId: task.id,
    data: { checkId: old.id, signature: old.signature, reason: old.reason } } as ProjectEvent)).toBe(false)
  progress.cancel(id, task.id)
  expect(progress.current(react.mock.calls[0]![0])).toBe(false)
})

it('invalidates appointments after scope changes, task completion or project pause', async () => {
  const { progress, id, task, change, at } = await clockPilot()
  progress.schedule(id, task.id, at, 'test', 'scope')
  change({ kind: 'task', id: task.id, value: { ...TaskInput.strip().parse(task), acceptance: 'new acceptance' } })
  expect(progress.checks(id)).toEqual([])
  progress.schedule(id, task.id, at, 'test', 'pause')
  change({ kind: 'project', value: { name: 'Clock', status: 'paused' } })
  expect(progress.checks(id)).toEqual([])
  expect(() => progress.schedule(id, task.id, at, 'test', 'paused')).toThrow('Enable automatic')
})

it('publishes readiness atomically with dependency acceptance and rolls it back with the aggregate', async () => {
  const { store, effects, events, progress, id, task, change, react } = await clockPilot()
  change({ kind: 'task', id: task.id, value: { ...TaskInput.strip().parse(task), status: 'in-progress' } })
  const downstream = change({ kind: 'task', value: { title: 'Next', blockedBy: [task.id] } }).tasks[1]!
  await effects.idle(); react.mockClear()
  expect(() => store.atomic(() => { change({ kind: 'task-status', id: task.id, status: 'done' }); throw new Error('rollback') })).toThrow('rollback')
  await effects.idle(); expect(react).not.toHaveBeenCalled()
  change({ kind: 'task-status', id: task.id, status: 'done' }); await effects.idle()
  expect(react).toHaveBeenCalledOnce()
  expect(react.mock.calls[0]?.[0]).toMatchObject({ taskId: downstream.id, type: taskReady.type })
  const count = events.list().length
  progress.recover(); await effects.idle(); expect(events.list()).toHaveLength(count)
})

it('respects event source filters and the project automatic-progression switch', async () => {
  const { events, effects, progress, id, task, change, react, advance, at } = await clockPilot()
  events.save(0, { sources: { clock: { enabled: false } } })
  progress.schedule(id, task.id, at, 'disabled', 'disabled')
  advance(); progress.recover(); await effects.idle()
  expect(react).not.toHaveBeenCalled()
  expect(events.list()[0]?.status).toBe('ignored')
  change({ kind: 'project', value: { name: 'Clock', status: 'active', autoAdvance: false } })
  expect(() => progress.schedule(id, task.id, at, 'disabled', 'no-authorization')).toThrow('Enable automatic')
})

it('saves a chat-selected appointment through the tool loop and exposes its actual state for inspection', async () => {
  const { h, id, task, activate, propose } = await pilot()
  activate(); await h.runtime.idle()
  const at = new Date(Date.now() + 120_000).toISOString()
  propose.mockResolvedValueOnce({ calls: [call('follow_up.schedule', { taskId: task.id, at, reason: '检查新的执行证据' })], reply: '' })
    .mockResolvedValueOnce(done('已预约本次检查。'))
  expect(await h.api('POST', `projects/${id}/messages`, { messageId: 'schedule-from-chat', text: '稍后再看看这个任务，没有变化就不用提醒' })).toMatchObject({ status: 200 })
  await h.runtime.idle()
  expect(await h.api('GET', `projects/${id}/checks`)).toMatchObject({ status: 200, body: [{ taskId: task.id, at, reason: '检查新的执行证据' }] })
  expect(await h.api('GET', 'projects/nonexistent/checks')).toMatchObject({ status: 404 })
})

it('removes pending checks when the project aggregate is deleted', async () => {
  const { store, progress, effects, id, task, react, at, advance } = await clockPilot()
  progress.schedule(id, task.id, at, 'test deletion', 'delete')
  store.delete(KV.projects.project(id))
  expect(progress.checks(id)).toEqual([])
  advance(); progress.recover(); await effects.idle()
  expect(react).not.toHaveBeenCalled()
})

it('ships a separate default JSON and configuration guide for each follow-up event', () => {
  for (const definition of [taskReady, checkDue]) {
    const file = definition.type === taskReady.type ? 'task-ready' : 'check-due'
    expect(JSON.parse(readFileSync(`config/events/${file}.defaults.json`, 'utf8'))).toEqual({ on: { [definition.type]: true } })
    expect(readFileSync(definition.documentation, 'utf8')).toContain(definition.type)
  }
})
