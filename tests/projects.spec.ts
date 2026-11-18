import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { KV } from '../src/kv.ts'
import { importMissionControl } from '../src/app/mission-control-import.ts'
import { ProjectChange, ProjectInput, Projects, type ProjectDetail, type ProjectExecution } from '../src/app/projects.ts'
import { ProjectPlanning } from '../src/app/project-planning.ts'
import { ProjectIssues } from '../src/app/project-issues.ts'
import { taskReference } from '../src/app/project-task-context.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { Store } from '../src/app/store.ts'
import type { Commands } from '../src/infra/commands.ts'
import type { OutboundMessage } from '../src/core/index.ts'
import { issueTrigger } from '../src/sources/github-trigger.ts'
import { DingTalk, dingTalkKind, dingTalkRoute } from '../src/sources/dingtalk.ts'
import { dingTalkProjectIntake } from '../src/sources/dingtalk-projects.ts'
import { DWClient } from 'dingtalk-stream'
import { pollProjectPulls } from '../src/sources/github-pull.ts'
import { RobotAgents } from '../src/harness/robot-agents.ts'
import { startRuntime } from './fixtures/host.ts'
import { currentReview } from '../src/app/project-deliveries.ts'

let host: Awaited<ReturnType<typeof startRuntime>> | undefined
let directory: string | undefined
async function decideCurrent(h: Awaited<ReturnType<typeof startRuntime>>, projectId: string, taskId: string, outcome: 'accepted' | 'rejected' = 'accepted') {
  const review = currentReview(new Projects(h.runtime.store).detail(projectId).tasks.find(task => task.id === taskId)!)!
  const result = await h.api('POST', `projects/${projectId}/tasks/${taskId}/reviews/${review.id}`,
    { messageId: `${review.id}-${outcome}`, outcome, reason: outcome === 'accepted' ? 'Checked current evidence against the task criteria' : 'Add the missing verification result' })
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  await h.runtime.idle()
  return new Projects(h.runtime.store).detail(projectId)
}
afterEach(async () => {
  await host?.stop(); host = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

it('registers an event source and serves versioned workflow JSON and event history through the normal runtime API', async () => {
  const h = host = await startRuntime()
  const definition = { type: 'sample.received', category: 'samples', description: 'Sample input',
    schema: z.strictObject({ text: z.string() }), defaults: { enabled: true }, documentation: 'docs/events/README.zh-CN.md' }
  h.runtime.sources.register({ kind: 'sample', title: { zh: '样本', en: 'Sample' }, description: { zh: '样本', en: 'Sample' },
    schema: z.strictObject({}), health: [], fields: [], projectEvents: [definition] })
  h.runtime.projectEvents.handle(definition.type, event => {
    h.runtime.store.set('sample-event-result', event.data)
    return { status: 'applied' }
  })
  expect(await h.api('GET', 'projects/workflow')).toMatchObject({ status: 200, body: { revision: 0,
    events: expect.arrayContaining([expect.objectContaining({ type: definition.type, defaults: { enabled: true } })]) } })
  expect(await h.api('PUT', 'projects/workflow', { revision: 0, config: { sources: { sample: { watch: ['typo'] } } } }))
    .toMatchObject({ status: 400 })
  expect(await h.api('PUT', 'projects/workflow', { revision: 0, config: { sources: { sample: { enabled: true } } } }))
    .toMatchObject({ status: 200, body: { revision: 1 } })
  expect(await h.api('PUT', 'projects/workflow', { revision: 0, config: {} })).toMatchObject({ status: 409 })
  const before = h.relays(h.runtime.masterId).length
  h.runtime.context({ kind: 'sample', health: [] }).projectEvents!.publish({
    id: 'normal-entry', type: definition.type, projectId: 'sample-project', data: { text: 'delivered' },
  })
  await h.runtime.idle()
  expect(h.runtime.store.get('sample-event-result')).toEqual({ text: 'delivered' })
  const history = await h.api('GET', 'projects/events?projectId=sample-project&limit=1')
  expect(history).toMatchObject({ status: 200, body: [{ id: 'normal-entry', source: 'sample', status: 'applied' }] })
  expect(h.relays(h.runtime.masterId)).toHaveLength(before)
  expect(await h.api('GET', 'projects/events?limit=201')).toMatchObject({ status: 400 })
})

it('exports one described configuration per registered source and saves a source without replacing others', async () => {
  const h = host = await startRuntime(undefined, undefined, undefined, undefined, undefined, { name: 'Config Agent', propose: async () => ({ calls: [], reply: '' }) })
  h.runtime.sources.register(dingTalkKind(async () => {}))
  const catalog = h.runtime.projectEvents.view()
  const configured = catalog.sources.filter(source => source.events.length)
  expect(readdirSync('config/events').sort()).toEqual(configured.map(source => `${source.source}.defaults.json`).sort())
  for (const source of configured) {
    expect(JSON.parse(readFileSync(`config/events/${source.source}.defaults.json`, 'utf8'))).toEqual(source.defaults)
    expect(source.events.every(event => !!event.effective.description)).toBe(true)
    for (const event of source.events) expect(readFileSync(event.documentation, 'utf8')).toContain(event.type)
  }
  expect(await h.api('PUT', 'projects/workflow', { revision: 0, config: catalog.defaults })).toMatchObject({ status: 200 })
  expect(await h.api('PUT', 'projects/workflow/sources/github', { revision: 1,
    config: { on: { 'issue.observed': { enabled: false, description: '' } } } })).toMatchObject({ status: 200, body: { revision: 2,
      config: { sources: { github: { on: { 'issue.observed': { enabled: false, description: '' } } },
        dingtalk: catalog.defaults.sources.dingtalk } } } })
  expect(h.runtime.projectEvents.settings('repository', 'issue.observed').enabled).toBe(true)
  expect(h.runtime.projectEvents.settings('github', 'issue.observed').enabled).toBe(false)
  expect(await h.api('PUT', 'projects/workflow/sources/github', { revision: 1, config: {} })).toMatchObject({ status: 409 })
  expect(await h.api('PUT', 'projects/workflow/sources/gitlab', { revision: 2, config: {} })).toMatchObject({ status: 400 })
})

it('creates a task Issue idempotently and reconciles an uncertain GitHub response', async () => {
  directory = mkdtempSync(join(tmpdir(), 'project-issue-intent-'))
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const projects = new Projects(store)
  const effects = new Effects(store, new HealthBoard())
  const api = vi.fn(), pages = vi.fn(), notify = vi.fn()
  const forRepository = vi.fn(() => ({ api, pages, deployment: { github: { login: 'robot' } } }) as unknown as Commands)
  const issues = new ProjectIssues(store, effects, { forRepository }, notify, () => true)
  try {
    let project = projects.create(ProjectInput.parse({ name: 'Pilot', repository: 'acme/pilot', status: 'planning' }))
    const change = (change: ProjectChange['change']) => { project = projects.change(project.id, ProjectChange.parse({ revision: project.revision, change })) }
    change({ kind: 'new-member', value: { name: 'Member' } })
    change({ kind: 'task', value: { title: 'Playtest', acceptance: 'Share results' } })
    change({ kind: 'task', value: { title: 'Docs' } })
    const [first, second] = project.tasks
    const channel = { source: 'dingtalk', thread: 'dingtalk:group', address: { conversationId: 'group' } }
    const request = async (taskId: string, messageId: string) => {
      issues.request({ projectId: project.id, actorId: project.members[0]!.id, taskId, messageId, channel })
      await effects.idle()
    }
    effects.start()
    expect(issues.request({ projectId: project.id, actorId: 'unknown', taskId: first!.id, messageId: 'denied', channel })).toBeTruthy()
    const firstIssue = 'https://github.com/acme/pilot/issues/13'
    api.mockResolvedValueOnce({ html_url: firstIssue })
    await request(first!.id, 'first')
    await request(first!.id, 'repeat')
    expect(api).toHaveBeenCalledOnce()
    expect(projects.detail(project.id).tasks[0]).toMatchObject({ issueUrl: firstIssue, updatedAt: first!.updatedAt })
    api.mockRejectedValueOnce(new Error('response lost after POST'))
    await request(second!.id, 'uncertain')
    const secondIssue = 'https://github.com/acme/pilot/issues/14'
    pages.mockResolvedValueOnce([{ html_url: secondIssue, user: { login: 'robot' }, body: `<!-- super-agent-task: ${project.id}/${second!.id} -->` }])
    await request(second!.id, 'recheck')
    expect(api).toHaveBeenCalledTimes(2)
    expect(pages).toHaveBeenCalledOnce()
    expect(projects.detail(project.id).tasks[1]?.issueUrl).toBe(secondIssue)
  } finally { await effects.drain(); store.close() }
})

it('lists the default and current project repositories with independent listener status', async () => {
  const h = host = await startRuntime()
  const store = h.runtime.store
  const projects = new Projects(store)
  const settings = store.settings()
  store.saveSettings({ ...settings, sources: { ...settings.sources, github: { enabled: true, config: {
    ...settings.sources.github?.config, observeIssues: true,
  } } } })
  projects.create(ProjectInput.parse({ name: 'Uses default', repository: 'acme/widgets' }))
  projects.create(ProjectInput.parse({ name: 'First project on second repo', repository: 'acme/second' }))
  let second = projects.create(ProjectInput.parse({ name: 'Second project on second repo', repository: 'acme/second' }))
  projects.create(ProjectInput.parse({ name: 'Local project' }))
  projects.create(ProjectInput.parse({ name: 'Old project', repository: 'acme/old', status: 'archived' }))
  store.set(KV.github.repositoryHealth('acme/second'), { state: 'error', detail: 'Access denied', at: new Date().toISOString() })
  const get = async () => {
    const response = await h.api('GET', 'projects/execution')
    return (response.body as unknown as ProjectExecution).github?.repositories
  }
  expect(await get()).toMatchObject([
    { repository: 'acme/second', projects: 2, configured: false, health: { state: 'error' } },
    { repository: 'acme/widgets', projects: 1, configured: true, health: { state: 'starting' } },
  ])
  second = projects.change(second.id, ProjectChange.parse({ revision: second.revision, change: { kind: 'project',
    value: { ...ProjectInput.parse({ name: second.name, repository: null }) } } }))
  expect((await get())?.[0]).toMatchObject({ repository: 'acme/second', projects: 1 })
  expect(second.repository).toBeNull()
})

it('deletes a directory member from all projects after their active work is reassigned or done', async () => {
  const h = host = await startRuntime()
  const projects = new Projects(h.runtime.store)
  const member = projects.saveMember({ name: 'Temporary member', accounts: [{ provider: 'github', scope: '', accountId: 'temp' }] })
  const other = projects.saveMember({ name: 'Other', accounts: [] })
  const attach = (name: string) => {
    const created = projects.create(ProjectInput.parse({ name }))
    return projects.change(created.id, { revision: created.revision, change: { kind: 'add-member', memberId: member.id } })
  }
  const first = attach('First')
  let second = attach('Second')
  second = projects.change(second.id, ProjectChange.parse({ revision: second.revision,
    change: { kind: 'task', value: { title: 'Task', ownerId: member.id } } }))
  const path = `members/${member.id}`
  expect(await h.api('DELETE', path)).toMatchObject({ status: 409 })
  expect(projects.detail(first.id).memberIds).toEqual([member.id])
  projects.change(second.id, { revision: second.revision, change: { kind: 'task-status', id: second.tasks[0]!.id, status: 'done' } })
  expect(await h.api('DELETE', path)).toMatchObject({ status: 200, body: { deleted: true } })
  expect(projects.members()).toEqual([other])
  expect(projects.detail(first.id).memberIds).toEqual([])
  expect(projects.detail(second.id)).toMatchObject({ members: [], tasks: [{ ownerId: member.id, status: 'done' }] })
})

it('plans work in the existing database and reads linked GitHub tickets without advancing project tasks', async () => {
  const h = host = await startRuntime()
  const created = await h.api('POST', 'projects', { name: 'Research', objective: 'Choose an approach' })
  expect(created.status).toBe(200)
  let project = created.body as unknown as ProjectDetail
  const path = `projects/${project.id}`
  const change = (change: ProjectChange['change'], revision = project.revision) => h.api('POST', `${path}/changes`, { revision, change })
  const apply = async (request: ProjectChange['change']) => {
    const result = await change(request)
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    project = result.body as unknown as ProjectDetail
  }
  expect(project.issueUrl).toBeNull()
  const legacy = 'https://github.com/acme/widgets/issues/41'
  h.runtime.store.set(KV.projects.project(project.id), { ...h.runtime.store.get(KV.projects.project(project.id))!, issueUrl: legacy })
  expect(await h.api('POST', 'projects', { name: 'Invalid', issueUrl: legacy })).toMatchObject({ status: 400 })
  await apply({ kind: 'new-member', value: { name: 'Alice', accounts: [{ provider: 'IM', scope: 'Org', accountId: 'alice' }] } })
  const alice = project.members[0]!
  expect(alice.accounts).toEqual([{ provider: 'im', scope: 'Org', accountId: 'alice' }])
  expect(await h.api('POST', 'members', { name: 'Impersonator', accounts: alice.accounts })).toMatchObject({ status: 409 })
  expect(await change({ kind: 'project', value: { name: 'Old edit' } }, 0)).toMatchObject({ status: 409 })
  await apply({ kind: 'milestone', value: { title: 'Evaluate alternatives', dueDate: '2026-11-21' } })
  await apply({ kind: 'task', value: { title: 'Collect evidence', ownerId: alice.id, milestoneId: project.milestones[0]!.id,
    dueDate: '2026-11-19', acceptance: 'Evidence is attached', issueUrl: 'https://github.com/Acme/Widgets/issues/42#issuecomment-9' } })
  const upstream = project.tasks[0]!
  expect(upstream.issueUrl).toBe('https://github.com/acme/widgets/issues/42')
  expect(await change({ kind: 'task', value: { title: 'Duplicate', issueUrl: upstream.issueUrl } })).toMatchObject({ status: 409 })
  await apply({ kind: 'task-priority', id: upstream.id, priority: 'do' })
  await apply({ kind: 'task', value: { title: 'Make decision', blockedBy: [upstream.id] } })
  const downstream = project.tasks[1]!
  expect(await change({ kind: 'task-status', id: downstream.id, status: 'in-progress' })).toMatchObject({ status: 409 })
  expect(await change({ kind: 'remove-member', memberId: alice.id })).toMatchObject({ status: 409 })
  expect(await change({ kind: 'task', id: upstream.id, value: { title: upstream.title, blockedBy: [downstream.id] } })).toMatchObject({ status: 400 })
  await apply({ kind: 'decision', value: { question: 'Which approach?', taskId: downstream.id } })
  const { ticket } = await h.acceptedTicket(issueTrigger({ number: 42, title: 'Research detail', body: '@agent-bot please investigate',
    html_url: 'https://github.com/acme/widgets/issues/42', created_at: '2026-11-16T00:00:00Z',
    user: { login: 'alice', type: 'User' } }, 'agent-bot'))
  await h.acceptedTicket(issueTrigger({ number: 41, title: 'Historical reference', body: '@agent-bot please investigate',
    html_url: legacy, created_at: '2026-11-16T00:00:00Z', user: { login: 'alice', type: 'User' } }, 'agent-bot'))
  const detail = await h.api('GET', path)
  expect(detail.body.issueUrl).toBe(legacy)
  expect(detail.body.tickets).toEqual([expect.objectContaining({ id: ticket.id, issueUrl: upstream.issueUrl })])
  expect(detail.body.tasks).toEqual(project.tasks)
  expect(await h.api('POST', `${path}/tasks/${upstream.id}/deliveries`, { messageId: 'upstream-evidence', summary: 'Collected evidence with the supporting sample' })).toMatchObject({ status: 200 })
  await h.runtime.idle()
  project = await decideCurrent(h, project.id, upstream.id)
  expect(await h.api('POST', `${path}/tasks/${downstream.id}/deliveries`, { messageId: 'downstream-evidence', summary: 'Decision comparison is ready for inspection' })).toMatchObject({ status: 200 })
  await h.runtime.idle()
  project = new Projects(h.runtime.store).detail(project.id)
  expect(await change({ kind: 'task-status', id: upstream.id, status: 'todo' })).toMatchObject({ status: 409 })
  const reopened = new Store(join(h.directory, 'orchestrator.sqlite'))
  try {
    const saved = new Projects(reopened).detail(project.id)
    expect(saved.tasks[0]).toMatchObject({ dueDate: '2026-11-19', priority: 'do', completedAt: expect.any(String) })
    expect(saved.tasks[1]).toMatchObject({ status: 'in-review', blockedBy: [upstream.id] })
    expect(saved.decisions[0]).toMatchObject({ taskId: downstream.id, answeredAt: null })
  } finally { reopened.close() }
})

it('plans from two meetings, discards stale proposals and retains task IDs', async () => {
  directory = mkdtempSync(join(tmpdir(), 'project-meeting-'))
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  try {
    const projects = new Projects(store)
    const { id } = projects.create(ProjectInput.parse({ name: 'Pilot', status: 'planning' }))
    const draft = { ref: 'new:demo', title: '实现', description: '', acceptance: '',
      assignee: 'agent', memberId: '', dependsOn: null, cancel: false }
    const propose = vi.fn()
    const planner = new ProjectPlanning(store, new Effects(store, new HealthBoard()),
      { name: 'Test planner', propose }, vi.fn(), new AbortController().signal)
    projects.saveMeetingForReview(id, '项目会议纪要：先完成实现，再验收')
    const initial = projects.meetingStatus(id).meeting!
    propose.mockRejectedValueOnce(new Error('Temporary provider error'))
      .mockResolvedValueOnce({ objective: '可试玩的首版', question: '', tasks: [draft,
        { ...draft, ref: 'new:acceptance', title: '验收', assignee: 'unassigned', dependsOn: ['new:demo'] }] })
    const request = { projectId: id, meetingId: initial.id, instruction: '' }
    expect(await planner.process('first', request)).toMatchObject({ state: 'applied' })
    const project = projects.detail(id)
    expect(project).toMatchObject({ status: 'planning', tickets: [], tasks: [
      { title: '实现', status: 'todo', ticketId: null, issueUrl: null, executionMode: 'agent' },
      { title: '验收', status: 'todo', ticketId: null, blockedBy: [project.tasks[0]!.id], executionMode: 'manual' },
    ] })
    expect(await planner.process('second-command-same-evidence', request)).toMatchObject({ state: 'unchanged' })
    expect(projects.detail(id)).toEqual(project)
    expect(propose).toHaveBeenCalledTimes(2)
    projects.saveMeetingForReview(id, '项目会议纪要：收窄验收范围')
    const second = projects.meetingStatus(id).meeting!
    const modify = { ...draft, ref: project.tasks[1]!.id, title: '', assignee: 'keep' }
    propose.mockImplementationOnce(async () => {
      projects.addMeetingReply(id, { triggerId: 'late', name: '李同学', text: '只检查合并和计分', at: '2026-11-16T00:00:00Z' }, second.id)
      return { objective: '', question: '', tasks: [{ ...modify, acceptance: '旧验收' }] }
    })
    propose.mockImplementationOnce(async (prompt: string) => {
      expect(prompt).toContain('只检查合并和计分')
      expect(prompt).toContain(project.tasks[1]!.id)
      return { objective: '', question: '', tasks: [{ ...modify, acceptance: '只检查合并和计分' }] }
    })
    expect(await planner.process('second', { ...request, meetingId: second.id })).toMatchObject({ state: 'applied' })
    expect(projects.detail(id).tasks.map(({ id, acceptance }) => [id, acceptance])).toEqual([
      [project.tasks[0]!.id, ''], [project.tasks[1]!.id, '只检查合并和计分'],
    ])
    expect(store.get(KV.projects.plan('second'))).toMatchObject({ meetingId: second.id, provider: 'Test planner' })
    expect(projects.detail(id).tickets).toEqual([])
  } finally { store.close() }
})

it('imports a Mission Control snapshot atomically and skips previously imported projects', () => {
  directory = mkdtempSync(join(tmpdir(), 'mission-control-import-'))
  const write = (name: string, value: unknown) => writeFileSync(join(directory!, `${name}.json`), JSON.stringify(value))
  write('projects', { projects: [{ id: 'p1', name: 'Experiment', description: 'Track https://github.com/acme/widgets/issues/1' },
    { id: 'p2', name: 'Second' }] })
  write('goals', { goals: [{ id: 'g1', title: 'Test a hypothesis', projectId: 'p1', timeframe: '2026-11-20' }] })
  const archived = { id: 't0', title: 'Get access', kanban: 'done', projectId: 'p1', completedAt: '2026-11-16T01:00:00Z' }
  const task = { id: 't1', title: 'Collect data', projectId: 'p1', milestoneId: 'g1', blockedBy: ['t0'], importance: 'important', urgency: 'not-urgent',
    assignedTo: 'researcher', dueDate: '2026-11-19', acceptanceCriteria: ['Link the final dataset'] }
  write('tasks-archive', { tasks: [archived] })
  write('decisions', { decisions: [{ id: 'd1', question: 'Do we continue?', taskId: 't1', options: ['Yes', 'No'] }] })
  write('tasks', { tasks: [task, { id: 't2', title: 'Invalid dependency', projectId: 'p2', blockedBy: ['t1'] }] })
  const db = new Store(join(directory, 'orchestrator.sqlite'))
  try {
    const projects = new Projects(db)
    expect(() => importMissionControl(db, directory!)).toThrow('Cannot import dependency')
    expect(projects.list()).toEqual([])
    write('tasks', { tasks: [task] })
    expect(importMissionControl(db, directory)).toEqual({ projects: 2, tasks: 2, milestones: 1, decisions: 1, skippedProjects: 0 })
    const project = projects.detail(projects.list().find(item => item.name === 'Experiment')!.id)
    expect(project).toMatchObject({ objective: 'Test a hypothesis', issueUrl: 'https://github.com/acme/widgets/issues/1', members: [] })
    expect(project.tasks[0]).toMatchObject({ status: 'done', completedAt: archived.completedAt })
    expect(project.tasks[1]).toMatchObject({ ownerId: null, blockedBy: [project.tasks[0]!.id], milestoneId: project.milestones[0]!.id,
      dueDate: '2026-11-19', priority: 'schedule', acceptance: 'Link the final dataset', description: 'Mission Control assignee: researcher' })
    expect(project.decisions[0]).toMatchObject({ taskId: project.tasks[1]!.id, answeredAt: null })
    projects.change(project.id, { revision: project.revision, change: { kind: 'project',
      value: { name: 'Edited locally', status: 'active', description: '', objective: '' } } })
    expect(importMissionControl(db, directory)).toEqual({ projects: 0, tasks: 0, milestones: 0, decisions: 0, skippedProjects: 2 })
    expect(projects.detail(project.id).name).toBe('Edited locally')
  } finally { db.close() }
})

it('dispatches a project task through the runtime and returns the ticket question and result to the task', async () => {
  const h = host = await startRuntime()
  const created = await h.api('POST', 'projects', { name: 'Pilot' })
  let project = created.body as unknown as ProjectDetail
  const path = `projects/${project.id}`
  const change = async (change: ProjectChange['change']) => {
    const result = await h.api('POST', `${path}/changes`, { revision: project.revision, change })
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    project = result.body as unknown as ProjectDetail
  }
  const issueUrl = 'https://github.com/acme/widgets/issues/42'
  await change({ kind: 'task', value: { title: 'Read a sample', issueUrl, description: 'Run a read-only inspection', acceptance: 'Provide a sample URL' } })
  const taskId = project.tasks[0]!.id
  const run = () => h.api('POST', `${path}/tasks/${taskId}/run`, { revision: project.revision })
  expect((await h.api('GET', 'projects/execution')).body).toMatchObject({ state: 'source-off' })
  expect(await run()).toMatchObject({ status: 409 })
  expect(h.runtime.store.tickets.list()).toEqual([])
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, request: { allowed: [{ id: 'local' }] } } } })
  expect((await h.api('GET', 'projects/execution')).body).toMatchObject({ state: 'ready', repository: 'acme/widgets',
    agent: { main: 'idle', health: { state: 'ready' }, load: { running: 0, queued: 0, maxWorkers: settings.executor.maxWorkers } } })
  await change({ kind: 'decision', value: { question: 'Which sample?', taskId } })
  expect(await run()).toMatchObject({ status: 409 })
  await change({ kind: 'decision', id: project.decisions[0]!.id, value: { question: 'Which sample?', taskId, answer: 'Use the latest available' } })
  const started = await run()
  expect(started.status, JSON.stringify(started.body)).toBe(200)
  project = started.body as unknown as ProjectDetail
  const ticketId = project.tasks[0]!.ticketId!
  const ticket = h.runtime.store.tickets.get(ticketId)!
  expect(ticket.mandate).toMatchObject({ strength: 'explicit', actor: { source: 'request', id: 'local' } })
  expect(ticket.channels[0]).toMatchObject({ source: 'request' })
  expect(h.runtime.store.triggers.get(ticket.origin.triggerId)).toMatchObject({ url: issueUrl, meta: { projectId: project.id, projectTaskId: taskId } })
  expect(project.tickets).toEqual([expect.objectContaining({ id: ticketId, taskId })])
  expect(await run()).toMatchObject({ status: 409 })
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  await h.runtime.idle()
  const worker = `worker-${ticketId}`
  await h.runTool(worker, 'orchestrator_report', { state: 'progress', summary: 'Sample located', human_action: 'Which baseline applies?' })
  expect((await h.api('GET', path)).body.tickets).toEqual([expect.objectContaining({ question: 'Which baseline applies?' })])
  const reply = await h.api('POST', `${path}/tasks/${taskId}/follow-up`, { ticketId, text: 'Use the current main branch.' })
  expect(reply.status, JSON.stringify(reply.body)).toBe(200)
  await h.runtime.idle()
  expect(h.relays(worker)).toContainEqual(expect.objectContaining({ text: expect.stringContaining('Use the current main branch.') }))
  await h.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Sample checked and linked.' })
  await h.runtime.pump()
  await h.runtime.idle()
  const saved = (await h.api('GET', path)).body as unknown as ProjectDetail
  expect(saved.tickets).toEqual([expect.objectContaining({ id: ticketId, reportState: 'ready', summary: 'Sample checked and linked.' })])
  expect(saved.tasks[0]!.status).toBe('in-review')
  project = saved
  project = await decideCurrent(h, project.id, taskId, 'rejected')
  await h.runtime.pump()
  await h.runtime.idle()
  expect((await h.api('GET', path)).body.tasks).toEqual([expect.objectContaining({ status: 'in-progress' })])
  expect(await run()).toMatchObject({ status: 200 })
  await h.runtime.idle()
  project = new Projects(h.runtime.store).detail(project.id)
  await h.runTool(`worker-${project.tasks[0]!.ticketId}`, 'orchestrator_report', { state: 'ready', summary: 'Corrected sample checked and linked.' })
  await h.runtime.idle()
  project = await decideCurrent(h, project.id, taskId)
  expect(project.tasks[0]!.completedAt).toBeTruthy()
  await change({ kind: 'task', value: { title: 'Review meeting notes' } })
  const withoutIssue = project.tasks.at(-1)!
  expect(withoutIssue.issueUrl).toBeNull()
  const internalRun = await h.api('POST', `${path}/tasks/${withoutIssue.id}/run`, { revision: project.revision })
  expect(internalRun.status, JSON.stringify(internalRun.body)).toBe(200)
  expect(internalRun.body.tickets).toContainEqual(expect.objectContaining({ taskId: withoutIssue.id, issueUrl: null }))
})

