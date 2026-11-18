/** Project planning records share the runtime store. Execution authority stays with the Engine. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { latestReport, type ReportState, type Ticket } from '../core/model.ts'
import { ticketStage, type TicketStage } from '../core/stage.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { KV, type Family } from '../kv.ts'
import type { Health } from '../sources/host.ts'
import type { Store } from './store.ts'
import type { ExecutorLoad } from './views/tickets.ts'
import { currentReview, deliveryScopeChanged, nextDelivery, type DeliveryEvidence, type ProjectReview } from './project-deliveries.ts'

const title = z.string().trim().min(1).max(200)
const description = z.string().trim().max(8000)
const longText = z.string().trim().max(26_000)
const id = z.string().min(1).max(128)
export const ProjectRepository = z.string().trim().transform(value => {
  const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/?$/i.exec(value)
  return url ? url[1]!.replace(/\.git$/i, '') : value
}).pipe(z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/, 'owner/name')
  .refine(value => !/\/\.{1,2}$/.test(value), 'owner/name').transform(value => value.toLowerCase()))
const ids = z.array(id).max(100)
const dueDate = z.iso.date().nullable()
const issue = z.string().trim().transform((url, ctx) => {
  const parsed = githubIssueUrl(url)
  if (parsed) return parsed
  ctx.addIssue({ code: 'custom', message: 'Use a GitHub issue URL such as https://github.com/owner/repo/issues/42' })
  return z.NEVER
}).nullable()

export function githubIssueUrl(url: string): string | undefined {
  const match = /^https:\/\/github\.com\/([\w-]+\/[\w.-]+)\/issues\/([1-9]\d*)\/?(?:#[\w-]+)?$/i.exec(url)
  if (match && !/\/\.{1,2}$/.test(match[1]!) && Number.isSafeInteger(Number(match[2])))
    return `https://github.com/${match[1]!.toLowerCase()}/issues/${match[2]}`
}

const account = z.strictObject({
  provider: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9-]{0,31}$/),
  scope: z.string().trim().max(128),
  accountId: z.string().trim().min(1).max(128),
})
export const MemberInput = z.strictObject({ name: title, accounts: z.array(account).max(10).default([]) })
export type MemberInput = z.input<typeof MemberInput>
export type Member = z.output<typeof MemberInput> & { id: string }

export const ProjectInput = z.strictObject({
  name: title, description: description.default(''), objective: description.default(''),
  status: z.enum(['planning', 'active', 'paused', 'completed', 'archived']).default('active'),
  repository: ProjectRepository.nullable().optional(),
  dingTalkGroup: z.string().trim().min(1).max(300).nullable().optional(),
  autoAdvance: z.boolean().optional(),
})
export type ProjectInput = z.input<typeof ProjectInput>
const Priority = z.enum(['do', 'schedule', 'delegate', 'eliminate'])
export type ProjectPriority = z.infer<typeof Priority>
const defaultPriority = 'eliminate' as const
export const TaskInput = z.strictObject({
  title, description: longText.default(''), status: z.enum(['todo', 'in-progress', 'in-review', 'done', 'cancelled']).default('todo'),
  ownerId: id.nullable().default(null), milestoneId: id.nullable().default(null), blockedBy: ids.default([]),
  dueDate: dueDate.default(null), acceptance: longText.default(''), issueUrl: issue.default(null), ticketId: id.nullable().default(null),
  priority: Priority.default(defaultPriority),
  executionMode: z.enum(['manual', 'agent']).nullable().default(null),
  issueRole: z.enum(['reference', 'resolve']).optional(),
  deliveryMode: z.enum(['report', 'pull-request']).optional(),
  pullRequestUrl: z.string().regex(/^https:\/\/github\.com\/[\w-]+\/[\w.-]+\/pull\/[1-9]\d*$/).nullable().optional(),
  targetBranch: z.string().trim().min(1).max(200).nullable().optional(),
})
const MilestoneInput = z.strictObject({
  title, dueDate: dueDate.default(null), status: z.enum(['open', 'done', 'cancelled']).default('open'),
})
const DecisionInput = z.strictObject({
  question: z.string().trim().min(1).max(500), context: longText.default(''), answer: description.default(''), taskId: id.nullable().default(null),
})
export const ProjectChange = z.strictObject({
  revision: z.number().int().nonnegative(),
  change: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('project'), value: ProjectInput }),
    z.strictObject({ kind: z.literal('add-member'), memberId: id }),
    z.strictObject({ kind: z.literal('new-member'), value: MemberInput }),
    z.strictObject({ kind: z.literal('remove-member'), memberId: id }),
    z.strictObject({ kind: z.literal('task'), id: id.optional(), value: TaskInput }),
    z.strictObject({ kind: z.literal('task-status'), id, status: TaskInput.shape.status.removeDefault() }),
    z.strictObject({ kind: z.literal('task-priority'), id, priority: Priority }),
    z.strictObject({ kind: z.literal('task-ticket'), id, ticketId: id.nullable() }),
    z.strictObject({ kind: z.literal('milestone'), id: id.optional(), value: MilestoneInput }),
    z.strictObject({ kind: z.literal('decision'), id: id.optional(), value: DecisionInput }),
  ]),
})
export type ProjectChange = z.input<typeof ProjectChange>
export type ProjectTask = Omit<z.output<typeof TaskInput>, 'executionMode'> & {
  id: string; createdAt: string; updatedAt: string; completedAt: string | null; executionMode?: 'manual' | 'agent' | null
  executionStartedAt?: string
  deliveryVersion?: number
  reviews?: ProjectReview[]
}
export type ProjectMilestone = z.output<typeof MilestoneInput> & { id: string }
export type ProjectEvidence = { triggerId: string; source?: string; messageId?: string; memberId?: string; name: string; at: string }
export type ProjectMeetingReply = ProjectEvidence & { text: string }
export type ProjectDecision = z.output<typeof DecisionInput> & {
  id: string; answeredAt: string | null; meetingSource?: ProjectEvidence; meetingReplies?: ProjectMeetingReply[]; initialMeeting?: true
}
export type Project = z.output<typeof ProjectInput> & {
  id: string; revision: number; createdAt: string; updatedAt: string; memberIds: string[]
  repositoryLinkedAt?: string
  /** Historical reference retained for projects created before Issues moved to tasks. */
  issueUrl: string | null
  tasks: ProjectTask[]; milestones: ProjectMilestone[]; decisions: ProjectDecision[]
}
export type ProjectSummary = Omit<Project, 'tasks' | 'milestones' | 'decisions' | 'memberIds'> & {
  taskCount: number; completedCount: number; memberCount: number; pendingCount: number
}
export type ProjectDetail = Project & {
  members: Member[]
  tickets: ProjectTicket[]
}
export type ProjectTicket = TicketStage & { id: string; title: string; updatedAt: string; ended: boolean; issueUrl: string | null;
  taskId: string | null; summary: string; reportState: ReportState | null;
  question: string | null; pullUrls: string[]; runner?: string }
