import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { key, type ChannelRef, type OutboundMessage } from '../core/index.ts'
import type { ProjectEvent, ProjectEventDefinition } from '../sources/project-events.ts'
import { currentReview, reviewReference, type DeliveryEvidence } from './project-deliveries.ts'
import { announce } from './project-notifications.ts'
import { ProjectError, Projects, type ProjectTask } from './projects.ts'
import type { ProjectEvents } from './project-events.ts'
import type { Store } from './store.ts'
import { mergedDelivery } from './repository-delivery.ts'
import { repositoryFactKey } from './repository-delivery.ts'

const id = z.string().min(1).max(300)
const Context = z.strictObject({ projectId: id, actorId: id.nullable(), operationId: id,
  replyOwner: z.enum(['agent', 'event']).optional(),
  channel: z.strictObject({ source: id, thread: id, address: z.record(z.string(), z.string()) }) })
export type ReviewContext = z.output<typeof Context>
export const ReviewEvidence = z.strictObject({ summary: z.string().trim().min(1).max(12000),
  links: z.array(z.url({ protocol: /^https?$/ })).max(20).default([]) })
const Evidence = ReviewEvidence.extend({ ticketId: id.optional(), reportAt: z.iso.datetime().optional() })
const Request = z.strictObject({ context: Context, evidence: Evidence, basis: z.string(), silent: z.boolean().default(false) })
const Decision = z.strictObject({ context: Context, reviewId: id, reason: z.string().trim().min(1).max(8000) })
function definition(type: string, description: string, schema: z.ZodType): ProjectEventDefinition {
  return { type, category: 'reviews', description, schema, defaults: { enabled: true }, documentation: `docs/events/${type.replace('.', '-')}.zh-CN.md` }
}
export const reviewRequested = definition('review.requested', '记录本版交付和验收条件，并通知任务负责人验收。', Request)
export const reviewAccepted = definition('review.accepted', '当前负责人通过本版验收，完成任务并保留验收依据。', Decision)
export const reviewRejected = definition('review.rejected', '当前负责人退回本版交付，保留原因并返回进行中。', Decision)
const basis = (task: ProjectTask) => createHash('sha256').update(JSON.stringify([task.deliveryVersion, task.title, task.description,
  task.acceptance, task.ownerId, task.executionMode, task.blockedBy, task.status, task.ticketId, task.executionStartedAt])).digest('hex')
interface Host { store: Store; events: ProjectEvents; notify(message: OutboundMessage): void }

/** Provides a shared, durable review entry for worker deliveries, human submissions, the board and Agent tools. */
export class ProjectReviews {
  private readonly projects: Projects
  constructor(private readonly host: Host) {
    this.projects = new Projects(host.store)
    host.events.register('review', [reviewRequested, reviewAccepted, reviewRejected])
    host.events.handle(reviewRequested.type, event => this.apply(event, () => this.requested(event)))
    for (const [definition, outcome] of [[reviewAccepted, 'accepted'], [reviewRejected, 'rejected']] as const)
      host.events.handle(definition.type, event => this.apply(event, () => this.decided(event, outcome)))
  }

  reference(projectId: string, quoted: string): string | undefined {
    const matches = this.projects.detail(projectId).tasks.flatMap(task => task.reviews ?? []).filter(review => quoted.includes(reviewReference(review)))
    if (matches.length > 1) throw new ProjectError(409, '引用中有多次验收，请明确这次要处理哪一项。')
    return matches[0]?.id
  }

  submit(context: ReviewContext, taskId: string, evidence: DeliveryEvidence, silent = false) {
    context = Context.strip().parse(context)
    const { task } = this.authorize(context, taskId)
    const data = { evidence: Evidence.parse(evidence), silent }
    const replay = this.replay(reviewRequested, context, taskId, data)
    if (replay) return replay
    if (context.channel.source !== 'execution' && task.executionMode === 'agent')
      throw new ProjectError(409, 'Agent 任务使用当前工单的成功交付报告发起验收。')
    return this.publish(reviewRequested, context, taskId, { ...data, basis: basis(task) })
  }