it('looks up a title only for an Issue in the deployment repository', async () => {
  const h = host = await startRuntime()
  const cli = vi.mocked(h.runtime.commands.gh)
  cli.mockClear()
  const preview = (url: string) => h.api('GET', `projects/issue?url=${encodeURIComponent(url)}`)
  expect(await preview('https://github.com/acme/other/issues/42')).toMatchObject({ status: 400 })
  expect(await preview('https://github.com/acme/widgets/pull/42')).toMatchObject({ status: 400 })
  expect(cli).not.toHaveBeenCalled()
  cli.mockResolvedValueOnce({ title: 'Work item', body: 'External instructions' })
  expect(await preview('https://github.com/Acme/Widgets/issues/42#issuecomment-1')).toEqual({ status: 200,
    body: { url: 'https://github.com/acme/widgets/issues/42', title: 'Work item' } })
  expect(cli).toHaveBeenLastCalledWith(['api', 'repos/acme/widgets/issues/42'])
  cli.mockResolvedValueOnce({ title: 'Pull request', pull_request: {} })
  expect(await preview('https://github.com/acme/widgets/issues/42')).toMatchObject({ status: 400 })
})

it('stores repository and conversation per project and pins each task run to its original repository', async () => {
  const h = host = await startRuntime()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: {
    ...settings.policy.sources, request: { allowed: [{ id: 'local' }] },
  } } })
  const first = (await h.api('POST', 'projects', { name: 'First', repository: 'Acme/One', dingTalkGroup: 'first-group' })).body as unknown as ProjectDetail
  const second = (await h.api('POST', 'projects', { name: 'Second', repository: 'acme/two', dingTalkGroup: 'second-group' })).body as unknown as ProjectDetail
  const local = (await h.api('POST', 'projects', { name: 'Local' })).body as unknown as ProjectDetail
  const projects = new Projects(h.runtime.store)
  expect(projects.forDingTalkGroup('first-group')).toEqual({ id: first.id, repository: 'acme/one' })
  expect(projects.forDingTalkGroup('second-group')).toEqual({ id: second.id, repository: 'acme/two' })
  expect(await h.api('POST', 'projects', { name: 'Duplicate', dingTalkGroup: 'first-group' })).toMatchObject({ status: 409 })
  expect(await h.api('POST', 'projects', { name: 'Invalid repo', repository: 'acme/..' })).toMatchObject({ status: 400 })
  const run = async (project: ProjectDetail) => {
    const path = `projects/${project.id}`
    const detail = (await h.api('POST', `${path}/changes`, { revision: project.revision, change: { kind: 'task', value: { title: 'Draft' } } }))
      .body as unknown as ProjectDetail
    const result = await h.api('POST', `${path}/tasks/${detail.tasks[0]!.id}/run`, { revision: detail.revision })
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    return result.body as unknown as ProjectDetail
  }
  const [one, two, isolated] = [await run(first), await run(second), await run(local)]
  for (const [project, repository] of [[one, 'acme/one'], [two, 'acme/two'], [isolated, null]] as const) {
    const ticket = h.runtime.store.tickets.get(project.tasks[0]!.ticketId!)!
    expect(ticket.execution?.projectRepository).toBe(repository)
    const env = h.runtime.ticketEnvironment(ticket)
    expect(env.find(variable => variable.key === 'DSH_SUPERAGENT_GITHUB_REPOSITORY')?.value).toBe(repository ?? undefined)
  }
  const updated = await h.api('POST', `projects/${first.id}/changes`, { revision: one.revision,
    change: { kind: 'project', value: { name: 'First', repository: null } } })
  expect(updated).toMatchObject({ status: 200, body: { repository: null } })
  expect(h.runtime.store.tickets.get(one.tasks[0]!.ticketId!)?.execution?.projectRepository).toBe('acme/one')
  const url = encodeURIComponent('https://github.com/acme/two/issues/8')
  vi.mocked(h.runtime.commands.gh).mockResolvedValueOnce({ title: 'Second repo issue' })
  expect(await h.api('GET', `projects/issue?projectId=${second.id}&url=${url}`)).toMatchObject({ status: 200, body: { title: 'Second repo issue' } })
  expect(await h.api('GET', `projects/issue?projectId=${local.id}&url=${url}`)).toMatchObject({ status: 409 })

  await h.runtime.idle()
  const ticketId = two.tasks[0]!.ticketId!
  const task = h.runtime.store.tickets.get(ticketId)!
  const prUrl = 'https://github.com/acme/two/pull/9'
  const pr = { html_url: prUrl, user: { login: 'agent-bot' }, state: 'open',
    head: { sha: 'sha', ref: `agent/${task.execution!.name}`, repo: { full_name: 'acme/two' } } }
  const cli = vi.mocked(h.runtime.commands.gh)
  cli.mockResolvedValueOnce(pr)
  await h.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'ready', summary: 'Finished', pr_number: 9 })
  expect(cli).toHaveBeenLastCalledWith(['api', 'repos/acme/two/pulls/9'])
  expect(projects.detail(second.id).tickets).toContainEqual(expect.objectContaining({ pullUrls: [prUrl], ended: false }))
  cli.mockResolvedValueOnce({ ...pr, state: 'closed', merged: true })
  await pollProjectPulls(h.runtime.context({ kind: 'github', health: [] }), new AbortController().signal)
  expect(h.runtime.store.tickets.get(ticketId)?.ended).toMatchObject({ outcome: 'merged' })
})