export type ProjectExecution = {
  state: 'planning' | 'setup' | 'paused' | 'source-off' | 'ready'; repository?: string
  agent?: { main: 'idle' | 'running' | 'unavailable'; health?: Health; load: ExecutorLoad & { maxWorkers: number } }
  connections?: { dingtalk?: Health; github?: Health }
  github?: { authenticated: boolean; watchingRepository: boolean; repositories?: GithubWatchStatus[] }
  planner?: string
}
export type GithubWatchStatus = { repository: string; configured: boolean; projects: number; health: Health }

/** A project operation that was invalid, missing, or conflicted with existing state. */
export class ProjectError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message) }
}

const isoNow = () => new Date().toISOString()
const MEETING_QUESTION = '确认会议纪要和任务分工'
const isMeeting = (decision: ProjectDecision) => decision.meetingReplies !== undefined
  || decision.question === MEETING_QUESTION && decision.context.startsWith('项目会议纪要')
const active = (task: Pick<ProjectTask, 'status'>) => task.status !== 'done' && task.status !== 'cancelled'
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
const accountKey = ({ provider, scope, accountId }: Member['accounts'][number]) => JSON.stringify([provider, scope, accountId])

function requireRecord<T extends { id: string }>(items: T[], key: string, label: string): T {
  const item = items.find(value => value.id === key)
  if (!item) throw new ProjectError(404, `${label} not found`)
  return item
}

