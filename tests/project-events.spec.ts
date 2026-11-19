import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { ProjectEvents } from '../src/app/project-events.ts'
import { HealthBoard } from '../src/infra/health.ts'
import type { ProjectEventDefinition } from '../src/sources/project-events.ts'

let directory: string, store: Store, effects: Effects, events: ProjectEvents, clock: number
const definition: ProjectEventDefinition = { type: 'sample.received', category: 'samples', description: 'A test source received a sample',
  schema: z.strictObject({ text: z.string() }), defaults: { enabled: true }, documentation: 'docs/events/README.zh-CN.md' }
const input = (id: string) => ({ id, type: definition.type, projectId: 'project', data: { text: id } })
const applied = { status: 'applied' as const }
const path = () => join(directory, 'state.sqlite')
function open() {
  store = new Store(path())
  effects = new Effects(store, new HealthBoard(), () => clock)
  events = new ProjectEvents(store, effects)
  events.register('sample', [definition])
}
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'project-events-')); clock = Date.now(); open() })
afterEach(async () => { await effects.drain(); store.close(); rmSync(directory, { recursive: true, force: true }) })

it('wakes after commit, applies in enqueue order and keeps idempotent receipts', async () => {
  const seen: string[] = []
  events.handle(definition.type, event => { seen.push(event.id); return applied })
  effects.start()
  const source = events.publisher('sample')
  store.atomic(() => {
    source.publish({ ...input('first'), occurredAt: '2026-11-17T11:00:00Z' })
    source.publish({ ...input('second'), occurredAt: '2026-11-16T11:00:00Z' })
    expect(seen).toEqual([])
  })
  await effects.idle()
  expect(seen).toEqual(['first', 'second'])
  expect(source.publish({ ...input('first'), occurredAt: '2026-11-17T11:00:00Z' }).status).toBe('applied')
  expect(() => source.publish(input('first'))).toThrow('different content')
  expect(events.list()).toHaveLength(2)
  expect(events.list().map(event => event.status)).toEqual(['applied', 'applied'])
  await effects.idle()
  expect(seen).toEqual(['first', 'second'])
})

it('rolls back the event and its wakeup with its source transaction', async () => {
  const run = vi.fn(() => applied)
  events.handle(definition.type, run)
  effects.start()
  expect(() => store.atomic(() => { events.publisher('sample').publish(input('rolled-back')); throw Error('rollback') })).toThrow('rollback')
  await effects.idle()
  expect(run).not.toHaveBeenCalled()
  expect(events.list()).toEqual([])
  expect(effects.pending('project-events')).toBe(false)
})

it('rolls back a failed transition and its effects and holds later events until retry succeeds', async () => {
  let fail = true
  const reply = vi.fn(async (_payload: { text: string }) => {})
  effects.handle('relay', reply)
  events.handle(definition.type, event => {
    store.set(`test-event:${event.id}`, true)
    effects.enqueue('relay', event.id, { text: event.id })
    if (event.id === 'first' && fail) throw new Error('cannot commit')
    return applied
  })
  events.publisher('sample').publish(input('first'))
  events.publisher('sample').publish(input('second'))
  effects.start()
  await effects.idle()
  expect(store.get('test-event:first')).toBeUndefined()
  expect(store.get('test-event:second')).toBeUndefined()
  expect(reply).not.toHaveBeenCalled()
  expect(events.list().every(event => event.status === 'pending')).toBe(true)
  fail = false; clock += 2000
  await effects.idle()
  expect(reply.mock.calls.map(([payload]) => payload)).toEqual([{ text: 'first' }, { text: 'second' }])
  expect(events.list().every(event => event.status === 'applied')).toBe(true)
})