it('uses the same complete Agent for planning and execution, including after a legacy split selection', async () => {
  const agents = new RobotAgents({ codex: process.execPath, qwen: process.execPath, qoder: process.execPath, claude: process.execPath })
  const h = host = await startRuntime(undefined, undefined, undefined, undefined, agents)
  expect(await h.api('GET', 'projects/agents')).toMatchObject({ status: 200, body: { selected: 'codex',
    agents: expect.arrayContaining([expect.objectContaining({ id: 'qwen', installed: true, planning: true, execution: false })]) } })
  expect(await h.api('PUT', 'projects/agents', { planner: 'claude' })).toMatchObject({ status: 409 })
  expect(await h.api('PUT', 'projects/agents', { planner: 'qoder' })).toMatchObject({ status: 409 })
  expect(await h.api('PUT', 'projects/agents', { planner: 'qwen' })).toMatchObject({ status: 409 })
  h.runtime.store.set(KV.runtime.robotPlanner, 'qwen')
  expect((await h.api('GET', 'projects/agents')).body).toMatchObject({ selected: 'codex' })
  expect(h.runtime.projectPlanning?.planner.name).toBe('Codex')
  expect(await h.api('PUT', 'projects/agents', { planner: 'codex' })).toMatchObject({ status: 200, body: { selected: 'codex' } })
  expect(h.runtime.store.get(KV.runtime.robotPlanner)).toBe('codex')
})

