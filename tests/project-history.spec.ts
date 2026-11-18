import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { Projects, ProjectInput, ProjectChange } from '../src/app/projects.ts'
import { ProjectHistory } from '../src/app/project-history.ts'
import { ProjectEvents } from '../src/app/project-events.ts'
import { Effects } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
let host: Host | undefined
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await host?.stop(); host = undefined; await cleanup?.(); cleanup = undefined })
it('joins an original message, Agent decision and confirmed task changes through the normal history API', async () => {
  const propose = vi.fn().mockResolvedValueOnce({ calls: [{ tool: 'task.create', arguments: JSON.stringify({ title: '实现2048' }) }], reply: '' })
    .mockResolvedValueOnce({ calls: [], reply: '已建立任务，等待分工。' })
  const h = host = await startRuntime(undefined, undefined, undefined, undefined, undefined, { name: 'History Agent', propose })
  const projects = new Projects(h.runtime.store)
  const project = projects.create(ProjectInput.parse({ name: 'History', status: 'planning', autoAdvance: false }))
  await h.api('POST', `projects/${project.id}/messages`, { messageId: 'meeting-message', text: '建立一个实现2048的任务，先不执行' }); await h.runtime.idle()
  const history = h.runtime.projectHistory.view(project.id)
  const incoming = history.entries.find(item => item.event.type === 'project.message.received')!
  expect(incoming.reason).toContain('建立一个')
  expect(incoming.decisions[0]).toMatchObject({ status: 'completed', reply: '已建立任务，等待分工。', steps: [{ results: [{ summary: expect.stringContaining('已创建') }] }] })
  expect(history.entries.some(item => item.event.type === 'project.changed' && !!item.event.causeId)).toBe(true)
  expect(history.notifications).toContainEqual(expect.objectContaining({ origin: expect.objectContaining({
    projectId: project.id, runId: incoming.decisions[0]!.id, eventId: 'meeting-message' }) }))
  expect(history.notifications[0]).not.toHaveProperty('channel')
  expect(await h.api('GET', `projects/${project.id}/history`)).toMatchObject({ status: 200, body: { next: null } })
  expect(await h.api('GET', 'projects/missing/history')).toMatchObject({ status: 404 })
})
it('paginates history with a stable sequence cursor without skipping equal timestamps', async () => {
  const h = host = await startRuntime()
  const projects = new Projects(h.runtime.store)
  const project = projects.create(ProjectInput.parse({ name: 'Pagination', autoAdvance: false }))
  for (let i = 0; i < 110; i++) projects.change(project.id, ProjectChange.parse({ revision: projects.detail(project.id).revision,
    change: { kind: 'project', value: { name: `Version ${i}` } } }))
  await h.runtime.idle()
  const first = h.runtime.projectHistory.view(project.id)
  const second = h.runtime.projectHistory.view(project.id, first.next!)
  expect(first.entries).toHaveLength(100)
  expect(second.entries).toHaveLength(11)
  expect(new Set([...first.entries, ...second.entries].map(item => item.event.seq)).size).toBe(111)
})
it('links only explicit event and run identities when unrelated messages have no cause ID', async () => {
  const propose = vi.fn().mockResolvedValue({ calls: [], reply: '已读取，未修改任务。' })
  const h = host = await startRuntime(undefined, undefined, undefined, undefined, undefined, { name: 'History Agent', propose })
  const projects = new Projects(h.runtime.store)
  const project = projects.create(ProjectInput.parse({ name: 'Independent messages', autoAdvance: false }))
  for (const messageId of ['first-message', 'second-message']) {
    await h.api('POST', `projects/${project.id}/messages`, { messageId, text: '只读取现状' })
    await h.runtime.idle()
  }
  const runs = h.runtime.projectAgent!.runs(project.id)
  const history = h.runtime.projectHistory.view(project.id)
  for (const messageId of ['first-message', 'second-message']) {
    const run = runs.find(run => run.message.messageId === messageId)!
    expect(history.entries.find(item => item.event.id === messageId)?.decisions.map(item => item.id)).toEqual([run.id])
    expect(history.entries.filter(item => item.event.causeId === run.id).every(item => item.decisions.length === 1 && item.decisions[0]!.id === run.id)).toBe(true)
  }
  expect(history.entries.find(item => item.event.type === 'project.changed')?.decisions).toEqual([])
})
it('rolls back project changes and their audit facts together', async () => {
  const h = host = await startRuntime()
  const projects = new Projects(h.runtime.store)
  const project = projects.create(ProjectInput.parse({ name: 'Rollback' }))
  const before = h.runtime.projectEvents.list({ projectId: project.id }).length
  expect(() => h.runtime.store.atomic(() => {
    projects.change(project.id, ProjectChange.parse({ revision: 0, change: { kind: 'project', value: { name: 'Must roll back' } } }))
    throw new Error('rollback')
  })).toThrow('rollback')
  expect(h.runtime.projectEvents.list({ projectId: project.id })).toHaveLength(before)
  expect(projects.detail(project.id).name).toBe('Rollback')
})
it('imports legacy completion and reference links once across a full database reopen without remote effects', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'history-migration-'))
  const path = join(directory, 'state.sqlite')
  let store = new Store(path)
  const projects = new Projects(store)
  const project = projects.create(ProjectInput.parse({ name: 'Legacy', repository: 'acme/widgets', autoAdvance: false }))
  projects.change(project.id, ProjectChange.parse({ revision: 0, change: { kind: 'task', value: { title: 'Historical task', status: 'done', issueUrl: 'https://github.com/acme/widgets/issues/1' } } }))
  let effects = new Effects(store, new HealthBoard())
  let events = new ProjectEvents(store, effects)
  let lifetime = new AbortController()
  let history = new ProjectHistory(store, events, lifetime.signal)
  cleanup = async () => { lifetime.abort(); await effects.drain(); store.close(); rmSync(directory, { recursive: true, force: true }) }
  history.recover(); effects.start(); await effects.idle()
  expect(new Projects(store).detail(project.id).tasks[0]).toMatchObject({ status: 'done', issueUrl: 'https://github.com/acme/widgets/issues/1' })
  expect(history.view(project.id).entries[0]).toMatchObject({ event: { type: 'project.history.imported', data: { tasks: [{ issueRole: 'reference' }] } } })
  expect(effects.pending('project-issue-sync')).toBe(false)
  lifetime.abort(); await effects.drain(); store.close()
  store = new Store(path); effects = new Effects(store, new HealthBoard()); events = new ProjectEvents(store, effects); lifetime = new AbortController()
  history = new ProjectHistory(store, events, lifetime.signal)
  history.recover(); effects.start(); await effects.idle()
  expect(events.list()).toHaveLength(1)
  expect(store.get(KV.projects.historyBaseline(project.id))).toBe(true)
  expect(effects.pending('project-issue-sync')).toBe(false)
})
