/** Ordered repository observations and durable post-acceptance Issue synchronization. */
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { key, type ChannelRef, type OutboundMessage, type Ticket, type WorkerReport } from '../core/index.ts'
import { KV } from '../kv.ts'
import { CliError, type Commands } from '../infra/commands.ts'
import { RepositoryFact, RepositoryFeedback, changeObserved, issueObserved, feedbackReceived } from '../sources/repository-events.ts'
import type { ProjectEvent, ProjectEventDefinition } from '../sources/project-events.ts'
import type { Store } from './store.ts'
import { currentReview } from './project-deliveries.ts'
import { Projects, ProjectError } from './projects.ts'
import type { ProjectAgent } from './project-agent.ts'
import type { ProjectToolContext } from './project-tools.ts'
import type { ProjectEvents } from './project-events.ts'
import type { Effects } from './effects.ts'
import { projectResources, repositoryFactKey } from './repository-delivery.ts'
import type { DeliveryReady } from './events/delivery-ready.ts'

const Close = z.strictObject({ reviewId: z.string(), url: z.url(), repository: z.string(), version: z.number().int().nonnegative() })
export const issueCloseRequested: ProjectEventDefinition = { type: 'issue.close.requested', category: 'issues', schema: Close,
  description: '人工验收通过后，关闭本任务明确负责解决的 Issue。历史关联默认仅参考。', defaults: { enabled: true },
  documentation: 'docs/events/repository.zh-CN.md' }
const SyncResult = z.strictObject({ operationId: z.string(), attempt: z.number().int().positive(), status: z.enum(['succeeded', 'retrying', 'failed', 'cancelled']),
  reason: z.string(), remote: RepositoryFact.optional() })
const syncResult: ProjectEventDefinition = { type: 'issue.sync.result', category: 'issues', schema: SyncResult, internal: true,
  description: '保存实际同步回执或失败原因。', defaults: { enabled: true }, documentation: 'docs/events/repository.zh-CN.md' }
const FeedbackResult = z.strictObject({ triggerId: z.string(), ticketId: z.string(), feedbackEventId: z.string(), reportAt: z.iso.datetime(),
  summary: z.string(), question: z.string().optional() })
const feedbackResult: ProjectEventDefinition = { type: 'code.feedback.result', category: 'comments', schema: FeedbackResult, internal: true,
  description: '将执行工单明确回答的评审结果或问题，可靠回写到原讨论并保存投递回执。', defaults: { enabled: true }, documentation: 'docs/events/repository.zh-CN.md' }
export interface IssueSync { id: string; projectId: string; taskId: string; reviewId: string; url: string; repository: string; version: number;
  status: 'pending' | 'succeeded' | 'retrying' | 'failed' | 'cancelled'; attempts: number; reason: string; updatedAt: string }
interface Host { store: Store; events: ProjectEvents; effects: Effects; commands: Pick<Commands, 'forRepository'>; delivery: Pick<DeliveryReady, 'observe'>; runnable?(): boolean
  agent?(): ProjectAgent | undefined
  authorized?(source: string, actor: string): boolean
  discussion?(repository: string, url: string): ChannelRef | undefined
  notify?(message: OutboundMessage): void
  reportReply?(ticketId: string, triggerId: string, text: string, question?: string): void
}
const Remote = z.looseObject({ state: z.enum(['open', 'closed']), state_reason: z.string().nullish(), html_url: z.url(), updated_at: z.iso.datetime(), pull_request: z.unknown().optional() })

