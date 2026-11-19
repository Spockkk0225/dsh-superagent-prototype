import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { ProjectEvents } from '../src/app/project-events.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { ProjectRepository, type IssueSync } from '../src/app/project-repository.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { KV } from '../src/kv.ts'
import { Projects, ProjectInput, ProjectChange, TaskInput } from '../src/app/projects.ts'
import { currentReview } from '../src/app/project-deliveries.ts'
import { repositoryFactKey } from '../src/app/repository-delivery.ts'
import { issueCloseRequested } from '../src/app/project-repository.ts'
import { changeObserved, issueObserved } from '../src/sources/repository-events.ts'
import { pollProjectFacts } from '../src/sources/github.ts'
import { CliError } from '../src/infra/commands.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { deferred } from './fixtures/async.ts'
let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })
const url = 'https://github.com/acme/widgets/issues/17'
async function pilot(mode: 'report' | 'pull-request' = 'report', executionMode: 'manual' | 'agent' = 'manual') {
  const h = host = await startRuntime()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, request: { allowed: [{ id: 'local' }] } } } })
  const projects = new Projects(h.runtime.store)
  const { id } = projects.create(ProjectInput.parse({ name: 'Repository integration', repository: 'acme/widgets', autoAdvance: false }))
  const change = (change: ProjectChange['change']) => projects.change(id, ProjectChange.parse({ revision: projects.detail(id).revision, change }))
  const task = change({ kind: 'task', value: { title: '2048 game', executionMode, issueUrl: url, issueRole: 'resolve', deliveryMode: mode,
    ...(mode === 'pull-request' ? { pullRequestUrl: 'https://github.com/acme/widgets/pull/3', targetBranch: 'main' } : {}) } }).tasks[0]!
  let remote = { state: 'open', html_url: url, updated_at: '2026-11-18T04:00:00.000Z' }
  const api = vi.fn(async (_schema: z.ZodType, _path: string, ...args: string[]) => {
    if (args.includes('PATCH')) remote = { ...remote, state: 'closed', updated_at: '2026-11-18T04:01:00.000Z' }
    return remote
  })
  vi.spyOn(h.runtime.commands, 'forRepository').mockReturnValue({ api } as never)
  const submit = async () => {
    h.runtime.projectReviews.submit({ projectId: id, actorId: null, operationId: 'delivery', channel: { source: 'request', thread: id, address: {} } }, task.id,
      { summary: 'Tested implementation', links: [] })
    await h.runtime.idle()
  }
  const accept = async () => {
    const review = currentReview(projects.detail(id).tasks[0]!)!
    const result = h.runtime.projectReviews.decide({ projectId: id, actorId: null, operationId: 'accepted', channel: { source: 'request', thread: id, address: {} } }, task.id, review.id, 'accepted', 'Verified the current game')
    await h.runtime.idle(); return result
  }
  const fact = (state: 'open' | 'closed' | 'merged', stamp = '2026-11-18T04:00:00.000Z', fields = {}) => {
    const current = projects.detail(id).tasks[0]!
    return h.runtime.projectEvents.publisher('github').publish({ id: `${state}-${stamp}-${JSON.stringify(fields)}`, type: changeObserved.type, projectId: id, taskId: task.id,
      data: { repository: 'acme/widgets', url: 'https://github.com/acme/widgets/pull/3', state, updatedAt: stamp,
        head: 'head-sha', mergeCommit: 'merge-sha', base: 'main', deliveryVersion: current.deliveryVersion ?? 0,
        ...(current.ticketId ? { ticketId: current.ticketId } : {}), ...fields } })
  }
  return { h, projects, id, task, change, submit, accept, api, fact }
}
it('closes an explicitly resolved Issue only after actual human acceptance and records the remote receipt', async () => {
  const { h, id, submit, accept, api } = await pilot()
  await submit(); expect(api).not.toHaveBeenCalled()
  await accept()
  expect(api).toHaveBeenCalledTimes(2)
  expect(api.mock.calls[1]).toEqual([expect.anything(), 'issues/17', '--method', 'PATCH', '-f', 'state=closed', '-f', 'state_reason=completed'])
  const history = h.runtime.projectHistory.view(id)
  expect(history.synchronization[0]).toMatchObject({ status: 'succeeded', attempts: 1, url })
  expect(history.entries.some(entry => entry.event.type === 'issue.sync.result' && entry.event.status === 'applied')).toBe(true)
  expect(history.remote[0]).toMatchObject({ state: 'closed' })
})
it('leaves legacy and reference-only Issue links open after acceptance', async () => {
  const { h, id, task, change, submit, accept, api } = await pilot()
  change({ kind: 'task', id: task.id, value: { ...TaskInput.strip().parse(task), issueRole: 'reference' } })
  await submit(); await accept()
  expect(api).not.toHaveBeenCalled()
  expect(h.runtime.projectHistory.view(id).synchronization).toEqual([])
})
it('records an explicit disabled close reaction without making remote calls', async () => {
  const { h, submit, accept, api } = await pilot()
  h.runtime.projectEvents.save(0, { on: { [issueCloseRequested.type]: false } })
  await submit(); await accept()
  expect(api).not.toHaveBeenCalled()
  expect(h.runtime.projectEvents.list().find(event => event.type === issueCloseRequested.type)?.status).toBe('ignored')
})
it('reads before every retry and recovers an uncertain write without a duplicate PATCH', async () => {
  const { h, id, submit, accept, api } = await pilot()
  api.mockResolvedValueOnce({ state: 'open', html_url: url, updated_at: '2026-11-18T04:00:00.000Z' })
    .mockRejectedValueOnce(new Error('network timeout after write'))
    .mockResolvedValue({ state: 'closed', html_url: url, updated_at: '2026-11-18T04:01:00.000Z' })
  await submit(); await accept()
  expect(h.runtime.projectHistory.view(id).synchronization[0]?.status).toBe('retrying')
  const operation = h.runtime.projectHistory.view(id).synchronization[0]!
  h.runtime.projectRepository.retry(operation.id); await h.runtime.idle()
  expect(h.runtime.projectHistory.view(id).synchronization[0]).toMatchObject({ status: 'succeeded', attempts: 2 })
  expect(api.mock.calls.filter(args => args.includes('PATCH'))).toHaveLength(1)
})
it('surfaces permission failure and allows a current authorized manual retry', async () => {
  const { h, id, submit, accept, api } = await pilot()
  api.mockRejectedValueOnce(new CliError('Forbidden', 403))
  await submit(); await accept()
  const operation = h.runtime.projectHistory.view(id).synchronization[0]!
  expect(operation.status).toBe('failed')
  expect(await h.api('POST', `projects/${id}/synchronization/${operation.id}/retry`, {})).toMatchObject({ status: 200 })
  await h.runtime.idle()
  expect(h.runtime.projectHistory.view(id).synchronization[0]?.status).toBe('succeeded')
  expect(await h.api('POST', `projects/${id}/synchronization/${operation.id}/retry`, {})).toMatchObject({ status: 409 })
})
it('cancels a queued Issue close when the accepted task is reopened', async () => {
  const { h, id, task, projects, change, submit, api } = await pilot()
  await submit()
  const review = currentReview(projects.detail(id).tasks[0]!)!
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  h.runtime.projectReviews.decide({ projectId: id, actorId: null, operationId: 'accepted', channel: { source: 'request', thread: id, address: {} } }, task.id, review.id, 'accepted', 'Checked')
  // Consume acceptance while holding only the remote action queue.
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: false })
  const gate = deferred<unknown>()
  api.mockImplementationOnce(() => gate.promise as never)
  await vi.waitFor(() => expect(api).toHaveBeenCalledOnce())
  change({ kind: 'task-status', id: task.id, status: 'todo' })
  gate.resolve({ state: 'open', html_url: url, updated_at: '2026-11-18T04:00:00.000Z' }); await h.runtime.idle()
  expect(api).toHaveBeenCalledOnce()
  expect(h.runtime.projectHistory.view(id).synchronization[0]?.status).toBe('cancelled')
})
it('does not treat an Issue close or reopen observation as project acceptance', async () => {
  const { h, projects, id, task } = await pilot()
  for (const [state, stamp] of [['closed', '2026-11-18T04:00:00.000Z'], ['open', '2026-11-18T04:01:00.000Z']] as const) {
    h.runtime.projectEvents.publisher('github').publish({ id: state, type: issueObserved.type, projectId: id, taskId: task.id,
      data: { repository: 'acme/widgets', url, state, updatedAt: stamp, deliveryVersion: 0 } })
    await h.runtime.idle()
  }
  expect(projects.detail(id).tasks[0]?.status).toBe('todo')
  expect(h.runtime.projectHistory.view(id).remote[0]?.state).toBe('open')
})
it('requires report plus verified merged PR and preserves unmerged closure as a remote fact', async () => {
  const { h, projects, id, submit, fact } = await pilot('pull-request')
  fact('closed'); await h.runtime.idle(); await submit()
  expect(projects.detail(id).tasks[0]?.status).toBe('todo')
  expect(h.runtime.projectEvents.list().find(event => event.type === 'review.requested')?.status).toBe('ignored')
})
it('gates worker delivery in both merge/report arrival orders without duplicate reviews', async () => {
  const { h, projects, id, task, fact } = await pilot('pull-request', 'agent')
  const started = await h.api('POST', `projects/${id}/tasks/${task.id}/run`, { revision: projects.detail(id).revision })
  expect(started, JSON.stringify(started)).toMatchObject({ status: 200 })
  await h.runtime.idle()
  const ticketId = projects.detail(id).tasks[0]!.ticketId!
  await h.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'ready', summary: 'Implementation and tests complete' })
  await h.runtime.idle()
  expect(projects.detail(id).tasks[0]?.status).toBe('in-progress')
  fact('merged'); await h.runtime.idle()
  expect(projects.detail(id).tasks[0]).toMatchObject({ status: 'in-review', reviews: [expect.objectContaining({ status: 'pending' })] })
  h.runtime.deliveryReady.observe(ticketId); await h.runtime.idle()
  expect(projects.detail(id).tasks[0]?.reviews).toHaveLength(1)
})
it('accepts merged evidence before the worker report and verifies target branch and delivery version', async () => {
  const { h, projects, id, task, fact } = await pilot('pull-request', 'agent')
  await h.api('POST', `projects/${id}/tasks/${task.id}/run`, { revision: projects.detail(id).revision }); await h.runtime.idle()
  const ticketId = projects.detail(id).tasks[0]!.ticketId!
  fact('merged', '2026-11-18T04:00:00.000Z', { base: 'other' }); await h.runtime.idle()
  await h.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'ready', summary: 'Implementation report' }); await h.runtime.idle()
  expect(projects.detail(id).tasks[0]?.status).toBe('in-progress')
  fact('merged', '2026-11-18T04:01:00.000Z', { base: 'main' }); await h.runtime.idle()
  expect(projects.detail(id).tasks[0]?.status).toBe('in-review')
})
it('rejects stale, wrong-repository and old-delivery remote observations', async () => {
  const { h, id, task, fact } = await pilot('pull-request')
  fact('merged', '2026-11-18T04:02:00.000Z'); await h.runtime.idle()
  fact('open', '2026-11-18T04:01:00.000Z')
  fact('closed', '2026-11-18T04:03:00.000Z', { deliveryVersion: 9 })
  fact('closed', '2026-11-18T04:03:00.000Z', { repository: 'another/repo' }); await h.runtime.idle()
  expect(h.runtime.store.get(repositoryFactKey(id, task.id, 0, 'https://github.com/acme/widgets/pull/3'))?.state).toBe('merged')
  expect(h.runtime.projectEvents.list().filter(event => event.type === changeObserved.type && event.status === 'ignored')).toHaveLength(3)
})
it('polls linked objects through repository-scoped commands and deduplicates repeated canonical facts', async () => {
  const { h, id, api } = await pilot('pull-request')
  api.mockImplementation(async (_schema, path) => path === 'pulls/3' ? { state: 'closed', merged: true, html_url: 'https://github.com/acme/widgets/pull/3', updated_at: '2026-11-18T04:00:00.000Z',
    head: { sha: 'head' }, base: { ref: 'main' }, merge_commit_sha: 'merge' } : { state: 'open', html_url: url, updated_at: '2026-11-18T04:00:00.000Z' })
  const ctx = h.runtime.context({ kind: 'github', health: ['github'] })
  const original = h.runtime.commands.forRepository
  vi.mocked(original).mockReturnValue({ api, withSignal: () => ({ api, pages: vi.fn().mockResolvedValue([]) }) } as never)
  await pollProjectFacts(ctx); await pollProjectFacts(ctx); await h.runtime.idle()
  expect(h.runtime.projectEvents.list({ projectId: id }).filter(event => [changeObserved.type, issueObserved.type].includes(event.type))).toHaveLength(2)
})