/** Reject references outside the project and dependency cycles. */
export function validateDependencies(tasks: ProjectTask[], changed: ProjectTask): void {
  const entries = new Map(tasks.map(task => [task.id, task]))
  const pending = [...changed.blockedBy]
  const seen = new Set<string>()
  while (pending.length) {
    const key = pending.pop()!
    if (key === changed.id) throw new ProjectError(400, 'Task dependencies cannot form a cycle')
    if (seen.has(key)) continue
    seen.add(key)
    const task = entries.get(key)
    if (!task) throw new ProjectError(400, 'Dependencies must be tasks in this project')
    pending.push(...task.blockedBy)
  }
}

/** Owns the planning aggregates and checks every change against the current project revision. */
export class Projects {
  constructor(private readonly store: Store) {}

  private records<T>(family: Family<T, [string]>): T[] {
    return this.store.keys(family).flatMap(key => this.store.get(key) ?? [])
  }

  list(): ProjectSummary[] {
    return this.records(KV.projects.project).map(({ tasks, milestones: _milestones, decisions, memberIds, dingTalkGroup: _group, ...project }) => ({
      ...project, taskCount: tasks.filter(task => task.status !== 'cancelled').length,
      completedCount: tasks.filter(task => task.status === 'done').length,
      memberCount: memberIds.length, pendingCount: decisions.filter(decision => !decision.answeredAt).length,
    })).sort(byName)
  }

  members(): Member[] { return this.records(KV.projects.member).sort(byName) }

  repositoryBindings(): { repository: string; since: string }[] {
    return this.records(KV.projects.project).flatMap(project => project.repository && project.status !== 'archived'
      ? [{ repository: project.repository, since: project.repositoryLinkedAt ?? project.createdAt }] : [])
  }

  forDingTalkGroup(group: string): { id: string; repository: string | null } | undefined {
    const project = this.records(KV.projects.project).find(project => project.dingTalkGroup === group && project.status !== 'archived')
    return project && { id: project.id, repository: project.repository ?? null }
  }

  private checkDingTalkGroup(group?: string | null, projectId?: string): void {
    if (group && this.records(KV.projects.project).some(project => project.id !== projectId && project.dingTalkGroup === group))
      throw new ProjectError(409, 'This DingTalk group is already linked to another project')
  }

  memberForAccount(projectId: string, provider: string, scope: string, accountId: string): Member | undefined {
    const project = this.require(projectId)
    const member = this.directoryMemberForAccount(provider, scope, accountId)
    return member && project.memberIds.includes(member.id) ? member : undefined
  }

  directoryMemberForAccount(provider: string, scope: string, accountId: string): Member | undefined {
    const key = accountKey({ provider, scope, accountId })
    return this.members().find(member => member.accounts.some(account => accountKey(account) === key))
  }

  registerDingTalkSender(corpId: string, staffId: string, name: string): { member: Member; added: boolean } {
    return this.store.atomic(() => {
      const existing = this.directoryMemberForAccount('dingtalk', corpId, staffId)
      return existing ? { member: existing, added: false } : { added: true,
        member: this.saveMember(MemberInput.parse({ name, accounts: [{ provider: 'dingtalk', scope: corpId, accountId: staffId }] })) }
    })
  }

  /** Enroll a sender observed by the configured project group, using the platform identity across projects. */
  addDingTalkSender(projectId: string, corpId: string, staffId: string, name: string): { projectName: string; added: boolean } {
    return this.store.atomic(() => {
      const project = this.require(projectId)
      const { member } = this.registerDingTalkSender(corpId, staffId, name)
      if (project.memberIds.includes(member.id)) return { projectName: project.name, added: false }
      project.memberIds.push(member.id)
      this.save(project)
      return { projectName: project.name, added: true }
    })
  }

  saveMeetingForReview(projectId: string, text: string, source?: ProjectEvidence, initialMeeting?: true): { id: string; name: string } {
    return this.store.atomic(() => {
      const project = this.require(projectId)
      const recorded = source && project.decisions.find(decision => decision.meetingSource?.triggerId === source.triggerId)
      if (recorded) return { id: recorded.id, name: project.name }
      const id = randomUUID()
      project.decisions.push({ id, question: MEETING_QUESTION, context: text,
        answer: '', taskId: null, answeredAt: null, meetingSource: source, meetingReplies: [], initialMeeting })
      this.save(project)
      return { id, name: project.name }
    })
  }

  meetingStatus(projectId: string) {
    const project = this.require(projectId)
    return { name: project.name, status: project.status, meeting: project.decisions.findLast(isMeeting), taskCount: project.tasks.length }
  }