/** Joins remote code facts with current delivery and synchronizes only explicit, newly accepted Issue-resolution mandates. */
export class ProjectRepository {
  constructor(private readonly host: Host) {
    host.events.register('repository', [issueCloseRequested, syncResult, issueObserved, changeObserved, feedbackReceived, feedbackResult])
    host.events.handle(issueObserved.type, event => this.observe(event))
    host.events.handle(changeObserved.type, event => this.observe(event))
    host.events.handle(feedbackReceived.type, event => {
      if (!this.currentFeedback(event)) return { status: 'ignored', reason: 'Repository feedback binding, source or actor is no longer authorized' }
      const feedback = RepositoryFeedback.parse(event.data)
      host.store.set(KV.projects.feedback(event.id), { ...feedback, source: event.source, eventId: event.id, projectId: event.projectId!, taskId: event.taskId! })
      return { status: 'applied' }
    })
    host.events.handle(feedbackResult.type, event => {
      const result = FeedbackResult.parse(event.data)
      const feedback = host.store.get(KV.projects.feedback(result.feedbackEventId))
      const project = host.store.get(KV.projects.project(event.projectId!))
      const task = project?.tasks.find(task => task.id === event.taskId)
      const ticket = host.store.tickets.get(result.ticketId)
      const input = host.store.triggers.get(result.triggerId)
      if (!feedback || !task || !ticket || project?.status !== 'active'
        || feedback.projectId !== event.projectId || feedback.taskId !== event.taskId
        || task.ticketId !== ticket.id || (task.deliveryVersion ?? 0) !== feedback.deliveryVersion
        || input?.meta.projectEventId !== result.feedbackEventId || !host.reportReply
        || (result.question ? ticket?.attention?.question !== result.question : !ticket?.answers?.includes(result.triggerId)))
        return { status: 'ignored', reason: 'Feedback reply no longer belongs to the current delivery or response' }
      host.reportReply(result.ticketId, result.triggerId, result.summary, result.question)
      return { status: 'applied' }
    })
    host.events.handle(issueCloseRequested.type, event => {
      const payload = Close.parse(event.data)
      const operation: IssueSync = { id: event.id, projectId: event.projectId!, taskId: event.taskId!, ...payload,
        status: 'pending', attempts: 0, reason: '等待远端核验与同步', updatedAt: event.recordedAt }
      if (!this.valid(operation)) return { status: 'ignored', reason: 'Issue resolution mandate is no longer current' }
      host.store.set(KV.projects.issueSync(operation.id), operation)
      host.effects.enqueue('project-issue-sync', operation.id, { id: operation.id })
      return { status: 'applied' }
    })
    host.events.handle(syncResult.type, event => {
      const result = SyncResult.parse(event.data)
      const entry = KV.projects.issueSync(result.operationId)
      const operation = host.store.get(entry)
      if (!operation || result.attempt < operation.attempts) return { status: 'ignored', reason: 'Superseded synchronization result' }
      host.store.set(entry, { ...operation, status: result.status, attempts: result.attempt, reason: result.reason, updatedAt: event.recordedAt })
      if (result.remote) this.saveFact(event, result.remote)
      return { status: 'applied' }
    })
    host.events.observe((event, reaction) => {
      if (event.type === feedbackReceived.type) {
        const agent = host.agent?.()
        if (agent) agent.react(event, reaction.instruction ?? '', RepositoryFeedback.parse(event.data).channel)
        return
      }
      if (event.type !== 'review.accepted' || !event.projectId || !event.taskId) return
      const project = host.store.get(KV.projects.project(event.projectId))
      const task = project?.tasks.find(item => item.id === event.taskId)
      const review = task && currentReview(task)
      if (!project?.repository || !task?.issueUrl || task.issueRole !== 'resolve' || task.status !== 'done' || review?.status !== 'accepted') return
      host.events.publisher('repository').publish({ id: key('close-accepted-issue', review.id), type: issueCloseRequested.type,
        projectId: project.id, taskId: task.id, causeId: event.id,
        data: { reviewId: review.id, url: task.issueUrl, repository: project.repository, version: task.deliveryVersion ?? 0 } })
    })
    host.effects.handle('project-issue-sync', ({ id }) => this.sync(id), { limit: () => host.runnable?.() === false ? 0 : 1 })
  }

  /** Installed after the selected Agent exists, keeping provider decisions outside the common model loop. */
  connect(agent: ProjectAgent): void {
    agent.registerReaction(feedbackReceived.type, { tools: ['project.inspect', 'runtime.inspect', 'task.follow_up', 'discussion.reply'],
      current: event => this.currentFeedback(event) })
  }

  recover(): void {
    const agent = this.host.agent?.()
    if (!agent) return
    for (const entry of this.host.store.keys(KV.projects.feedback)) {
      const feedback = this.host.store.get(entry)!
      const event = this.host.events.get(feedback.source, feedback.eventId)
      if (event?.status === 'applied' && this.currentFeedback(event))
        agent.react(event, this.host.events.settings(event.source, event.type).instruction ?? '', feedback.channel)
    }
  }

