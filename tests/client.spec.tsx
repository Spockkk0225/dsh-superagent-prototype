// @vitest-environment jsdom
import { act, useState, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError, caller, usePoll, type Call } from '../src/client/api.ts'
import { apply } from '../src/client/index.tsx'
import { zh } from '../src/client/locales.ts'
import { SettingsSchema } from '../src/policy.ts'
import { ProjectHistory } from '../src/client/project-history.tsx'
import { ProjectBoard } from '../src/client/project-board.tsx'
import { ProjectsPage } from '../src/client/projects.tsx'
import type { ProjectDetail, ProjectTask } from '../src/app/projects.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Entry = { options: { name: string; id?: string; key?: string; order?: number; locale?: string; label?: () => string }; component: ComponentType<Record<string, unknown>> }
const t = ((key: keyof typeof zh) => zh[key] ?? key) as never
function fixture(listed: string[]) {
  const entries: Entry[] = []
  const dictionaries: Record<string, unknown> = {}
  const ctx = {
    slots: { inject: (_name: string, register: () => void) => register(), register: (options: Entry['options'], component: Entry['component']) => { entries.push({ options, component }); return () => {} } },
    locale: { register: (ns: string, value: unknown) => { dictionaries[ns] = value; return () => {} }, bind: () => t },
    effect: (effect: () => unknown) => { effect() },
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: Object.fromEntries(listed.map(id => [id, {}])) }) }, refresh: vi.fn(async () => {}) },
    uiWorkspace: { openSession: vi.fn() },
    // Omit config form service so Deployment renders read-only.
    get: () => undefined,
  }
  apply(ctx as never)
  const entry = (name: string) => entries.find(item => item.options.name === name)!
  return { ctx, entries, dictionaries, main: entry('main'), nav: entry('sidebar.panellist') }
}
async function render(entry: Entry, props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<entry.component {...props} />) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { container, dispose: () => { act(() => { root.unmount() }); container.remove() } }
}
const openMaster = async (container: HTMLElement) => {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === zh.openMaster)!
  await act(async () => { button.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const serve = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
  if (path === 'overview') return Response.json({ problems: [], person: [], executor: { running: 0, queued: 0, maxWorkers: 3, idle: 0 }, flow: { triggers: 0, filtered: 0, judged: 0, accepted: 0, evaluating: 0 }, policyVersion: 'v' })
  if (path === 'state') return Response.json({ masterId: 'master', settings: SettingsSchema.parse({}), revisions: { policy: 0, eval: 0, executor: 0 }, sources: [], policy_version: 'v', health: {}, outgoing: [], load: { running: 0, queued: 0 },
    setup: { machine: { stateDir: '/srv/state', worktreeRoot: '/srv/state/worktrees', blockedCommands: [], promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }, problem: null, feishuProblem: null, accounts: null } })
  return Response.json({ error: 'unavailable' }, { status: 503 })
}))
afterEach(() => { vi.unstubAllGlobals() })

it('routes board and matrix drops to distinct changes on the same Issue-linked task', async () => {
  const task: ProjectTask = { id: 'task', title: 'Check evidence', status: 'todo', priority: 'schedule',
    description: '', ownerId: null, milestoneId: null, blockedBy: [], dueDate: null, acceptance: '', ticketId: null,
    issueUrl: 'https://github.com/acme/widgets/issues/42', createdAt: '', updatedAt: '', completedAt: null }
  const project: ProjectDetail = { id: 'project', name: 'Research', status: 'active', objective: '', description: '',
    revision: 0, createdAt: '', updatedAt: '', issueUrl: null, memberIds: [], members: [], tasks: [task], milestones: [], decisions: [], tickets: [] }
  const select = vi.fn(), moveStatus = vi.fn(), movePriority = vi.fn()
  async function check(view: 'kanban' | 'priority', source: string, target: string) {
    const page = await render({ options: { name: view }, component: () => <ProjectBoard t={t} view={view} project={project}
      tasks={project.tasks} pending={false} select={select} moveStatus={moveStatus} movePriority={movePriority} /> }, {})
    try {
      const card = page.container.querySelector<HTMLButtonElement>(`[data-column="${source}"] .dt-kanban-task`)!
      const lane = page.container.querySelector(`[data-column="${target}"]`)!
      expect(card.textContent).toContain('acme/widgets#42')
      const values = new Map<string, string>()
      const dataTransfer = { get types() { return [...values.keys()] },
        setData: (type: string, data: string) => { values.set(type, data) }, getData: (type: string) => values.get(type) }
      const drag = (node: Element, name: string) => act(() => { node.dispatchEvent(Object.assign(
        new Event(name, { bubbles: true, cancelable: true }), { dataTransfer })) })
      drag(card, 'dragstart'); drag(lane, 'dragover')
      expect(lane.getAttribute('data-over')).toBe('true')
      drag(lane, 'drop')
    } finally { page.dispose() }
  }
  await check('kanban', 'todo', 'in-progress')
  expect(moveStatus).toHaveBeenCalledExactlyOnceWith(task, 'in-progress')
  expect(movePriority).not.toHaveBeenCalled()
  await check('priority', 'schedule', 'do')
  expect(movePriority).toHaveBeenCalledExactlyOnceWith(task, 'do')
})