  addMeetingReply(projectId: string, reply: ProjectMeetingReply, meetingId?: string): boolean {
    return this.store.atomic(() => {
      const project = this.require(projectId)
      const meeting = project.decisions.findLast(decision => isMeeting(decision) && (!meetingId || decision.id === meetingId))
      if (!meeting || meeting.meetingReplies?.some(previous => previous.triggerId === reply.triggerId)) return false
      meeting.meetingReplies ??= []
      meeting.meetingReplies.push(reply)
      this.save(project)
      return true
    })
  }

  saveMember(member: z.output<typeof MemberInput>, memberId?: string): Member {
    return this.store.atomic(() => {
      if (memberId && !this.store.get(KV.projects.member(memberId))) throw new ProjectError(404, 'Member not found')
      const keys = new Set(member.accounts.map(accountKey))
      if (keys.size !== member.accounts.length) throw new ProjectError(400, 'Remove duplicate external accounts')
      if (this.members().some(existing => existing.id !== memberId && existing.accounts.some(account => keys.has(accountKey(account)))))
        throw new ProjectError(409, 'An external account already belongs to another member')
      const saved = { ...member, id: memberId ?? randomUUID() }
      this.store.set(KV.projects.member(saved.id), saved)
      return saved
    })
  }

  /** Remove directory membership atomically across projects while retaining task and meeting history. */
  deleteMember(memberId: string): void {
    this.store.atomic(() => {
      const member = KV.projects.member(memberId)
      if (!this.store.get(member)) throw new ProjectError(404, 'Member not found')
      for (const project of this.records(KV.projects.project)) {
        if (project.memberIds.includes(memberId)) this.change(project.id,
          { revision: project.revision, change: { kind: 'remove-member', memberId } })
      }
      this.store.delete(member)
    })
  }

  create(value: z.output<typeof ProjectInput>): ProjectDetail {
    return this.store.atomic(() => {
      this.checkDingTalkGroup(value.dingTalkGroup)
      const at = isoNow()
      const project = { ...value, repository: value.repository ?? null, ...(value.repository && { repositoryLinkedAt: at }),
        issueUrl: null, id: randomUUID(), revision: 0, createdAt: at, updatedAt: at,
        memberIds: [], tasks: [], milestones: [], decisions: [] }
      this.store.set(KV.projects.project(project.id), project)
      return { ...project, members: [], tickets: [] }
    })
  }

  private require(projectId: string): Project {
    const project = this.store.get(KV.projects.project(projectId))
    if (!project) throw new ProjectError(404, 'Project not found')
    const decisions = project.decisions.map(decision => {
      if (!('taskDraft' in decision)) return decision
      const { taskDraft: _pilotDraft, ...meeting } = decision
      return meeting
    })
    return { ...project, repository: project.repository ?? null, decisions,
      tasks: project.tasks.map(task => ({ ...task, priority: task.priority ?? defaultPriority })) }
  }

  private atRevision(projectId: string, revision: number): Project {
    const project = this.require(projectId)
    if (revision !== project.revision) throw new ProjectError(409, 'Project changed. Reload before saving.')
    return project
  }

  private save(project: Project): ProjectDetail {
    project.revision++
    project.updatedAt = isoNow()
    this.store.set(KV.projects.project(project.id), project)
    return this.detail(project.id)
  }

  /** Associate an Issue without changing task progress or replacing a person’s existing link. */
  linkIssue(projectId: string, taskId: string, repository: string, url: string, role: 'reference' | 'resolve' = 'reference'): boolean {
    return this.store.atomic(() => {
      const project = this.require(projectId)
      const task = requireRecord(project.tasks, taskId, 'Task')
      const issue = githubIssueUrl(url)
      if (!issue?.startsWith(`https://github.com/${repository}/issues/`) || project.repository !== repository) return false
      if (task.issueUrl) return task.issueUrl === issue
      if (project.tasks.some(item => item.issueUrl === issue)) return false
      task.issueUrl = issue
      task.issueRole = role
      this.save(project)
      return true
    })
  }