  currentFeedback(event: ProjectEvent): boolean {
    if (event.type !== feedbackReceived.type || !event.projectId || !event.taskId) return false
    const result = RepositoryFeedback.safeParse(event.data)
    if (!result.success || !result.data.actor.human || !this.host.authorized?.(event.source, result.data.actor.id)) return false
    const project = this.host.store.get(KV.projects.project(event.projectId))
    const task = project?.tasks.find(task => task.id === event.taskId)
    if (!project || project.status !== 'active' || !task || ['done','cancelled'].includes(task.status)) return false
    const feedback = result.data
    const binding = projectResources(this.host.store).some(target => target.projectId === project.id && target.taskId === task.id
      && target.repository === feedback.repository && target.pullUrls.includes(feedback.resourceUrl)
      && target.ticketId === feedback.ticketId && target.deliveryVersion === feedback.deliveryVersion)
    const channel = this.host.discussion?.(feedback.repository, feedback.url)
    const root = this.host.discussion?.(feedback.repository, feedback.resourceUrl)
    if (!binding || !channel || !root || channel.thread !== root.thread || channel.source !== root.source
      || !isDeepStrictEqual(channel, feedback.channel) || channel.source !== event.source) return false
    try { return this.host.events.settings(event.source, event.type).enabled } catch { return false }
  }

  followOrigin(event: ProjectEvent): RepositoryFeedback {
    if (!this.currentFeedback(event)) throw new ProjectError(409, 'Repository feedback authorization or binding changed')
    const feedback = RepositoryFeedback.parse(event.data)
    const fact = this.host.store.get(repositoryFactKey(event.projectId!, event.taskId!, feedback.deliveryVersion, feedback.resourceUrl))
    if (feedback.commit && fact?.head && feedback.commit !== fact.head)
      throw new ProjectError(409, 'This feedback refers to an earlier code revision; clarify it against the current revision before modifying code')
    return feedback
  }

  /** Captures the worker's explicit answer in its reporting transaction; the ordered result event owns the reply. */
  report(ticket: Ticket, report: WorkerReport): boolean {
    const triggerId = report.answers ?? report.askedBy
    const input = triggerId && this.host.store.triggers.get(triggerId)
    const eventId = input && typeof input.meta.projectEventId === 'string' ? input.meta.projectEventId : undefined
    const feedback = eventId && this.host.store.get(KV.projects.feedback(eventId))
    const at = ticket.assignments.at(-1)?.report?.at
    if (!triggerId || !eventId || !feedback || !at) return false
    this.host.events.publisher('repository').publish({ id: key('feedback-result', ticket.id, eventId, at), type: feedbackResult.type,
      projectId: feedback.projectId, taskId: feedback.taskId, causeId: eventId,
      data: { triggerId, ticketId: ticket.id, feedbackEventId: eventId, reportAt: at, summary: report.summary,
        ...(report.question ? { question: report.question } : {}) } })
    return true
  }

  reply(context: ProjectToolContext, taskId: string, url: string, text: string) {
    const target = projectResources(this.host.store).find(target => target.projectId === context.projectId && target.taskId === taskId
      && target.pullUrls.some(pull => {
        const root = this.host.discussion?.(target.repository, pull), destination = this.host.discussion?.(target.repository, url)
        return root && destination && root.source === destination.source && root.thread === destination.thread
      }))
    const channel = target && this.host.discussion?.(target.repository, url)
    if (!channel || !this.host.notify) throw new ProjectError(400, 'Discussion is not linked to this task or its source is unavailable')
    if (context.event && (!this.currentFeedback(context.event) || url !== RepositoryFeedback.parse(context.event.data).url))
      throw new ProjectError(403, 'Event replies are limited to the original authorized discussion')
    const id = key('project-discussion-reply', context.operationId)
    this.host.notify({ id, channel, kind: 'notice', text,
      origin: { projectId: context.projectId, taskId, eventId: context.event?.id ?? context.messageId } })
    return { messageId: id, status: this.host.store.replyStatus(id) ?? 'pending' }
  }

  private valid(operation: IssueSync): boolean {
    if (!this.host.events.settings('repository', issueCloseRequested.type).enabled) return false
    const project = this.host.store.get(KV.projects.project(operation.projectId))
    const task = project?.tasks.find(task => task.id === operation.taskId)
    const review = task && currentReview(task)
    return !!project && project.status !== 'archived' && project.repository === operation.repository && task?.issueUrl === operation.url
      && task.issueRole === 'resolve' && task.status === 'done' && (task.deliveryVersion ?? 0) === operation.version
      && review?.id === operation.reviewId && review.status === 'accepted'
      && operation.url.startsWith(`https://github.com/${operation.repository}/issues/`)
  }

  private saveFact(event: ProjectEvent, fact: RepositoryFact): void {
    const previous = this.host.store.get(repositoryFactKey(event.projectId!, event.taskId!, fact.deliveryVersion, fact.url))
    if (previous && Date.parse(previous.updatedAt) > Date.parse(fact.updatedAt)) return
    this.host.store.set(repositoryFactKey(event.projectId!, event.taskId!, fact.deliveryVersion, fact.url),
      { ...fact, projectId: event.projectId!, taskId: event.taskId! })
  }