it('opens one project section at a time and saves an internal task without an issue', async () => {
  const project: ProjectDetail = { id: 'workspace', name: 'Research', status: 'active', objective: '', description: '', repository: 'acme/research',
    revision: 0, createdAt: '', updatedAt: '', issueUrl: null, memberIds: [], members: [], tasks: [], milestones: [],
    decisions: [{ id: 'decision', question: 'Use main?', taskId: null, context: 'The baseline is stable.',
      answer: 'Use the latest stable commit.', answeredAt: '2026-11-16T00:00:00Z' }],
    tickets: [{ id: 'waiting', title: 'Awaiting approval', stage: 'person', action: 'answer', updatedAt: '', ended: false,
      issueUrl: null, taskId: null, summary: '', reportState: null, question: null, pullUrls: [] }] }
  const agents = { selected: 'codex', agents: [{ id: 'codex', name: 'Codex', installed: true, planning: true, execution: true },
    { id: 'qwen', name: 'Qwen Code', installed: true, planning: true, execution: false },
    { id: 'qoder', name: 'Qoder', installed: true, planning: true, execution: false },
    { id: 'claude', name: 'Claude Code', installed: true, planning: false, execution: false }] }
  const call = vi.fn(async (route: string, request?: { body: { change: { value: Pick<ProjectTask, 'title' | 'issueUrl'> } } }) => {
    if (route === 'GET projects') return [project]
    if (route === 'GET members') return []
    if (route === 'GET projects/execution') return { state: 'ready', github: { authenticated: true, watchingRepository: true, repositories: [
      { repository: 'acme/shared', projects: 2, configured: false, health: { state: 'ready', detail: '' } },
      { repository: 'acme/separate', projects: 1, configured: false, health: { state: 'error', detail: 'Repository access denied' } },
    ] },
      connections: { github: { state: 'paused', detail: 'Off', code: 'sourceOff' } },
      agent: { main: 'running', load: { running: 2, queued: 1, maxWorkers: 4 } } }
    if (route === 'GET projects/agents') return { ...agents }
    if (route === 'POST projects/:id/changes') {
      project.tasks.push({ id: 'task', ...request!.body.change.value, description: '', status: 'todo', priority: 'eliminate',
        acceptance: '', ownerId: null, milestoneId: null, dueDate: null, blockedBy: [], ticketId: null,
        createdAt: '', updatedAt: '', completedAt: null })
    }
    return project
  })
  const page = await render({ options: { name: 'projects' }, component: () => <ProjectsPage t={t} call={call as unknown as Call} /> }, {})
  const nav = (label: string) => [...page.container.querySelectorAll<HTMLButtonElement>('.dt-work-section-link')]
    .find(button => button.textContent === label)!
  const content = () => page.container.querySelector('.dt-work-main')!.textContent
  try {
    expect(content()).toContain(zh['project.firstTask'])
    expect(content()).not.toContain('Use main?')
    await act(async () => { nav(zh['project.decisions']).click() })
    expect(nav(zh['project.decisions']).getAttribute('aria-current')).toBe('page')
    expect(content()).toContain('Use the latest stable commit.')
    expect(content()).not.toContain(zh['project.firstTask'])
    await act(async () => { nav(zh['project.agentStatus']).click() })
    expect(page.container.querySelector('.dt-work-sections')).toBeNull()
    expect(page.container.querySelector('.dt-work-global')?.contains(nav(zh['project.agentStatus']))).toBe(true)
    expect(content()).toContain('2 / 4')
    expect(content()).toContain(zh['project.session.running'])
    const agentPanel = page.container.querySelector('[aria-label="本机 Agent"]')!
    expect(agentPanel.textContent).toContain(`${zh['project.robotAgent']}Codex`)
    expect(agentPanel.querySelector('select')).toBeNull()
    expect(content()).toContain(zh['project.agentNotIntegrated'])
    const watches = page.container.querySelector('.dt-repository-status')!
    expect(watches.textContent).toContain('acme/shared')
    expect(watches.textContent).toContain('acme/separate')
    expect(watches.textContent).toContain(zh['project.connectionState.ready'])
    expect(watches.textContent).toContain('Repository access denied')
    expect(content()).toContain(zh['project.githubAuthenticated'])
    expect(content()).not.toContain('acme/research')
    expect(content()).not.toContain(zh['project.needsHuman'])
    expect(content()).not.toContain(zh['project.connectionState.paused'])
    await act(async () => { page.container.querySelector<HTMLButtonElement>('.dt-work-nav-item')!.click() })
    expect(content()).toContain('Use the latest stable commit.')
    await act(async () => { nav(zh['project.tickets']).click() })
    expect(content()).toContain(zh['project.needsHuman'])
    expect(content()).toContain('Awaiting approval')
    await act(async () => { nav(zh['project.tasks']).click() })
    expect(content()).toContain('acme/research')
    const add = [...page.container.querySelectorAll('button')].find(button => button.textContent === zh['project.addTask'])!
    await act(async () => { add.click() })
    const form = document.querySelector<HTMLFormElement>('[role="dialog"] form')!
    expect(form.querySelector<HTMLInputElement>('[name="issueUrl"]')?.required).toBe(false)
    form.querySelector<HTMLInputElement>('[name="title"]')!.value = 'Meeting follow-up'
    await act(async () => { form.requestSubmit() })
    expect(call).toHaveBeenCalledWith('POST projects/:id/changes', expect.objectContaining({ body: expect.objectContaining({
      change: expect.objectContaining({ value: expect.objectContaining({ title: 'Meeting follow-up', issueUrl: null }) }),
    }) }))
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(zh['project.noIssue'])
  } finally { page.dispose() }
})

