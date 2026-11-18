/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'
import type { Member, MemberInput, ProjectChange, ProjectDetail, ProjectExecution, ProjectInput, ProjectSummary, ProjectTicket } from './projects.ts'
import type { ProjectPlanResult } from './project-planning.ts'
import type { RobotAgentSettings } from '../harness/robot-agents.ts'
import type { ProjectEvents, ProjectWorkflowConfig } from './project-events.ts'
import type { ProjectEvent } from '../sources/project-events.ts'
import type { ProjectAgent, ProjectAgentRun } from './project-agent.ts'
import type { ProjectTools } from './project-tools.ts'
import type { ProjectReviews } from './project-reviews.ts'
import type { Communication, CommunicationPreference, ConversationPreference } from './communication.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface Api {
  'POST requests': { body: { prompt: string }; response: { trigger_id: string; status: 'stored' } }
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET projects': { response: ProjectSummary[] }
  'GET projects/tools': { response: ReturnType<ProjectTools['catalog']> }
  'GET projects/:id/conversation-preferences': { response: ConversationPreference }
  'PUT projects/:id/conversation-preferences': { body: { requestId: string; revision: number; value: CommunicationPreference }; response: ReturnType<Communication['update']> }
  'POST projects/:id/messages': { body: { messageId?: string; text: string; quoted?: string }; response: ReturnType<ProjectAgent['submit']> }
  'GET projects/:id/agent-runs': { response: ProjectAgentRun[] }
  'GET projects/:id/checks': { response: import('./project-progress.ts').ProjectCheck[] }
  'GET projects/:id/history': { query?: { before?: number }; response: ReturnType<import('./project-history.ts').ProjectHistory['view']> }
  'POST projects/:id/synchronization/:operationId/retry': { response: { status: 'queued' } }
  'POST projects/:id/tasks/:taskId/deliveries': { body: { messageId: string; summary: string; links?: string[] }; response: ReturnType<ProjectReviews['submit']> }
  'POST projects/:id/tasks/:taskId/reviews/:reviewId': { body: { messageId: string; outcome: 'accepted' | 'rejected'; reason: string }; response: ReturnType<ProjectReviews['decide']> }
  'GET projects/workflow': { response: ReturnType<ProjectEvents['view']> }
  'PUT projects/workflow': { body: { revision: number; config: Partial<ProjectWorkflowConfig> }; response: ReturnType<ProjectEvents['view']> }
  'PUT projects/workflow/sources/:source': { body: { revision: number; config: ProjectWorkflowConfig['sources'][string] }; response: ReturnType<ProjectEvents['view']> }
  'GET projects/events': { query: { projectId?: string; limit?: number }; response: ProjectEvent[] }
  'POST projects': { body: ProjectInput; response: ProjectDetail }
  'GET projects/issue': { query: { url: string; projectId?: string }; response: { url: string; title: string } }
  'GET projects/execution': { response: ProjectExecution }
  'GET projects/agents': { response: RobotAgentSettings | null }
  'PUT projects/agents': { body: { planner: string }; response: RobotAgentSettings }
  'GET projects/recent-tickets': { response: ProjectTicket[] }
  'GET projects/:id': { response: ProjectDetail }
  'POST projects/:id/changes': { body: ProjectChange; response: ProjectDetail }
  'POST projects/:id/plan': { body: { instruction?: string }; response: ProjectPlanResult }
  'POST projects/:id/tasks/:taskId/run': { body: { revision: number }; response: ProjectDetail }
  'POST projects/:id/tasks/:taskId/follow-up': { body: { ticketId: string; text: string }; response: ProjectDetail }
  'POST projects/:id/tasks/:taskId/stop': { body: { ticketId: string }; response: ProjectDetail }
  'GET members': { response: Member[] }
  'POST members': { body: MemberInput; response: Member }
  'PUT members/:id': { body: MemberInput; response: Member }
  'DELETE members/:id': { response: { deleted: true } }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