it('continues healthy repository observation when another repository is unavailable', async () => {
  const { h } = await pilot()
  const projects = new Projects(h.runtime.store)
  const other = projects.create(ProjectInput.parse({ name: 'Another project', repository: 'acme/other', autoAdvance: false }))
  projects.change(other.id, ProjectChange.parse({ revision: 0, change: { kind: 'task', value: {
    title: 'Independent task', issueUrl: 'https://github.com/acme/other/issues/17' } } }))
  const api = vi.fn(async () => ({ state: 'open', html_url: 'https://github.com/acme/other/issues/17', updated_at: '2026-11-18T04:00:00.000Z' }))
  vi.mocked(h.runtime.commands.forRepository).mockImplementation(repository => ({ withSignal: () => ({
    api: repository === 'acme/other' ? api : vi.fn().mockRejectedValue(new CliError('Forbidden', 403)) }) }) as never)
  await expect(pollProjectFacts(h.runtime.context({ kind: 'github', health: ['github'] }))).rejects.toThrow('Some linked repository')
  await h.runtime.idle()
  expect(h.runtime.projectHistory.view(other.id).remote).toMatchObject([{ repository: 'acme/other', state: 'open' }])
})
it('allows clearing a target branch without silently retaining the previous delivery constraint', async () => {
  const { projects, id, task, change } = await pilot('pull-request')
  expect(task.targetBranch).toBe('main')
  change({ kind: 'task', id: task.id, value: TaskInput.strip().parse({ ...task, targetBranch: null }) })
  expect(projects.detail(id).tasks[0]?.targetBranch).toBeNull()
})