it('shows review evidence and retains the original delivery ID and request ID when a stale review form is retried', async () => {
  const task: ProjectTask = { id: 'task', title: 'Check delivery', status: 'in-review', priority: 'do',
    description: '', ownerId: null, milestoneId: null, blockedBy: [], dueDate: null, acceptance: 'Current criteria', ticketId: null,
    issueUrl: null, createdAt: '', updatedAt: '', completedAt: null, deliveryVersion: 1, reviews: [{ id: 'review-original', version: 1,
      requestedAt: '2026-11-17T00:00:00Z', status: 'pending', requirements: { title: 'Check delivery', description: '', acceptance: 'Original review criteria', ownerId: null },
      evidence: { summary: 'Actual evidence from this delivery', links: ['https://example.com/result'] } }] }
  const project: ProjectDetail = { id: 'project', name: 'Review project', status: 'active', objective: '', description: '',
    revision: 1, createdAt: '', updatedAt: '', issueUrl: null, memberIds: [], members: [], tasks: [task], milestones: [], decisions: [], tickets: [] }
  const call = vi.fn(async (route: string, _request?: unknown) => {
    if (route === 'GET projects') return [project]
    if (route === 'GET members') return []
    if (route === 'GET projects/agents') return null
    if (route === 'GET projects/execution') return { state: 'ready' }
    if (route === 'POST projects/:id/tasks/:taskId/reviews/:reviewId') throw new ApiError('This review has changed', 409)
    return project
  })
  const page = await render({ options: { name: 'reviews' }, component: () => <ProjectsPage t={t} call={call as unknown as Call} /> }, {})
  try {
    await act(async () => { page.container.querySelector<HTMLButtonElement>('.dt-kanban-task')!.click() })
    const detail = document.querySelector('[role="dialog"]')!
    expect(detail.textContent).toContain('Actual evidence from this delivery')
    expect(detail.textContent).toContain('Original review criteria')
    expect(detail.querySelector('a[href="https://example.com/result"]')).not.toBeNull()
    expect(detail.textContent).toContain(zh['project.rejectDelivery'])
    await act(async () => { [...detail.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === zh['project.acceptTask'])!.click() })
    const form = document.querySelector<HTMLFormElement>('[role="dialog"] form')!
    const reason = form.querySelector<HTMLTextAreaElement>('[name="reason"]')!
    expect(reason.required).toBe(true)
    reason.value = 'I checked this delivery against its criteria'
    const requestId = form.querySelector<HTMLInputElement>('[name="messageId"]')!.value
    project.tasks = [{ ...task, deliveryVersion: 2, reviews: [{ ...task.reviews![0]!, id: 'review-new', version: 2 }] }]
    await act(async () => { form.requestSubmit() })
    expect(form.textContent).toContain('This review has changed')
    await act(async () => { form.requestSubmit() })
    const writes = call.mock.calls.filter(([route]) => route === 'POST projects/:id/tasks/:taskId/reviews/:reviewId')
    expect(writes).toHaveLength(2)
    for (const write of writes) expect(write[1]).toEqual({ id: 'project', taskId: 'task', reviewId: 'review-original',
      body: { messageId: requestId, outcome: 'accepted', reason: 'I checked this delivery against its criteria' } })
  } finally { page.dispose() }
})