  decide(context: ReviewContext, taskId: string, reviewId: string, outcome: 'accepted' | 'rejected', reason: string, quotedReviewId?: string) {
    context = Context.strip().parse(context)
    if (context.channel.source === 'execution') throw new ProjectError(403, '工单执行不能替代人工验收。')
    const { task } = this.authorize(context, taskId)
    const definition = outcome === 'accepted' ? reviewAccepted : reviewRejected
    const data = { reviewId, reason: z.string().trim().min(1).max(8000).parse(reason) }
    const replay = this.replay(definition, context, taskId, data)
    if (replay) return replay
    if (quotedReviewId && quotedReviewId !== reviewId) throw new ProjectError(409, '只能处理本条消息引用的验收，不能自动换成本版。')
    const review = currentReview(task)
    if (!review || task.status !== 'in-review' || review.id !== reviewId || review.status !== 'pending')
      throw new ProjectError(409, '引用的验收已结束或交付已更新，请查看当前交付。')
    if (context.actorId !== null && context.actorId !== review.requirements.ownerId)
      throw new ProjectError(403, '请由这项任务当前指定的负责人验收。')
    return this.publish(definition, context, taskId, data)
  }

  recover(): void {
    for (const project of this.projects.list()) {
      if (project.status === 'archived') continue
      for (const task of this.projects.detail(project.id).tasks) {
        if (task.status !== 'in-review' || task.reviews?.length) continue
        const ticket = this.projects.detail(project.id).tickets.find(item => item.id === task.ticketId)
        // Historical review state is preserved without claiming missing evidence or sending a bulk reminder.
        this.publish(reviewRequested, { projectId: project.id, actorId: null, operationId: key('legacy-review', task.id),
          channel: { source: 'request', thread: project.id, address: { projectId: project.id } } }, task.id,
          { evidence: { summary: ticket?.summary || '历史待验收任务未保存交付摘要，请核对原任务记录。', links: ticket?.pullUrls ?? [] }, basis: basis(task), silent: true })
      }
    }
  }

  private authorize(context: ReviewContext, taskId: string) {
    const project = this.projects.detail(context.projectId)
    if (project.status === 'archived') throw new ProjectError(409, '项目已归档。')
    if (context.actorId === null) {
      if (!['request', 'execution'].includes(context.channel.source)) throw new ProjectError(403, '缺少有效的成员身份。')
    } else if (!project.memberIds.includes(context.actorId)) throw new ProjectError(403, '请先登记为这个项目的成员。')
    if (context.channel.source === 'dingtalk' && context.channel.address.conversationId !== project.dingTalkGroup)
      throw new ProjectError(403, '这条验收消息来自另一个项目群。')
    const task = project.tasks.find(item => item.id === taskId)
    if (!task) throw new ProjectError(404, '任务不属于当前项目。')
    return { project, task }
  }

  private publish(definition: ProjectEventDefinition, context: ReviewContext, taskId: string, data: object) {
    const event = this.host.events.publisher('review').publish({ id: key(definition.type, context.operationId), type: definition.type,
      projectId: context.projectId, taskId, causeId: context.operationId, data: { context, ...data } })
    return this.receipt(event)
  }

  private receipt(event: ProjectEvent) {
    const enabled = this.host.events.settings('review', event.type).enabled
    return { eventId: event.id, status: event.status !== 'pending' ? event.status : enabled ? 'queued' : 'disabled' }
  }

  private replay(definition: ProjectEventDefinition, context: ReviewContext, taskId: string, data: object) {
    const event = this.host.events.get('review', key(definition.type, context.operationId))
    if (!event) return
    const saved = event.data as Record<string, unknown>
    if (event.projectId !== context.projectId || event.taskId !== taskId || !isDeepStrictEqual(saved.context, context) ||
      Object.entries(data).some(([name, value]) => !isDeepStrictEqual(saved[name], value)))
      throw new ProjectError(409, '这次操作 ID 已用于其他内容，请刷新后重新操作。')
    return this.receipt(event)
  }

