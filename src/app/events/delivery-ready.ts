import { z } from 'zod'
import { key, type OutboundMessage } from '../../core/index.ts'
import { KV } from '../../kv.ts'
import type { ProjectEvent, ProjectEventDefinition } from '../../sources/project-events.ts'
import { Projects } from '../projects.ts'
import type { ProjectReviews } from '../project-reviews.ts'
import type { ProjectEvents } from '../project-events.ts'
import type { Store } from '../store.ts'
import { mergedDelivery } from '../repository-delivery.ts'

const Payload = z.strictObject({ ticketId: z.string().min(1), reportAt: z.iso.datetime() })
export const deliveryReady: ProjectEventDefinition = {
  type: 'delivery.ready', category: 'deliveries', description: '当前执行已成功交付，将任务移到待验收并通知验收人。',
  schema: Payload, defaults: { enabled: true }, documentation: 'docs/events/delivery-ready.zh-CN.md',
}
interface Host { store: Store; events: ProjectEvents; reviews: ProjectReviews; notify(message: OutboundMessage): void }

/** Translates a completed project execution into one durable review event, including startup recovery. */
export class DeliveryReady {
  private readonly projects: Projects
  constructor(private readonly host: Host) {
    this.projects = new Projects(host.store)
    host.events.handle(deliveryReady.type, event => this.apply(event))
  }

  observe(ticketId: string): void {
    const ticket = this.host.store.tickets.get(ticketId)
    const report = ticket?.assignments.at(-1)?.report
    if (!report || report.state !== 'ready' || !['completed', 'merged'].includes(ticket?.ended?.outcome ?? '')) return
    for (const projectId of this.host.store.keys(KV.projects.project)) {
      const project = this.host.store.get(projectId)!
      for (const task of project.tasks) {
        if (task.status !== 'in-progress' || task.ticketId !== ticketId) continue
        if (task.deliveryMode === 'pull-request' && !mergedDelivery(this.host.store, project, task)) continue
        this.host.events.publisher('execution').publish({
          id: key('project-task-review', project.id, task.id, ticketId, report.at), type: deliveryReady.type,
          projectId: project.id, taskId: task.id, occurredAt: report.at, data: { ticketId, reportAt: report.at },
        })
      }
    }
  }

  recover(): void {
    const pending = new Set(this.host.store.keys(KV.projects.project).flatMap(id => this.host.store.get(id)!.tasks
      .flatMap(task => task.status === 'in-progress' && task.ticketId ? [task.ticketId] : [])))
    for (const ticketId of pending) this.observe(ticketId)
  }

  private apply(event: ProjectEvent) {
    const ignored = (reason: string) => ({ status: 'ignored' as const, reason })
    const { ticketId, reportAt } = Payload.parse(event.data)
    if (!event.projectId || !this.host.store.get(KV.projects.project(event.projectId))) return ignored('Project no longer exists')
    const detail = this.projects.detail(event.projectId)
    const task = detail.tasks.find(item => item.id === event.taskId)
    if (!task || task.status !== 'in-progress' || task.ticketId !== ticketId || detail.status === 'archived')
      return ignored('Task no longer waits for this execution')
    const merged = mergedDelivery(this.host.store, detail, task)
    if (task.deliveryMode === 'pull-request' && !merged) return ignored('Current code delivery has no verified merged pull request')
    const ticket = this.host.store.tickets.get(ticketId)
    const report = ticket?.assignments.at(-1)?.report
    const result = detail.tickets.find(item => item.id === ticketId)
    if (!report || report.state !== 'ready' || report.at !== reportAt || !result ||
      !['completed', 'merged'].includes(ticket?.ended?.outcome ?? '')) return ignored('Execution has no current successful delivery')
    const origin = ticket && this.host.store.triggers.get(ticket.origin.triggerId)
    const ownsTicket = origin?.meta.projectId === detail.id && origin.meta.projectTaskId === task.id
    const startedAt = task.executionStartedAt ?? (ownsTicket ? task.createdAt : task.updatedAt)
    if (reportAt < startedAt) return ignored('Report belongs to an earlier execution')
    if (task.reviews?.some(review => review.evidence.ticketId === ticketId && review.evidence.reportAt === reportAt))
      return ignored('This delivery already has a review history')
    if (!result.summary.trim()) return ignored('Execution report has no readable delivery summary')
    this.host.reviews.submit({ projectId: detail.id, actorId: null, operationId: event.id,
      channel: { source: 'execution', thread: detail.id, address: {} } }, task.id,
      { ticketId, reportAt, summary: result.summary.trim().slice(0, 12000), links: [...new Set([...result.pullUrls, ...(merged ? [merged.url] : [])])].slice(0, 20) })
    return { status: 'applied' as const }
  }
}