it('opens workspace Agent status with an empty project list', async () => {
  const call = vi.fn(async (route: string) => {
    if (route === 'GET projects/execution') return { state: 'ready', planner: 'Codex',
      connections: { dingtalk: { state: 'ready' } }, agent: { main: 'idle', load: { running: 0, queued: 0, maxWorkers: 2 } } }
    if (route === 'GET projects/agents') return { selected: 'codex', agents: [] }
    return []
  })
  const page = await render({ options: { name: 'projects' }, component: () => <ProjectsPage t={t} call={call as unknown as Call} /> }, {})
  try {
    expect(page.container.textContent).toContain(zh['project.noProjects'])
    const entry = [...page.container.querySelectorAll<HTMLButtonElement>('.dt-work-global button')]
      .find(button => button.textContent === zh['project.agentStatus'])!
    await act(async () => { entry.click() })
    expect(entry.getAttribute('aria-current')).toBe('page')
    expect(page.container.querySelector('.dt-work-runtime')?.textContent).toContain('0 / 2')
    expect(page.container.querySelector('.dt-work-runtime')?.textContent).toContain(zh['project.connection.dingtalk'])
    expect(call).not.toHaveBeenCalledWith('GET projects/:id', expect.anything())
  } finally { page.dispose() }
})

it('registers a localized main panel, sidebar entry and Plugin Manager row page, and no settings section', () => {
  const { entries, dictionaries, main, nav } = fixture([])
  expect(entries.map(entry => entry.options.name)).toEqual(['main', 'sidebar.panellist', 'plugins.row.config'])
  expect(entries[2]!.options).toMatchObject({ key: 'dsh-superagent#dsh-superagent', locale: 'dshSuperagent' })
  expect(Object.keys(dictionaries)).toEqual(['dshSuperagent'])
  expect(main.options).toMatchObject({ key: 'dsh-superagent', locale: 'dshSuperagent' })
  expect(nav.options).toMatchObject({ id: 'dsh-superagent', order: 10, locale: 'dshSuperagent' })
  expect(nav.options.label?.()).toBe('Superagent')
})