it('recovers a committed event after the wakeup was lost and keeps applied history across restarts', async () => {
  events.publisher('sample').publish(input('recover'))
  // Simulate a process ending after persistence and before it can wake the consumer.
  store.db.prepare("DELETE FROM effect WHERE kind='project-events'").run()
  await effects.drain(); store.close(); open()
  const run = vi.fn(() => applied)
  events.handle(definition.type, run)
  events.recover(); effects.start()
  await effects.idle()
  expect(run).toHaveBeenCalledOnce()
  expect(events.publisher('sample').publish(input('recover')).status).toBe('applied')
  events.recover(); await effects.idle()
  expect(run).toHaveBeenCalledOnce()
})

it('validates JSON overrides, preserves defaults, rejects stale saves and can disable a category', async () => {
  const run = vi.fn(() => applied)
  events.handle(definition.type, run)
  expect(events.view()).toMatchObject({ revision: 0, config: { sources: {}, on: {} },
    events: [{ defaults: { enabled: true }, effective: { enabled: true } }] })
  expect(() => events.save(0, { on: { 'sample.typo': false } })).toThrow('not installed')
  expect(() => events.save(0, { sources: { sample: { watch: ['unknown'] } } })).toThrow('Unknown watch')
  expect(() => events.save(0, { on: { 'sample.received': 'An unsupported Agent instruction' } })).toThrow('no Agent instruction')
  expect(() => events.save(0, { sources: { sample: { enabld: false } } })).toThrow()
  events.save(0, { sources: { sample: { watch: [] } } })
  expect(() => events.save(0, {})).toThrow('changed')
  events.publisher('sample').publish(input('disabled'))
  effects.start(); await effects.idle()
  expect(run).not.toHaveBeenCalled()
  expect(events.list()[0]).toMatchObject({ status: 'ignored', reason: expect.stringContaining('Disabled') })
  events.save(1, {})
  events.publisher('sample').publish(input('enabled'))
  await effects.idle()
  expect(run).toHaveBeenCalledOnce()
  expect(events.list()).toHaveLength(2)
})

it('discovers independently configured providers and custom event types from registration', async () => {
  const custom: ProjectEventDefinition = { type: 'merge_request.updated', category: 'merge_requests', description: '核对 GitLab 合并请求的真实交付。',
    schema: z.strictObject({ text: z.string() }), defaults: { enabled: true }, documentation: 'gitlab/README.md' }
  events.register('github', [definition])
  events.register('gitlab', [definition, custom])
  const catalog = events.view()
  expect(catalog.sources.find(source => source.source === 'gitlab')).toMatchObject({ categories: ['samples', 'merge_requests'],
    defaults: { sources: { gitlab: { on: { 'merge_request.updated': { enabled: true, description: custom.description } } } } } })
  events.save(0, { sources: { github: { on: { [definition.type]: { enabled: false, description: '只关闭 GitHub' } } },
    gitlab: { on: { [definition.type]: { enabled: true, description: '' } } } } })
  const seen: string[] = []
  events.handle(definition.type, event => { seen.push(event.source); return applied })
  events.publisher('github').publish(input('github-event'))
  events.publisher('gitlab').publish(input('gitlab-event'))
  effects.start(); await effects.idle()
  expect(seen).toEqual(['gitlab'])
  expect(events.view().sources.find(source => source.source === 'gitlab')?.events[0]?.effective.description).toBe('')
})

it('merges source overrides by field and preserves unrelated sources with version checks', () => {
  events.register('other', [definition])
  events.save(0, { on: { [definition.type]: false }, sources: { other: { on: { [definition.type]: true } } } })
  events.saveSource('sample', 1, { on: { [definition.type]: { description: '仅解释，不授权执行' } } })
  expect(events.settings('sample', definition.type)).toMatchObject({ enabled: false, description: '仅解释，不授权执行' })
  expect(events.settings('other', definition.type).enabled).toBe(true)
  expect(() => events.saveSource('sample', 1, {})).toThrow('changed')
  expect(() => events.saveSource('uninstalled', 2, {})).toThrow('not installed')
  expect(() => events.saveSource('sample', 2, { on: { 'another.event': true } })).toThrow('not installed')
  expect(() => events.saveSource('sample', 2, { on: { [definition.type]: { instruction: '不能给后台处理器添加 Agent 指令' } } })).toThrow('no Agent instruction')
  expect(() => events.saveSource('sample', 2, { on: { [definition.type]: { enabld: true } } })).toThrow()
  events.saveSource('sample', 2, { enabled: false, on: { [definition.type]: true } })
  expect(events.settings('sample', definition.type).enabled).toBe(false)
})