  private ticketView(ticket: Ticket, project?: Project): ProjectTicket {
    const trigger = this.store.triggers.get(ticket.origin.triggerId)
    const url = trigger?.url && githubIssueUrl(trigger.url)
    const local = typeof trigger?.meta.projectId === 'string' && trigger.meta.projectId === project?.id
    const pullUrls = (ticket.follows ?? []).flatMap(follow => {
      const thread = this.store.threads.get(follow.thread)
      const url = thread?.meta.url ?? this.store.read.firstTrigger(follow.thread)?.url
      return typeof url === 'string' && /^https:\/\/github\.com\/[\w-]+\/[\w.-]+\/pull\/\d+\/?$/i.test(url) ? [url] : []
    })
    const report = latestReport(ticket)
    const runner = this.store.get(KV.sessions.external(workerSessionId(ticket.id)))?.runner ?? trigger?.meta.runner
    return { id: ticket.id, title: ticket.title, updatedAt: ticket.updatedAt, ended: !!ticket.ended, ...ticketStage(ticket), issueUrl: url || null,
      taskId: local && typeof trigger?.meta.projectTaskId === 'string' ? trigger.meta.projectTaskId : null,
      ...(typeof runner === 'string' && { runner }),
      summary: report?.summary ?? '', reportState: report?.state ?? null, question: ticket.attention?.question ?? null, pullUrls: [...new Set(pullUrls)] }
  }

  recentTickets(): ProjectTicket[] { return this.store.tickets.list().slice(0, 50).map(ticket => this.ticketView(ticket)) }

  detail(projectId: string): ProjectDetail {
    const project = this.require(projectId)
    const members = project.memberIds.flatMap(memberId => this.store.get(KV.projects.member(memberId)) ?? []).sort(byName)
    const issues = new Set(project.tasks.flatMap(task => task.issueUrl ?? []))
    const linkedTickets = new Set(project.tasks.flatMap(task => task.ticketId ?? []))
    return { ...project, members, tickets: this.store.tickets.list().flatMap(ticket => {
      const origin = this.store.triggers.get(ticket.origin.triggerId)
      const issue = origin?.url && githubIssueUrl(origin.url)
      if (!linkedTickets.has(ticket.id) && origin?.meta.projectId !== project.id && !(issue && issues.has(issue))) return []
      return [this.ticketView(ticket, project)]
    }) }
  }

  /** Create the execution ticket and save its project link in the same transaction. */
  startTask(projectId: string, taskId: string, revision: number,
    start: (task: ProjectTask, repository: string | null, dependencies: ProjectTask[]) => string): ProjectDetail {
    return this.store.atomic(() => {
      const project = this.atRevision(projectId, revision)
      const task = requireRecord(project.tasks, taskId, 'Task')
      if (project.status !== 'active' || !active(task) || task.status === 'in-review')
        throw new ProjectError(409, 'Only active work outside review can be started')
      if (task.executionMode === 'manual') throw new ProjectError(409, 'This task is assigned to manual execution')
      const dependencies = task.blockedBy.flatMap(id => project.tasks.find(dependency => dependency.id === id) ?? [])
      if (dependencies.length !== task.blockedBy.length || dependencies.some(dependency => dependency.status !== 'done'))
        throw new ProjectError(409, 'Finish the task dependencies before starting execution')
      if (project.decisions.some(decision => decision.taskId === task.id && !decision.answeredAt))
        throw new ProjectError(409, 'Resolve the pending decision for this task before starting execution')
      if ((task.ticketId && this.store.tickets.get(task.ticketId)?.ended === undefined) || this.detail(projectId).tickets.some(item => item.taskId === taskId && !item.ended))
        throw new ProjectError(409, 'This task already has an open ticket')
      const ticketId = start(task, project.repository ?? null, dependencies)
      nextDelivery(task)
      task.ticketId = ticketId
      task.status = 'in-progress'
      task.updatedAt = isoNow()
      task.executionStartedAt = task.updatedAt
      return this.save(project)
    })
  }

  /** Resolve a live ticket originally launched from this exact project task. */
  openTaskTicket(projectId: string, taskId: string, ticketId: string): Ticket {
    requireRecord(this.require(projectId).tasks, taskId, 'Task')
    const ticket = this.store.tickets.get(ticketId)
    const origin = ticket && this.store.triggers.get(ticket.origin.triggerId)
    if (!ticket || origin?.meta.projectId !== projectId || origin.meta.projectTaskId !== taskId)
      throw new ProjectError(404, 'Project task ticket not found')
    if (ticket.ended) throw new ProjectError(409, 'The ticket has already ended')
    return ticket
  }