it('plans a fresh discussion, notifies the reviewer after a successful run and advances dependencies after approval', async () => {
  const propose = vi.fn()
  const h = host = await startRuntime(undefined, undefined, undefined, undefined, undefined, { name: 'Test planner', propose })
  const send = vi.fn(async () => {})
  h.runtime.sources.register(dingTalkKind(send))
  const store = h.runtime.store
  const settings = store.settings()
  store.saveSettings({ ...settings, sources: { ...settings.sources, dingtalk: { enabled: true, config: {} } },
    policy: { ...settings.policy, sources: { ...settings.policy.sources, request: { allowed: [{ id: 'local' }] } } } })
  const { id } = (await h.api('POST', 'projects', { name: 'Review pilot', status: 'planning', dingTalkGroup: 'test-group' })).body as unknown as ProjectDetail
  const projects = new Projects(store)
  const path = `projects/${id}`
  const change = async (change: ProjectChange['change']) => {
    const revision = projects.detail(id).revision
    const result = await h.api('POST', `${path}/changes`, { revision, change })
    expect(result.status, JSON.stringify(result.body)).toBe(200)
  }
  await change({ kind: 'new-member', value: { name: 'Reviewer', accounts: [
    { provider: 'dingtalk', scope: 'other-company', accountId: 'other-reviewer' },
    { provider: 'dingtalk', scope: 'company', accountId: 'group-reviewer' },
  ] } })
  store.set(dingTalkRoute('test-group'), { conversationId: 'test-group', corpId: 'company', robotCode: 'bot',
    webhook: 'https://oapi.dingtalk.com/robot/send', expires: 0 })
  const reviewer = projects.detail(id).members[0]!
  projects.saveMeetingForReview(id, '项目会议纪要：先定交付方案，由 Reviewer 验收，验收后再做实现和人工评审。')
  const base = { description: '', acceptance: '提交证据', memberId: reviewer.id, dependsOn: null, cancel: false }
  propose.mockResolvedValueOnce({ objective: '交付最小方案并完成验收', question: '', tasks: [
    { ...base, ref: 'new:design', title: 'Design', assignee: 'agent' },
    { ...base, ref: 'new:implementation', title: 'Implementation', assignee: 'agent', memberId: '', dependsOn: ['new:design'] },
    { ...base, ref: 'new:manual', title: 'Manual check', assignee: 'member', dependsOn: ['new:design'] },
  ] })
  expect(await h.api('POST', `${path}/plan`, {})).toMatchObject({ status: 200, body: { state: 'applied' } })
  propose.mockImplementation(async (prompt: string) => {
    const context = JSON.parse(prompt.split('\n\n').at(-1)!)
    if (!context.message) return { summary: 'Design evidence is ready' }
    if (context.previousSteps.length) return { calls: [], reply: '已登记执行。' }
    const event = JSON.parse(context.message.text)
    const task = context.projectContext.project.tasks.find((task: { id: string }) => task.id === event.taskId)
    return task.executionMode === 'agent' ? { calls: [{ tool: 'task.start', arguments: JSON.stringify({ taskId: task.id }) }], reply: '' }
      : { calls: [], reply: 'Reviewer 可以开始「Manual check」' }
  })
  await change({ kind: 'project', value: { name: 'Review pilot', status: 'planning', autoAdvance: true } })
  await h.runtime.pump()
  expect(projects.detail(id).tickets).toEqual([])
  await change({ kind: 'project', value: { name: 'Review pilot', status: 'active', autoAdvance: true } })
  await h.runtime.pump()
  await h.runtime.idle()
  const [design, implementation, manual] = projects.detail(id).tasks
  expect([design?.status, implementation?.status, manual?.status]).toEqual(['in-progress', 'todo', 'todo'])
  expect(design?.ownerId).toBe(reviewer.id)
  await change({ kind: 'project', value: { name: 'Review pilot', status: 'active', autoAdvance: false } })
  // Restore the legacy shape with a task edit timestamp newer than the execution report.
  const legacy = store.get(KV.projects.project(id))!
  delete legacy.tasks[0]!.executionStartedAt
  legacy.tasks[0]!.updatedAt = new Date(Date.now() + 60_000).toISOString()
  store.set(KV.projects.project(id), legacy)
  await h.runTool(`worker-${design!.ticketId}`, 'orchestrator_report', { state: 'ready', summary: 'Design evidence is ready' })
  await h.runtime.pump()
  await h.runtime.idle()
  expect(projects.detail(id)).toMatchObject({ tasks: [{ status: 'in-review' }, { status: 'todo' }, { status: 'todo' }],
    tickets: [{ taskId: design!.id, ended: true }] })
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'notice',
    channel: expect.objectContaining({ address: { conversationId: 'test-group', mentionUserId: 'group-reviewer' } }),
    text: expect.stringMatching(/Design[\s\S]*待验收[\s\S]*Reviewer/) }))
  await decideCurrent(h, id, design!.id)
  await h.runtime.pump()
  await h.runtime.idle()
  expect(projects.detail(id).tasks.map(task => task.status)).toEqual(['done', 'todo', 'todo'])
  expect(send).toHaveBeenCalledTimes(3)
  await change({ kind: 'project', value: { name: 'Review pilot', status: 'active', autoAdvance: true } })
  for (let attempt = 0; attempt < 2; attempt++) { await h.runtime.pump(); await h.runtime.idle() }
  const done = projects.detail(id)
  expect(done.tasks.map(task => [task.id, task.status])).toEqual([
    [design!.id, 'done'], [implementation!.id, 'in-progress'], [manual!.id, 'todo'],
  ])
  expect(done.tickets).toHaveLength(2)
  const assignment = store.tickets.get(done.tasks[1]!.ticketId!)!
  expect(store.triggers.get(assignment.origin.triggerId)?.text).toContain('all prerequisite tasks have been accepted')
  expect(store.triggers.get(assignment.origin.triggerId)?.text).toContain('Design evidence is ready')
  expect(send).toHaveBeenCalledTimes(5)
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Reviewer 可以开始「Manual check」') }))
  await h.runTool(`worker-${done.tasks[1]!.ticketId}`, 'orchestrator_report', { state: 'failed', summary: 'Implementation failed' })
  await h.runtime.pump()
  await h.runtime.idle()
  expect(projects.detail(id).tasks[1]).toMatchObject({ status: 'in-progress' })
  expect(send).toHaveBeenCalledTimes(5)
})
