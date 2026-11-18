import { KV } from '../kv.ts'
/** Local management HTTP routes with same-origin enforcement for the web panel. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { BlockList } from 'node:net'
import { z } from 'zod'
import { MemberInput, ProjectChange, ProjectError, ProjectInput, Projects, type ProjectDetail, type ProjectExecution } from './projects.ts'
import { THREAD_FILTERS, TICKET_FILTERS, type Api, type ApiResponse, type RouteParams } from './api.ts'
import { sourceSkills } from './context.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { policyVersion } from '../policy.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { UserError, type EngineForPeople, type Ticket } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Health } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Sessions } from './sessions.ts'
import type { ProjectPlanResult } from './project-planning.ts'
import type { RobotAgentSettings } from '../harness/robot-agents.ts'
import type { Store } from './store.ts'
import type { ProjectEvents } from './project-events.ts'
import type { ProjectAgent } from './project-agent.ts'
import type { ProjectTools } from './project-tools.ts'
import { ReviewEvidence, type ProjectReviews } from './project-reviews.ts'
import { CommunicationPreference, type Communication } from './communication.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { overview } from './views/overview.ts'
import { settingsView } from './views/settings.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'
import type { ProjectProgress } from './project-progress.ts'
import type { ProjectHistory } from './project-history.ts'
import type { ProjectRepository as ProjectRepositorySync } from './project-repository.ts'

export interface HttpHost {
  readonly projectHistory?: Pick<ProjectHistory, 'view'>
  readonly projectRepository?: Pick<ProjectRepositorySync, 'retry'>
  readonly projectProgress?: Pick<ProjectProgress, 'checks'>
  readonly projectEvents?: Pick<ProjectEvents, 'view' | 'save' | 'list'>
  readonly projectAgent?: Pick<ProjectAgent, 'submit' | 'runs'>
  readonly projectTools?: Pick<ProjectTools, 'catalog' | 'snapshot'>
  readonly projectReviews?: Pick<ProjectReviews, 'submit' | 'decide'>
  readonly communication?: Pick<Communication, 'read' | 'update'>
  readonly store: Store
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels'>
  readonly engine: EngineForPeople
  readonly executor: Pick<DshExecutor, 'activeCount'>
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  configured(): boolean
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
  submitRequest(prompt: string): { trigger_id: string; status: 'stored' }
  projectExecution(): ProjectExecution
  projectIssue(url: string, projectId?: string): Promise<{ url: string; title: string }>
  updateProjectPlan(id: string, instruction: string): Promise<ProjectPlanResult>
  robotAgentSettings(): RobotAgentSettings | null
  selectRobotPlanner(id: string): RobotAgentSettings
  runProjectTask(id: string, taskId: string, revision: number): ProjectDetail
  followProjectTask(id: string, taskId: string, ticketId: string, text: string): ProjectDetail
  stopProjectTask(id: string, taskId: string, ticketId: string): ProjectDetail
}
/**
 * Represents a client-facing 400 or 404 error raised during management route parsing or lookup.
 * Route handlers throw it when request bodies are malformed or target records are missing, and registerHttp serializes its status and message in the HTTP response.
 */
class RouteError extends Error { constructor(readonly status: 400 | 404, message: string) { super(message) } }
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number, address = '127.0.0.1'): boolean {
  const host = req.headers.host
  return allowedHost(host, port, address) && panelRequest(req, `http://${host}`)
}
const panelRequest = ({ headers }: Pick<IncomingMessage, 'headers'>, origin: string) =>
  headers['x-orchestrator-request'] === '1' && (headers.origin === undefined || headers.origin === origin)
const allowedHost = (host: string | undefined, port: number, address: string) =>
  host === `${address}:${port}` || (address === '127.0.0.1' && host === `localhost:${port}`)
/** Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError) return [error.status, { error: error.message }]
  if (error instanceof ProjectError) return [error.status, { error: error.message }]
  if (error instanceof UserError) return [error.missing ? 404 : 400, { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
  return { stateDir, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get() }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  return {
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, feishuProblem: runtime.feishuProblem ?? null,
    accounts: resolved ? { repository: resolved.repository, agent: resolved.github.login, feishu: resolved.feishu ? { appId: resolved.feishu.appId, brand: resolved.feishu.brand, botId: resolved.feishu.botId, name: resolved.feishu.name } : null } : null,
  }
}
/** Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-superagent status` (`docs/006-deployment.md`). */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    masterId: runtime.masterId, paused: settings.paused, health: runtime.health }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, feishuProblem: runtime.feishuProblem })
export type StateView = ReturnType<typeof stateView>
/** Builds a ticket's detail view; `environment` is empty while waiting for setup because it requires the resolved deployment. */
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [] }
}
export type TicketPageView = ReturnType<typeof ticketPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills), skillPrefix: SKILL_PREFIX, parts, defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>
}
type Routes = { [K in keyof Api]: (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>> }
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const SourceBlock = z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor']), SourceBlock])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })

type ProjectRoute = Extract<keyof Routes, `${string} projects${string}` | `${string} members${string}`>
function projectRoutes(store: Store, host?: Pick<HttpHost, 'projectExecution' | 'projectIssue' | 'updateProjectPlan' | 'robotAgentSettings' |
  'selectRobotPlanner' | 'runProjectTask' | 'followProjectTask' | 'stopProjectTask' | 'projectEvents' | 'projectAgent' | 'projectTools' | 'projectReviews' | 'communication' | 'projectProgress' | 'projectHistory' | 'projectRepository'>): Pick<Routes, ProjectRoute> {
  const projects = new Projects(store)
  const runtime = () => {
    if (!host) throw new ProjectError(409, 'Start the full Super Agent service to run project tasks')
    return host
  }
  const ticketId = z.string().min(1).max(128)
  const events = () => {
    if (!host?.projectEvents) throw new ProjectError(409, 'Start the full Super Agent service to manage project events')
    return host.projectEvents
  }
  const agent = () => {
    if (!host?.projectAgent) throw new ProjectError(409, 'Start a connected project Agent to manage project messages')
    return host.projectAgent
  }
  return {
    'GET projects/:id/conversation-preferences': ({ params }) => {
      if (!host?.communication) throw new ProjectError(409, '沟通偏好服务尚未启动。')
      const project = projects.detail(params.id)
      return host.communication.read({ source: project.dingTalkGroup ? 'dingtalk' : 'request', thread: project.dingTalkGroup ? `dingtalk:${project.dingTalkGroup}` : project.id })
    },
    'PUT projects/:id/conversation-preferences': async ({ params, body }) => {
      if (!host?.communication) throw new ProjectError(409, '沟通偏好服务尚未启动。')
      const value = z.strictObject({ requestId: ticketId, revision: z.number().int().nonnegative(), value: CommunicationPreference }).parse(await body())
      const project = projects.detail(params.id)
      const channel = { source: 'request', thread: project.id, address: { projectId: project.id } }
      const target = project.dingTalkGroup ? { source: 'dingtalk', thread: `dingtalk:${project.dingTalkGroup}`, address: { conversationId: project.dingTalkGroup } } : channel
      return host.communication.update({ projectId: project.id, actorId: null, operationId: value.requestId, channel }, value.revision, value.value, target)
    },
    'POST projects/:id/tasks/:taskId/deliveries': async ({ params, body }) => {
      if (!host?.projectReviews) throw new ProjectError(409, '验收服务尚未启动。')
      const { messageId, ...evidence } = ReviewEvidence.extend({ messageId: ticketId }).parse(await body())
      return host.projectReviews.submit({ projectId: params.id, actorId: null, operationId: messageId,
        channel: { source: 'request', thread: params.id, address: { projectId: params.id } } }, params.taskId, evidence)
    },
    'POST projects/:id/tasks/:taskId/reviews/:reviewId': async ({ params, body }) => {
      if (!host?.projectReviews) throw new ProjectError(409, '验收服务尚未启动。')
      const value = z.strictObject({ messageId: ticketId, outcome: z.enum(['accepted', 'rejected']), reason: z.string().trim().min(1).max(8000) }).parse(await body())
      return host.projectReviews.decide({ projectId: params.id, actorId: null, operationId: value.messageId,
        channel: { source: 'request', thread: params.id, address: { projectId: params.id } } }, params.taskId, params.reviewId, value.outcome, value.reason)
    },
    'GET projects/tools': () => {
      if (!host?.projectTools) throw new ProjectError(409, 'Project management tools are unavailable')
      return host.projectTools.catalog()
    },
    'POST projects/:id/messages': async ({ params, body }) => {
      const message = z.strictObject({ messageId: ticketId.optional(), text: z.string().trim().min(1).max(26000),
        quoted: z.string().max(16000).default('') }).parse(await body())
      projects.detail(params.id)
      return agent().submit({ ...message, projectId: params.id, actorId: null, messageId: message.messageId ?? randomUUID(),
        channel: { source: 'request', thread: params.id, address: { projectId: params.id } } })
    },
    'GET projects/:id/agent-runs': ({ params }) => agent().runs(params.id),
    'GET projects/:id/checks': ({ params }) => { projects.detail(params.id); return host?.projectProgress?.checks(params.id) ?? [] },
    'GET projects/:id/history': ({ params, query }) => {
      projects.detail(params.id)
      if (!host?.projectHistory) throw new ProjectError(409, 'Project history is unavailable')
      const { before } = z.strictObject({ before: z.coerce.number().int().positive().optional() }).parse(query)
      return host.projectHistory.view(params.id, before)
    },
    'POST projects/:id/synchronization/:operationId/retry': ({ params }) => {
      projects.detail(params.id)
      const operation = store.get(KV.projects.issueSync(params.operationId))
      if (!operation || operation.projectId !== params.id) throw new ProjectError(404, 'Synchronization does not belong to this project')
      if (!host?.projectRepository) throw new ProjectError(409, 'Repository synchronization is unavailable')
      try { host.projectRepository.retry(operation.id) } catch { throw new ProjectError(409, 'Synchronization authorization changed; inspect the task first') }
      return { status: 'queued' as const }
    },
    'GET projects/workflow': () => events().view(),
    'PUT projects/workflow': async ({ body }) => {
      const update = z.strictObject({ revision: z.number().int().nonnegative(), config: z.unknown() }).parse(await body())
      return events().save(update.revision, update.config)
    },
    'GET projects/events': ({ query }) => events().list(z.strictObject({ projectId: ticketId.optional(),
      limit: z.coerce.number().int().min(1).max(200).optional() }).parse(query)),
    'GET projects': () => projects.list(),
    'POST projects': async ({ body }) => projects.create(ProjectInput.parse(await body())),
    'GET projects/issue': ({ query }) => runtime().projectIssue(z.string().trim().min(1).max(512).parse(query.url),
      z.string().min(1).max(128).optional().parse(query.projectId)),
    'GET projects/execution': () => host?.projectExecution() ?? { state: 'planning' },
    'GET projects/agents': () => host?.robotAgentSettings() ?? null,
    'PUT projects/agents': async ({ body }) => runtime().selectRobotPlanner(z.strictObject({ planner: z.string().min(1).max(80) }).parse(await body()).planner),
    'GET projects/recent-tickets': () => projects.recentTickets(),
    'GET projects/:id': ({ params }) => projects.detail(params.id),
    'POST projects/:id/changes': async ({ params, body }) => {
      const request = ProjectChange.parse(await body(256 * 1024))
      const change = request.change
      if (change.kind === 'task-status' || change.kind === 'task') {
        const current = projects.detail(params.id).tasks.find(task => task.id === change.id)
        const status = change.kind === 'task-status' ? change.status : change.value.status
        if ((!current || status !== current.status) && ['done', 'in-review'].includes(status))
          throw new ProjectError(409, '请通过交付提交或当前版本的验收入口更新状态。')
      }
      return projects.change(params.id, request)
    },
    'POST projects/:id/plan': async ({ params, body }) => {
      const { instruction } = z.strictObject({ instruction: z.string().trim().max(8000).default('') }).parse(await body())
      return runtime().updateProjectPlan(params.id, instruction)
    },
    'POST projects/:id/tasks/:taskId/run': async ({ params, body }) => {
      const { revision } = z.strictObject({ revision: count }).parse(await body())
      return runtime().runProjectTask(params.id, params.taskId, revision)
    },
    'POST projects/:id/tasks/:taskId/follow-up': async ({ params, body }) => {
      const update = z.strictObject({ ticketId, text: z.string().trim().min(1).max(8000) }).parse(await body())
      return runtime().followProjectTask(params.id, params.taskId, update.ticketId, update.text)
    },
    'POST projects/:id/tasks/:taskId/stop': async ({ params, body }) => {
      const { ticketId: ticket } = z.strictObject({ ticketId }).parse(await body())
      return runtime().stopProjectTask(params.id, params.taskId, ticket)
    },
    'GET members': () => projects.members(),
    'POST members': async ({ body }) => projects.saveMember(MemberInput.parse(await body())),
    'PUT members/:id': async ({ params, body }) => projects.saveMember(MemberInput.parse(await body()), params.id),
    'DELETE members/:id': ({ params }) => { projects.deleteMember(params.id); return { deleted: true } },
  }
}

function routes(runtime: HttpHost): Routes {
  const { store } = runtime
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  return {
    ...projectRoutes(store, runtime),
    'POST requests': async ({ body }) => {
      const request = z.object({ prompt: z.string().trim().min(1).max(runtime.machine.promptMaxChars.get()) }).strict().parse(await body())
      return runtime.submitRequest(request.prompt)
    },
    'GET state': () => stateView(runtime),
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem),
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir),
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET tickets': ({ query }) => {
      const { state, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'POST tickets/:id/retry': ({ params }) => { const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/stop': ({ params }) => { const id = ticket(params.id); runtime.engine.stopTicket(id); return { stopped: true } },
    'POST executor/pause': async ({ body }) => runtime.settings.pause(z.object({ paused: z.boolean() }).parse(await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
      if (!known) throw new RouteError(404, 'Source not found')
      const request = SaveRequest.parse(await body())
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    'GET models': () => runtime.models(),
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: Partial<Routes>, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
const projectsPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Super Agent · 项目</title>
<script src="/orchestrator/projects.js" defer></script></head>
<body><div id="superagent-projects"></div></body></html>`

async function serveProjectsPage(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  }
  if (path === '/orchestrator/projects') {
    res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' }); res.end(projectsPage); return
  }
  const script = await readFile(new URL('./projects-browser.js', import.meta.url)).catch(() => undefined)
  if (!script) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { ...headers, 'content-type': 'text/javascript; charset=utf-8' }); res.end(script)
}

interface PublicProjectGate { origin: URL; credentialHash: Buffer }
const hashCredentials = (credentials: string | Buffer) => createHash('sha256').update(credentials).digest()

function authorizePublicProject(req: IncomingMessage, res: ServerResponse, access: PublicProjectGate): boolean {
  if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== access.origin.host || req.headers['x-forwarded-proto'] !== 'https') {
    json(res, 403, { error: 'Use the configured public project address through the local HTTPS reverse proxy' })
    return false
  }
  const credential = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(req.headers.authorization ?? '')?.[1]
  if (credential && timingSafeEqual(access.credentialHash, hashCredentials(Buffer.from(credential, 'base64')))) return true
  res.setHeader('WWW-Authenticate', 'Basic realm="Super Agent Projects", charset="UTF-8"')
  json(res, 401, { error: 'Sign in to Super Agent Projects' })
  return false
}

function managementHandler(table: Partial<Routes>, ready: Promise<void>, listener: { readonly port: number },
  address = '127.0.0.1', publicGate?: PublicProjectGate, previewNetwork?: BlockList) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (address !== '127.0.0.1') {
      const peer = req.socket.remoteAddress
      if (peer !== address && !(peer && previewNetwork?.check(peer))) {
        json(res, 403, { error: previewNetwork ? 'The project preview is available from the configured local network only'
          : 'The project preview is available from this machine only' })
        return
      }
    }
    const { port } = listener
    const url = new URL(req.url ?? '/', 'http://localhost')
    const page = url.pathname === '/orchestrator/projects' || url.pathname === '/orchestrator/projects.js'
    if (!page && !url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
    if (publicGate && !authorizePublicProject(req, res, publicGate)) return
    if (page) {
      if (!publicGate && !allowedHost(req.headers.host, port, address)) { res.writeHead(403); res.end(); return }
      await serveProjectsPage(url.pathname, req, res)
      return
    }
    const allowed = publicGate ? panelRequest(req, publicGate.origin.origin) : sameOrigin(req, port, address)
    if (!allowed) { json(res, 403, { error: 'Same-origin management request required' }); return }
    try {
      await ready
      const route = match(table, req.method ?? 'GET', url.pathname.slice('/orchestrator/api/'.length).split('/'))
      if (!route) throw new RouteError(404, 'Unknown operation')
      const query = Object.fromEntries(url.searchParams)
      json(res, 200, await route.run({ params: route.params as never, query, body: maxBytes => readBody(req, maxBytes) }))
    } catch (error) { json(res, ...failure(error)) }
  }
}

export function registerHttp(ctx: Context, runtime: HttpHost): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  return ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: managementHandler(routes(runtime), runtime.ready, ctx.webServer) })
}

export interface ProjectPublicAccess { origin: URL; username: string; password: string }
interface ProjectHttpAccess { publicAccess?: ProjectPublicAccess; previewNetwork?: BlockList }

/** Project-only HTTP listener for either a local preview or the local upstream of a public HTTPS proxy. */
export function projectHttpServer(store: Store, port: number, address: string, { publicAccess, previewNetwork }: ProjectHttpAccess = {}) {
  const gate = publicAccess && { origin: publicAccess.origin, credentialHash: hashCredentials(`${publicAccess.username}:${publicAccess.password}`) }
  const handler = managementHandler(projectRoutes(store), Promise.resolve(), { port }, address, gate, previewNetwork)
  return createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (res.headersSent) res.destroy()
      else { res.writeHead(500); res.end() }
    })
  })
}
