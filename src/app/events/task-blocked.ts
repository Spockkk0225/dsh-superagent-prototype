import { z } from 'zod'
import { key, type OutboundMessage, type Ticket } from '../../core/index.ts'
import { KV } from '../../kv.ts'
import type { ProjectEvent, ProjectEventDefinition } from '../../sources/project-events.ts'
import { announce } from '../project-notifications.ts'
import { taskReference } from '../project-task-context.ts'
import type { ProjectEvents } from '../project-events.ts'
import type { Store } from '../store.ts'
import { workerSessionId } from '../../executor/dsh.ts'

const id = z.string().min(1).max(128)
const Payload = z.strictObject({ ticketId: id, assignmentId: id, reportAt: z.iso.datetime(),
  attentionId: id.optional(), noticeId: id, signature: id, deliveryVersion: z.number().int().nonnegative() })
export const taskBlocked: ProjectEventDefinition = {
  type: 'task.blocked', category: 'blockers', description: '当前工单报告受阻或等待人工回答，向项目群通知具体原因及问题。',
  schema: Payload, defaults: { enabled: true, instruction: '核对本次阻塞与当前执行能力。能用已知证据解决时向原工单补充信息；需要人工信息或环境处理时明确说明负责人和下一步。不得代替人授权、验收或反复重试不可执行操作；必要时预约一次后续检查。' }, documentation: 'docs/events/task-blocked.zh-CN.md',
}
export interface ProjectBlockage { ticketId: string; assignmentId: string; signature: string; noticeId: string }
interface Host {
  store: Store
  events: ProjectEvents
  notify(message: OutboundMessage): void
  withdraw(id: string): void
}
const blocked = (ticket: Ticket) => !ticket.ended && !!ticket.assignments.at(-1)?.report
  && (ticket.assignments.at(-1)!.report!.state === 'blocked' || !!ticket.attention)
const signatureOf = (ticket: Ticket) => ticket.attention ? key('attention', ticket.attention.id)
  : key('reason', ticket.assignments.at(-1)?.report?.summary.trim() ?? '')

/** Converts current worker blockers into ordered project events and one durable notification per active problem. */
export class TaskBlocked {
  constructor(private readonly host: Host) {
    host.events.handle(taskBlocked.type, event => this.apply(event))
  }

  /** Called in the report's source transaction; recovery calls the same producer with persisted facts. */
  observe(ticketId: string): void {
    const { store, events } = this.host
    const ticket = store.tickets.get(ticketId)
    if (!ticket) return
    if (!blocked(ticket)) store.delete(KV.sessions.unavailableAction(workerSessionId(ticketId)))
    for (const projectKey of store.keys(KV.projects.project)) {
      const project = store.get(projectKey)!
      for (const task of project.tasks) {
        if (task.ticketId !== ticketId) continue
        const stateKey = KV.projects.blockage(key(project.id, task.id))
        const previous = store.get(stateKey)
        const assignment = ticket.assignments.at(-1)
        const report = assignment?.report
        if (project.status === 'archived' || task.status !== 'in-progress' || !blocked(ticket) || !assignment || !report) {
          if (previous) { this.host.withdraw(previous.noticeId); store.delete(stateKey) }
          continue
        }
        const signature = signatureOf(ticket)
        const continuing = previous?.ticketId === ticketId && previous.assignmentId === assignment.id && previous.signature === signature
        if (previous && !continuing) this.host.withdraw(previous.noticeId)
        const noticeId = continuing ? previous.noticeId : key('project-task-blocked-notice', project.id, task.id, ticketId, assignment.id, report.at, signature)
        store.set(stateKey, { ticketId, assignmentId: assignment.id, signature, noticeId })
        events.publisher('execution').publish({ id: key('project-task-blocked', project.id, task.id, ticketId, assignment.id, report.at, signature),
          type: taskBlocked.type, projectId: project.id, taskId: task.id, occurredAt: report.at,
          data: { ticketId, assignmentId: assignment.id, reportAt: report.at, noticeId, signature, deliveryVersion: task.deliveryVersion ?? 0,
            ...(ticket.attention ? { attentionId: ticket.attention.id } : {}) } })
      }
    }
  }

  recover(): void {
    const pending = new Set(this.host.store.keys(KV.projects.project).flatMap(projectKey => this.host.store.get(projectKey)!.tasks
      .flatMap(task => task.ticketId ? [task.ticketId] : [])))
    this.host.store.atomic(() => { for (const ticketId of pending) this.observe(ticketId) })
  }

  private apply(event: ProjectEvent) {
    const ignored = (reason: string) => ({ status: 'ignored' as const, reason })
    const payload = Payload.parse(event.data)
    const { store } = this.host
    const project = event.projectId && store.get(KV.projects.project(event.projectId))
    const task = project && project.tasks.find(item => item.id === event.taskId)
    if (!project || project.status === 'archived' || !task || task.status !== 'in-progress' || task.ticketId !== payload.ticketId)
      return ignored('Task no longer waits for this execution')
    if ((task.deliveryVersion ?? 0) !== payload.deliveryVersion) return ignored('Delivery version changed')
    const ticket = store.tickets.get(payload.ticketId)
    const assignment = ticket?.assignments.at(-1)
    const report = assignment?.report
    if (!ticket || !blocked(ticket) || !report || assignment?.id !== payload.assignmentId || report.at !== payload.reportAt ||
      ticket.attention?.id !== payload.attentionId || signatureOf(ticket) !== payload.signature) return ignored('Blocker was answered, replaced or no longer current')
    const origin = store.triggers.get(ticket.origin.triggerId)
    const ownsTicket = origin?.meta.projectId === project.id && origin.meta.projectTaskId === task.id
    const startedAt = task.executionStartedAt ?? (ownsTicket ? task.createdAt : task.updatedAt)
    if (report.at < startedAt) return ignored('Report belongs to an earlier execution')
    const owner = task.ownerId ? store.get(KV.projects.member(task.ownerId)) : undefined
    const unavailable = store.get(KV.sessions.unavailableAction(workerSessionId(ticket.id)))
    const nativeAction = unavailable && unavailable.at >= startedAt
    const action = nativeAction ? '本运行环境没有原生审批桥接，群内回复同意不会授权。请本机管理者核对执行限制、配置明确的命令规则，或在本机完成该步骤后提供结果。'
      : ticket.attention?.question ?? '请核对任务详情中的原因，补充所需信息或处理执行条件后继续当前任务。'
    // The outbox stores its own stable receipt; repeated reports about the same active question reuse this notice.
    announce(this.host, { ...project, members: [], tickets: [] }, payload.noticeId, {
      title: `「${project.name}」· ${task.title}`, status: ticket.attention ? '正在等待人工回答' : '执行受阻',
      summary: '工单受阻，尚未完成交付。', action, evidence: report.summary,
      reference: `${taskReference(task.id)} · 工单 ${ticket.id.slice(0, 12)} · 交付第 ${payload.deliveryVersion || 1} 版`,
      details: `项目看板 →「${project.name}」→「${task.title}」→ Agent 执行记录。`,
    }, owner)
    return { status: 'applied' as const }
  }
}