  /** Captures an immutable review snapshot for the current delivery. Called by the ordered review event handler. */
  requestReview(projectId: string, taskId: string, evidence: DeliveryEvidence, at: string): ProjectDetail {
    return this.store.atomic(() => {
      const project = this.require(projectId)
      const task = requireRecord(project.tasks, taskId, 'Task')
      if (project.status === 'archived' || !['todo', 'in-progress', 'in-review'].includes(task.status))
        throw new ProjectError(409, '任务当前不能提交验收。')
      if (task.blockedBy.some(id => project.tasks.find(item => item.id === id)?.status !== 'done'))
        throw new ProjectError(409, '请先完成前置任务的验收。')
      if (this.detail(projectId).tickets.some(item => !item.ended && (item.id === task.ticketId || item.taskId === task.id)))
        throw new ProjectError(409, '当前执行尚未结束，暂不能提交验收。')
      if (currentReview(task)?.status === 'pending') throw new ProjectError(409, '本版交付已经在等待验收。')
      if (!task.deliveryVersion || currentReview(task)) nextDelivery(task)
      const review: ProjectReview = { id: randomUUID(), version: task.deliveryVersion!, requestedAt: at, status: 'pending',
        requirements: { title: task.title, description: task.description, acceptance: task.acceptance, ownerId: task.ownerId }, evidence }
      ;(task.reviews ??= []).push(review)
      task.status = 'in-review'; task.updatedAt = at; task.completedAt = null
      return this.save(project)
    })
  }

  /** Settles exactly one current review, preserving its evidence and the human decision. */
  decideReview(projectId: string, taskId: string, reviewId: string, outcome: 'accepted' | 'rejected', decision: NonNullable<ProjectReview['decision']>): ProjectDetail {
    return this.store.atomic(() => {
      const project = this.require(projectId)
      const task = requireRecord(project.tasks, taskId, 'Task')
      const review = currentReview(task)
      if (project.status === 'archived' || task.status !== 'in-review' || !review || review.id !== reviewId || review.status !== 'pending')
        throw new ProjectError(409, '这次验收已结束或交付已更新，请查看当前交付。')
      if (decision.actorId !== null && (!project.memberIds.includes(decision.actorId) || review.requirements.ownerId !== decision.actorId))
        throw new ProjectError(403, '请由这项任务当前指定的负责人验收。')
      if (task.blockedBy.some(id => project.tasks.find(item => item.id === id)?.status !== 'done'))
        throw new ProjectError(409, '前置验收已经变化，请先核对依赖。')
      review.status = outcome; review.decision = decision
      task.status = outcome === 'accepted' ? 'done' : 'in-progress'
      task.completedAt = outcome === 'accepted' ? decision.at : null
      task.updatedAt = decision.at
      if (outcome === 'rejected') task.executionStartedAt = decision.at
      return this.save(project)
    })
  }