  private requested(event: ProjectEvent) {
    const { context, evidence, basis: expected, silent } = Request.parse(event.data)
    const { project, task } = this.authorize(context, event.taskId!)
    if (basis(task) !== expected) throw new ProjectError(409, '提交后任务或交付已变化，请基于当前内容重新提交验收。')
    const merged = mergedDelivery(this.host.store, project, task)
    if (task.deliveryMode === 'pull-request' && !merged)
      throw new ProjectError(409, '当前代码交付尚无匹配仓库、版本和目标分支的合并证据。')
    if (context.channel.source === 'execution') {
      const ticket = evidence.ticketId && this.host.store.tickets.get(evidence.ticketId)
      const report = ticket && ticket.assignments.at(-1)?.report
      if (!ticket || task.ticketId !== ticket.id || !['completed', 'merged'].includes(ticket.ended?.outcome ?? '') ||
        !report || report.state !== 'ready' || report.at !== evidence.reportAt)
        throw new ProjectError(409, '该工单已不是当前有效交付。')
    }
    const updated = this.projects.requestReview(project.id, task.id, { ...evidence,
      ...(merged ? { code: { url: merged.url, head: merged.head!, mergeCommit: merged.mergeCommit!, base: merged.base, updatedAt: merged.updatedAt } } : {}) }, event.recordedAt)
    if (merged) this.host.store.set(repositoryFactKey(project.id, task.id, updated.tasks.find(item => item.id === task.id)!.deliveryVersion!, merged.url),
      { ...merged, deliveryVersion: updated.tasks.find(item => item.id === task.id)!.deliveryVersion!, projectId: project.id, taskId: task.id })
    const review = currentReview(updated.tasks.find(item => item.id === task.id)!)!
    const owner = updated.members.find(item => item.id === review.requirements.ownerId)
    if (!silent) announce(this.host, updated, event.causeId ?? event.id, {
      title: `「${project.name}」· ${task.title}`, status: `待验收${owner ? ` · ${owner.name}` : ''}`,
      summary: '本版交付已保存，等待人工检查。',
      action: owner ? `请 ${owner.name} 检查交付和验收条件，引用本消息说明通过依据或退回原因。` : '尚未指定负责人，请先明确本任务的验收分工。',
      evidence: JSON.stringify({ result: evidence.summary, acceptance: review.requirements.acceptance, links: evidence.links }),
      reference: reviewReference(review), details: `项目看板 →「${project.name}」→「${task.title}」→ 交付与验收记录。`,
    }, owner)
    return { status: 'applied' as const }
  }

  private decided(event: ProjectEvent, outcome: 'accepted' | 'rejected') {
    const { context, reviewId, reason } = Decision.parse(event.data)
    const { task } = this.authorize(context, event.taskId!)
    const updated = this.projects.decideReview(context.projectId, task.id, reviewId, outcome,
      { actorId: context.actorId, source: context.channel.source, reason, at: event.recordedAt })
    const review = currentReview(updated.tasks.find(item => item.id === task.id)!)!
    if (!(context.replyOwner === 'agent' && context.channel.source === 'dingtalk' && context.channel.address.conversationId === updated.dingTalkGroup))
      announce(this.host, updated, event.id, `${reviewReference(review)}「${task.title}」${outcome === 'accepted' ? '验收通过，任务已完成。' : '已退回，任务返回进行中。'}\n原因：${reason.slice(0, 1200)}${outcome === 'rejected' ? '\n请按退回意见修订后再次提交交付。' : ''}`)
    return { status: 'applied' as const }
  }

  private apply(event: ProjectEvent, run: () => { status: 'applied' }) {
    try { return run() }
    catch (error) {
      if (!(error instanceof ProjectError)) throw error
      const context = Context.parse((event.data as { context: unknown }).context)
      if (context.channel.source === 'execution') {
        if (this.projects.list().some(project => project.id === context.projectId))
          announce(this.host, this.projects.detail(context.projectId), key('project-review-result', event.id), error.message)
      } else this.host.notify({ id: key('project-review-result', event.id), channel: context.channel, kind: 'notice', text: error.message })
      return { status: 'ignored' as const, reason: error.message }
    }
  }
}