  private observe(event: ProjectEvent) {
    const fact = RepositoryFact.parse(event.data)
    const target = projectResources(this.host.store).find(target => target.projectId === event.projectId && target.taskId === event.taskId
      && target.repository === fact.repository && target.deliveryVersion === fact.deliveryVersion
      && (event.type === issueObserved.type ? target.issueUrl === fact.url : target.pullUrls.includes(fact.url) && target.ticketId === fact.ticketId))
    if (!target) return { status: 'ignored' as const, reason: 'Repository binding or delivery changed' }
    const previous = this.host.store.get(repositoryFactKey(target.projectId, target.taskId, target.deliveryVersion, fact.url))
    if (previous && Date.parse(previous.updatedAt) >= Date.parse(fact.updatedAt))
      return { status: 'ignored' as const, reason: 'Remote observation is not newer' }
    this.saveFact(event, fact)
    const project = this.host.store.get(KV.projects.project(target.projectId))!
    const task = project.tasks.find(task => task.id === target.taskId)!
    const code = currentReview(task)?.evidence.code
    if (task.status === 'in-review' && code?.url === fact.url && (code.head !== fact.head || fact.state !== 'merged')) {
      const updated = new Projects(this.host.store).change(project.id, { revision: project.revision,
        change: { kind: 'task-status', id: task.id, status: 'in-progress' } })
      this.saveFact(event, { ...fact, deliveryVersion: updated.tasks.find(task => task.id === target.taskId)!.deliveryVersion ?? 0 })
    }
    if (event.type === changeObserved.type && target.ticketId) this.host.delivery.observe(target.ticketId)
    return { status: 'applied' as const }
  }

  private async sync(id: string): Promise<void> {
    const { store, commands, events } = this.host
    const operation = store.get(KV.projects.issueSync(id))
    if (!operation || ['succeeded', 'failed', 'cancelled'].includes(operation.status)) return
    const attempt = operation.attempts + 1
    // Persist the attempt before the remote request; a crash retries by reading remote state first.
    store.set(KV.projects.issueSync(id), { ...operation, attempts: attempt })
    const result = (status: z.output<typeof SyncResult>['status'], reason: string, remote?: RepositoryFact) => {
      events.publisher('repository').publish({ id: key(id, String(attempt), status), type: syncResult.type,
        projectId: operation.projectId, taskId: operation.taskId, causeId: id, data: { operationId: id, attempt, status, reason, ...(remote ? { remote } : {}) } })
    }
    if (!this.valid(operation)) { result('cancelled', '任务、验收、仓库或 Issue 关联已改变，同步已取消'); return }
    const path = `issues/${operation.url.split('/').at(-1)}`
    try {
      const repo = commands.forRepository(operation.repository)
      let remote = await repo.api(Remote, path)
      if (remote.pull_request || remote.html_url !== operation.url) { result('failed', '远端对象不是已授权的 Issue'); return }
      if (!this.valid(operation)) { result('cancelled', '发送前任务或授权已改变'); return }
      if (remote.state !== 'closed') remote = await repo.api(Remote, path, '--method', 'PATCH', '-f', 'state=closed', '-f', 'state_reason=completed')
      if (remote.state !== 'closed') throw new Error('GitHub has not confirmed the Issue closure')
      result('succeeded', this.valid(operation) ? 'GitHub 已确认 Issue 关闭' : 'GitHub 已关闭 Issue，但请求期间任务已变化，请核对远端状态差异',
        { repository: operation.repository, url: operation.url, state: 'closed', updatedAt: remote.updated_at, deliveryVersion: operation.version })
    } catch (error) {
      const permanent = error instanceof CliError && [401, 403, 404, 410, 422].includes(error.code ?? 0)
      result(permanent ? 'failed' : 'retrying', permanent ? 'GitHub 权限或对象不可用，请核对连接与关联后重试' : '远端结果待确认，将先读取实际状态再重试')
      if (!permanent) throw error
    }
  }

  retry(id: string): void {
    const operation = this.host.store.get(KV.projects.issueSync(id))
    if (!operation || !['failed', 'retrying'].includes(operation.status) || !this.valid(operation)) throw new Error('Issue synchronization is no longer authorized')
    this.host.store.atomic(() => {
      this.host.store.set(KV.projects.issueSync(id), { ...operation, status: 'pending', reason: '已登记重新核对', updatedAt: new Date().toISOString() })
      this.host.effects.enqueue('project-issue-sync', id, { id })
    })
  }
}