  change(projectId: string, request: z.output<typeof ProjectChange>): ProjectDetail {
    return this.store.atomic(() => {
      const project = this.atRevision(projectId, request.revision)
      const { change } = request
      const at = isoNow()
      switch (change.kind) {
        case 'project':
          this.checkDingTalkGroup(change.value.dingTalkGroup, project.id)
          if (change.value.repository !== undefined && change.value.repository !== project.repository)
            project.repositoryLinkedAt = change.value.repository ? at : undefined
          for (const [key, value] of Object.entries(change.value)) {
            if (value !== undefined) Object.assign(project, { [key]: value })
          }
          break
        case 'new-member': project.memberIds.push(this.saveMember(change.value).id); break
        case 'add-member': {
          if (!this.store.get(KV.projects.member(change.memberId))) throw new ProjectError(404, 'Member not found')
          if (project.memberIds.includes(change.memberId)) return this.detail(projectId)
          project.memberIds.push(change.memberId)
          break
        }
        case 'remove-member': {
          if (project.tasks.some(task => task.ownerId === change.memberId && active(task)))
            throw new ProjectError(409, 'Reassign the member’s active tasks before removing them')
          project.memberIds = project.memberIds.filter(memberId => memberId !== change.memberId)
          break
        }
        case 'milestone': {
          if (change.id) Object.assign(requireRecord(project.milestones, change.id, 'Milestone'), change.value)
          else project.milestones.push({ ...change.value, id: randomUUID() })
          break
        }
        case 'decision': {
          const current = change.id ? requireRecord(project.decisions, change.id, 'Decision') : undefined
          if (change.value.taskId) requireRecord(project.tasks, change.value.taskId, 'Task')
          const answeredAt = change.value.answer ? current?.answer === change.value.answer ? current.answeredAt : at : null
          if (current) Object.assign(current, change.value, { answeredAt })
          else project.decisions.push({ ...change.value, id: randomUUID(), answeredAt })
          break
        }
        case 'task':
        case 'task-priority':
        case 'task-ticket':
        case 'task-status': {
          const current = change.id ? requireRecord(project.tasks, change.id, 'Task') : undefined
          const value = change.kind === 'task-status' ? { ...current!, status: change.status }
            : change.kind === 'task-ticket' ? { ...current!, ticketId: change.ticketId }
              : change.kind === 'task-priority' ? { ...current!, priority: change.priority } : change.value
          if (value.issueUrl && value.issueUrl !== current?.issueUrl) {
            const linked = project.tasks.find(task => task.id !== current?.id && task.issueUrl === value.issueUrl)
            if (linked) throw new ProjectError(409, `This GitHub Issue is already linked to “${linked.title}”`)
          }
          if ((value.issueRole === 'resolve' && value.issueUrl || value.deliveryMode === 'pull-request' || value.pullRequestUrl) && !project.repository)
            throw new ProjectError(400, 'Link the project repository before configuring repository delivery or Issue resolution')
          for (const url of [value.issueRole === 'resolve' ? value.issueUrl : null, value.pullRequestUrl])
            if (url && !url.toLowerCase().startsWith(`https://github.com/${project.repository}/`))
              throw new ProjectError(400, 'The repository resource must belong to this project repository')
          if (value.ownerId && !project.memberIds.includes(value.ownerId) && (value.ownerId !== current?.ownerId || active(value)))
            throw new ProjectError(400, 'The task owner must be a project member')
          if (value.milestoneId) requireRecord(project.milestones, value.milestoneId, 'Milestone')
          if (value.ticketId && !this.store.tickets.get(value.ticketId)) throw new ProjectError(404, 'Ticket not found')
          const executionStartedAt = value.status !== 'in-progress' ? undefined
            : current?.status === 'in-progress' && value.ticketId === current.ticketId ? current.executionStartedAt : at
          const task: ProjectTask = { ...value, id: current?.id ?? randomUUID(), blockedBy: [...new Set(value.blockedBy)], executionStartedAt,
            createdAt: current?.createdAt ?? at, updatedAt: at, completedAt: value.status === 'done' ? current?.completedAt ?? at : null }
          if (current?.deliveryVersion || current?.reviews?.length) {
            if (task.status === 'done' && current.status !== 'done') throw new ProjectError(409, '请通过当前交付的验收入口完成任务。')
            const changed = deliveryScopeChanged(current, task)
            if (changed && this.detail(projectId).tickets.some(item => !item.ended && (item.id === current.ticketId || item.taskId === current.id)))
              throw new ProjectError(409, '请先停止当前执行，再修改交付范围。')
            if (changed || task.status !== current.status || task.ticketId !== current.ticketId) {
              nextDelivery(current)
              task.deliveryVersion = current.deliveryVersion
              task.reviews = current.reviews
              if (changed && task.status === 'in-review') task.status = 'in-progress'
              task.completedAt = task.status === 'done' && !changed ? task.completedAt : null
              if (changed && task.status === 'done') task.status = 'todo'
              task.executionStartedAt = at
            }
          }
          validateDependencies(project.tasks, task)
          const advances = !current || current.status !== task.status || JSON.stringify(current.blockedBy) !== JSON.stringify(task.blockedBy)
          if (advances && task.status !== 'todo' && task.status !== 'cancelled' &&
            task.blockedBy.some(id => project.tasks.find(item => item.id === id)?.status !== 'done'))
            throw new ProjectError(409, 'Finish the task dependencies before advancing this task')
          if (current?.status === 'done' && task.status !== 'done' &&
            project.tasks.some(item => item.status !== 'todo' && item.status !== 'cancelled' && item.blockedBy.includes(task.id)))
            throw new ProjectError(409, 'Move dependent tasks back to To do before reopening this task')
          if (current) Object.assign(current, task)
          else project.tasks.push(task)
          break
        }
      }
      return this.save(project)
    })
  }
}