it('recovers an uncertain remote write across a full SQLite reopen without a second PATCH', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'repository-recovery-'))
  const path = join(directory, 'state.sqlite')
  let store = new Store(path), effects = new Effects(store, new HealthBoard()), events = new ProjectEvents(store, effects)
  const projects = new Projects(store)
  const project = projects.create(ProjectInput.parse({ name: 'Recovery', repository: 'acme/widgets', autoAdvance: false }))
  const task = projects.change(project.id, ProjectChange.parse({ revision: 0, change: { kind: 'task', value: {
    title: 'Completed implementation', status: 'done', issueUrl: url, issueRole: 'resolve' } } })).tasks[0]!
  const saved = store.get(KV.projects.project(project.id))!
  saved.tasks[0]!.deliveryVersion = 1
  saved.tasks[0]!.reviews = [{ id: 'accepted-review', version: 1, status: 'accepted', requestedAt: new Date().toISOString(),
    requirements: { title: task.title, description: '', acceptance: '', ownerId: null }, evidence: { summary: 'Checked', links: [] } }]
  store.set(KV.projects.project(project.id), saved)
  const operation: IssueSync = { id: 'close-operation', projectId: project.id, taskId: task.id, reviewId: 'accepted-review', url,
    repository: 'acme/widgets', version: 1, attempts: 0, status: 'pending', reason: 'Queued', updatedAt: new Date().toISOString() }
  let closed = false, patches = 0
  const api = vi.fn(async (_schema: unknown, _path: string, ...args: string[]) => {
    if (args.includes('PATCH')) { closed = true; patches++; throw new Error('Lost response after write') }
    return { html_url: url, state: closed ? 'closed' : 'open', updated_at: '2026-11-18T04:00:00.000Z' }
  })
  const commands = { forRepository: () => ({ api }) } as never
  try {
    new ProjectRepository({ store, effects, events, commands, delivery: { observe: () => {} } })
    store.set(KV.projects.issueSync(operation.id), operation)
    effects.enqueue('project-issue-sync', operation.id, { id: operation.id })
    effects.start(); await effects.idle(); await effects.drain(); store.close()
    store = new Store(path); effects = new Effects(store, new HealthBoard()); events = new ProjectEvents(store, effects)
    new ProjectRepository({ store, effects, events, commands, delivery: { observe: () => {} } })
    store.db.prepare('UPDATE effect SET due = 0').run()
    effects.start(); await effects.idle()
    expect(store.get(KV.projects.issueSync(operation.id))).toMatchObject({ status: 'succeeded', attempts: 2 })
    expect(patches).toBe(1)
    expect(new Projects(store).detail(project.id).tasks[0]?.status).toBe('done')
  } finally { await effects.drain(); store.close(); rmSync(directory, { recursive: true, force: true }) }
})

it('supersedes the pending code review when new repository facts invalidate its commit snapshot', async () => {
  const {h,id,task,projects,fact,submit}=await pilot('pull-request')
  fact('merged');await h.runtime.idle();await submit()
  const review=currentReview(projects.detail(id).tasks[0]!)!
  expect(review.status).toBe('pending')
  fact('open','2026-11-18T04:05:00.000Z',{head:'new-head'});await h.runtime.idle()
  const current=projects.detail(id).tasks[0]!
  expect(current.status).toBe('in-progress')
  expect(current.reviews?.find(item=>item.id===review.id)?.status).toBe('superseded')
  expect(await h.api('POST',`projects/${id}/tasks/${task.id}/reviews/${review.id}`,{messageId:'old-commit-acceptance',outcome:'accepted',reason:'Old commit'})).toMatchObject({status:409})
})