it('recovers object settings, empty descriptions and legacy shorthands across database reopening', async () => {
  events.save(0, { on: { [definition.type]: false }, sources: { sample: { on: { [definition.type]: { enabled: true, description: '' } } } } })
  await effects.drain(); store.close(); open()
  expect(events.settings('sample', definition.type)).toMatchObject({ enabled: true, description: '' })
  expect(events.view()).toMatchObject({ revision: 1, config: { on: { [definition.type]: false } } })
})

it('keeps descriptions separate from AI instructions while retaining legacy instruction strings', () => {
  const agent: ProjectEventDefinition = { ...definition, type: 'agent.requested', defaults: { enabled: true, instruction: '默认指导' } }
  events.register('agent', [agent])
  events.save(0, { on: { [agent.type]: '旧格式指导' }, sources: { agent: { on: { [agent.type]: { description: '显示说明' } } } } })
  expect(events.settings('agent', agent.type)).toMatchObject({ enabled: true, description: '显示说明', instruction: '旧格式指导' })
  events.saveSource('agent', 1, { on: { [agent.type]: { enabled: false, description: '', instruction: '新的指导' } } })
  expect(events.settings('agent', agent.type)).toMatchObject({ enabled: false, description: '', instruction: '新的指导' })
})

it('binds publishers to registered source schemas and supports the same event from another adapter', async () => {
  events.register('another', [definition])
  const run = vi.fn(() => applied)
  events.handle(definition.type, run)
  expect(() => events.publisher('unregistered').publish(input('invalid'))).toThrow('not registered')
  expect(() => events.publisher('sample').publish({ ...input('invalid'), data: { unexpected: true } })).toThrow()
  events.publisher('sample').publish(input('same-native-id'))
  events.publisher('another').publish(input('same-native-id'))
  effects.start(); await effects.idle()
  expect(run).toHaveBeenCalledTimes(2)
  expect(events.list().map(event => event.source)).toEqual(['another', 'sample'])
})

it('queues slow external work without holding the next event or requiring an Agent to consume events', async () => {
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const seen: string[] = []
  effects.handle('relay', async () => { await hold })
  events.handle(definition.type, event => {
    seen.push(event.id)
    if (event.id === 'first') effects.enqueue('relay', 'slow', { text: 'external work' })
    return applied
  })
  events.publisher('sample').publish(input('first'))
  events.publisher('sample').publish(input('second'))
  effects.start()
  await vi.waitFor(() => expect(seen).toEqual(['first', 'second']))
  expect(effects.pending('relay', 'slow')).toBe(true)
  release(); await effects.idle()
})

it('rolls back an asynchronous handler rather than committing state outside the event transaction', async () => {
  events.handle(definition.type, (() => { store.set('async-write', true); return Promise.resolve(applied) }) as never)
  events.publisher('sample').publish(input('async'))
  effects.start(); await effects.idle()
  expect(store.get('async-write')).toBeUndefined()
  expect(events.list()[0]?.status).toBe('pending')
})

it('retains an event from a newer payload version instead of applying it with the wrong handler', async () => {
  const run = vi.fn(() => applied)
  events.handle(definition.type, run)
  events.publisher('sample').publish(input('newer-version'))
  expect(events.list()[0]?.version).toBe(1)
  store.db.prepare("UPDATE project_event SET value=json_set(value, '$.version', 2)").run()
  effects.start(); await effects.idle()
  expect(run).not.toHaveBeenCalled()
  expect(events.list()[0]).toMatchObject({ status: 'pending', version: 2 })
})