it('opens a listed Session through the workspace from the main panel', async () => {
  serve()
  const { ctx, main } = fixture(['master'])
  const view = await render(main, { t })
  await openMaster(view.container)
  expect(ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith('master')
  view.dispose()
})

it('reports a Session missing from the catalog in the interface language', async () => {
  serve()
  const { ctx, main } = fixture([])
  const view = await render(main, { t })
  await openMaster(view.container)
  expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(zh.sessionNotListed)
  view.dispose()
})

it('polls one request at a time, keeps the data while new dependencies load, and polls less while hidden', async () => {
  vi.useFakeTimers()
  const calls: { limit: number; done: (value: string[]) => void }[] = []
  let shown: { data?: string[]; limit: number } = { limit: 0 }
  let setLimit = (_limit: number) => {}
  function Harness() {
    const [limit, update] = useState(1)
    setLimit = update
    const { data } = usePoll(() => new Promise<string[]>(done => { calls.push({ limit, done }) }), [limit], 1000)
    shown = { ...data ? { data } : {}, limit }
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => { root.render(<Harness />) })
  expect(calls).toHaveLength(1)
  // A slow response holds the next poll back instead of overlapping.
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(1)
  await act(async () => { calls[0]!.done(['a']) })
  expect(shown.data).toEqual(['a'])
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(calls).toHaveLength(2)
  await act(async () => { setLimit(2) })
  expect(shown).toEqual({ data: ['a'], limit: 2 })
  await act(async () => { calls[2]!.done(['a', 'b']) })
  expect(shown.data).toEqual(['a', 'b'])
  // A late response to the superseded request must not replace the newer result.
  await act(async () => { calls[1]!.done(['stale']) })
  expect(shown.data).toEqual(['a', 'b'])
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  await act(async () => { calls[3]!.done(['a', 'b']) })
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(4)
  hidden.mockRestore()
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(calls).toHaveLength(5)
  act(() => { root.unmount() })
  vi.useRealTimers()
})

it('tells a dsh-superagent that does not answer from a record it does not have, and words each failure by what failed', async () => {
  const messages = { offline: 'offline', notRunning: 'not running', serverError: (status: number) => `server ${status}`,
    requestFailed: (status: number) => `request ${status}`, setup: () => 'setup', user: ({ code }: { code: string }) => `user ${code}` }
  const call = caller(() => messages)
  const failure = async (answer: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(answer))
    const error = await call('GET tickets/:id', { id: 't1' }).then(() => undefined, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ApiError)
    const { message, status, missing, details } = error as ApiError
    return { message, status, missing, unreachable: !!details.unreachable }
  }
  expect(await failure(async () => { throw new TypeError('Failed to fetch') })).toEqual({ message: 'offline', status: 0, missing: false,
    unreachable: true })
  // DSH's web server answers an empty 404 while dsh-superagent's routes are unregistered.
  expect(await failure(async () => new Response(null, { status: 404 }))).toEqual({ message: 'not running', status: 404, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response(null, { status: 502 }))).toEqual({ message: 'server 502', status: 502, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response('<html>Bad request</html>', { status: 400 }))).toEqual({ message: 'request 400',
    status: 400, missing: false, unreachable: false })
  expect(await failure(async () => Response.json({ error: 'Unknown ticket', code: 'unknownTicket' }, { status: 404 }))).toEqual({
    message: 'user unknownTicket', status: 404, missing: true, unreachable: false })
})

it('shows causal history and confirmed Agent results, retains sync failure, and retries the original operation', async () => {
  const project = { id: 'history-project', tasks: [{ id: 'b', title: '实现 2048' }] } as ProjectDetail
  let retried = false
  const call = vi.fn(async (route: string, input: Record<string, unknown>) => {
    if (route.startsWith('POST')) { expect(input).toEqual({ id: project.id, operationId: 'close-1' }); retried = true; return { status: 'queued' } }
    return { entries: [{ event: { seq: 12, type: 'project.changed', source: 'history', status: 'applied', recordedAt: '2026-11-18T04:00:00Z',
      causeId: 'message-1', data: { tasks: ['b'] } }, label: '项目变更已提交', reason: '已保存真实修改', decisions: [{ id: 'run-1', status: 'completed',
      reply: '已保存交付要求。', steps: [{ provider: 'Codex', calls: [{ tool: 'task.update' }], results: [{ summary: '已更新原任务' }] }] }] }], next: null,
      notifications: [{ id: 'notice-1', origin: { projectId: project.id, eventId: 'message-1' }, source: 'dingtalk', format: 'markdown', status: 'sent', text: '已发送真实结果' }], remote: [], checks: [], synchronization: [{ id: 'close-1', taskId: 'b', url: 'https://github.com/acme/widgets/issues/1', status: retried ? 'pending' : 'failed',
        reason: retried ? '已登记重新核对' : 'GitHub 权限不足', attempts: 1, updatedAt: '2026-11-18T04:00:00Z' }] }
  }) as unknown as Call
  const page = await render({ options: { name: 'History' }, component: () => <ProjectHistory call={call} t={t} project={project} /> }, {})
  try {
    expect(page.container.textContent).toContain('已发送真实结果')
    expect(page.container.textContent).toContain('接口已接受')
    expect(page.container.textContent).toContain('GitHub 权限不足')
    expect(page.container.textContent).toContain('已保存交付要求。')
    expect(page.container.textContent).toContain('已更新原任务')
    expect(page.container.querySelector('pre')?.textContent).toContain('b')
    const retry = [...page.container.querySelectorAll('button')].find(button => button.textContent === zh['project.retrySync'])!
    await act(async () => { retry.click() })
    expect(retried).toBe(true)
    expect(page.container.textContent).toContain('已登记重新核对')
    expect([...page.container.querySelectorAll('button')].some(button => button.textContent === zh['project.retrySync'])).toBe(false)
  } finally { page.dispose() }
})
