/** Durable, event-driven project follow-up; only aggregate changes and scheduled checks wake the management Agent. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { key, type ChannelRef } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { ProjectEvent, ProjectEventDefinition } from '../sources/project-events.ts'
import type { ProjectAgent } from './project-agent.ts'
import type { ProjectEvents } from './project-events.ts'
import { ProjectError, type Project, type ProjectTask } from './projects.ts'
import type { Store } from './store.ts'
import { projectChannel } from './project-notifications.ts'

const id = z.string().min(1).max(128)
const Ready = z.strictObject({ signature: id, episode: id })
export const taskReady: ProjectEventDefinition = {
  type: 'task.ready', category: 'dependencies', schema: Ready,
  description: '项目授权推进且任务依赖已验收，唤起 Agent 判断下一步。',
  defaults: { enabled: true, instruction: '任务现在满足推进条件。结合最新目标、分工和依赖判断下一步；Agent 任务条件具备时通过 task.start 登记一次执行，人工任务提醒负责人开始。条件不足时明确缺项，必要时预约检查。不得自行验收或虚构完成。' },
  documentation: 'docs/events/follow-up.zh-CN.md',
}
const Due = z.strictObject({ checkId: id, signature: id, reason: z.string().min(1).max(2000) })
export const checkDue: ProjectEventDefinition = {
  type: 'check.due', category: 'checks', schema: Due,
  description: '一次已保存的检查时间到达，唤起 Agent 核对当前任务。',
  defaults: { enabled: true, instruction: '已到预约检查时间。先读取最新工单、交付和阻塞事实，判断是否需要向原工单补充上下文、提醒负责人或安排下一次检查。没有变化且无需行动时保持安静。不要重复启动工单，不要重复催促同一问题；只能根据真实证据推进。' },
  documentation: 'docs/events/follow-up.zh-CN.md',
}
export interface ProjectCheck { id: string; projectId: string; taskId: string; at: string; reason: string; signature: string; fired?: boolean }
interface Host { store: Store; events: ProjectEvents; agent: Pick<ProjectAgent, 'react'>; lifetime: AbortSignal; now?: () => number }
const scope = (project: Project, task: ProjectTask) => key(JSON.stringify({ repository: project.repository,
  title: task.title, description: task.description, acceptance: task.acceptance, ownerId: task.ownerId,
  deliveryMode: task.deliveryMode ?? 'report', pullRequestUrl: task.pullRequestUrl ?? null, targetBranch: task.targetBranch ?? null,
  executionMode: task.executionMode, dependencies: task.blockedBy.map(id => { const dependency = project.tasks.find(item => item.id === id); return [id, dependency?.status, dependency?.completedAt] }),
  decisions: project.decisions.filter(item => item.taskId === task.id).map(item => [item.id, item.answeredAt]) }))
const eligible = (project: Project, task: ProjectTask) => project.status === 'active' && !!project.autoAdvance && task.status === 'todo'
  && !task.ticketId && !project.decisions.some(item => item.taskId === task.id && !item.answeredAt)
  && task.blockedBy.every(id => project.tasks.some(item => item.id === id && item.status === 'done'))
const checkScope = (project: Project, task: ProjectTask) => key(scope(project, task), task.status, task.ticketId ?? '', String(task.deliveryVersion ?? 0))

/** Converts project mutations, blocker facts and durable timers into bounded Agent reactions on the ordered event queue. */
export class ProjectProgress {
  private timer?: ReturnType<typeof setTimeout>
  private readonly now: () => number
  constructor(private readonly host: Host) {
    this.now = host.now ?? Date.now
    host.events.register('project', [taskReady])
    host.events.register('clock', [checkDue])
    host.events.handle(taskReady.type, event => {
      const project = event.projectId && host.store.get(KV.projects.project(event.projectId))
      const task = project && project.tasks.find(item => item.id === event.taskId)
      return project && task && eligible(project, task) && this.current(event)
        ? { status: 'applied' } : { status: 'ignored', reason: 'Task readiness changed' }
    })
    host.events.handle(checkDue.type, event => this.current(event) ? { status: 'applied' } : { status: 'ignored', reason: 'Scheduled check is obsolete' })
    const unobserve = host.store.observe(KV.projects.project, (project, previous) => {
      if (project) this.observe(project)
      else if (previous) {
        for (const task of previous.tasks) {
          host.store.delete(KV.projects.readiness(key(previous.id, task.id)))
          host.store.delete(KV.projects.check(key(previous.id, task.id)))
        }
        host.store.afterCommit(() => this.arm())
      }
    })
    const unsubscribe = host.events.observe((event, reaction) => {
      if (![taskReady.type, checkDue.type, 'task.blocked'].includes(event.type) || !this.current(event)) return
      const project = host.store.get(KV.projects.project(event.projectId!))!
      const task = project.tasks.find(item => item.id === event.taskId)!
      // Blocked already owns the immediate notification. The follow-up Agent stays quiet unless it has a new action.
      const reactionId = event.type === 'task.blocked' ? (event.data as { noticeId: string }).noticeId : event.id
      host.agent.react(event, reaction.instruction ?? '', this.channel(project, task), reactionId)
    })
    host.lifetime.addEventListener('abort', () => { clearTimeout(this.timer); unobserve(); unsubscribe() }, { once: true })
  }

  private channel(project: Project, task: ProjectTask): ChannelRef {
    const owner = task.ownerId && this.host.store.get(KV.projects.member(task.ownerId))
    return projectChannel(this.host.store, project, owner || undefined)
  }

  /** Recover existing readiness and overdue checks once at startup; orchestration passes never scan project tasks. */
  recover(): void {
    this.host.store.atomic(() => {
      for (const entry of this.host.store.keys(KV.projects.project)) this.observe(this.host.store.get(entry)!)
    })
    this.fire()
  }

  private observe(project: Project): void {
    const { store, events } = this.host
    for (const task of project.tasks) {
      const entry = KV.projects.readiness(key(project.id, task.id))
      if (!eligible(project, task)) {
        // Keep the event's identity through the execution it started, but revoke it on pause or scope changes.
        if (!(project.status === 'active' && project.autoAdvance && task.status === 'in-progress' && store.get(entry)?.signature === scope(project, task))) store.delete(entry)
        continue
      }
      const signature = scope(project, task)
      if (store.get(entry)?.signature === signature) continue
      const episode = randomUUID()
      store.set(entry, { signature, episode })
      events.publisher('project').publish({ id: episode, type: taskReady.type, projectId: project.id, taskId: task.id, data: { signature, episode } })
    }
    for (const entry of store.keys(KV.projects.check)) {
      const check = store.get(entry)!
      if (check.projectId !== project.id) continue
      const task = project.tasks.find(item => item.id === check.taskId)
      if (project.status !== 'active' || !project.autoAdvance || !task || ['done', 'cancelled'].includes(task.status)
        || check.signature !== checkScope(project, task)) store.delete(entry)
    }
    store.afterCommit(() => this.arm())
  }

  current(event: ProjectEvent, replyOnly = false): boolean {
    const project = event.projectId && this.host.store.get(KV.projects.project(event.projectId))
    const task = project && project.tasks.find(item => item.id === event.taskId)
    if (!project || !task || project.status !== 'active' || !project.autoAdvance || ['done', 'cancelled'].includes(task.status)) return false
    if (!this.host.events.settings(event.source, event.type).enabled) return false
    if (replyOnly) return true
    if (event.type === taskReady.type) {
      const payload = Ready.parse(event.data)
      return payload.signature === scope(project, task) && this.host.store.get(KV.projects.readiness(key(project.id, task.id)))?.episode === payload.episode
    }
    if (event.type === checkDue.type) {
      const payload = Due.parse(event.data)
      return payload.signature === checkScope(project, task) && this.host.store.get(KV.projects.check(key(project.id, task.id)))?.id === payload.checkId
    }
    if (event.type === 'task.blocked') {
      const payload = event.data as { ticketId: string; assignmentId: string; reportAt: string; attentionId?: string; deliveryVersion: number }
      const ticket = this.host.store.tickets.get(payload.ticketId)
      const assignment = ticket?.assignments.at(-1)
      return task.status === 'in-progress' && (task.deliveryVersion ?? 0) === payload.deliveryVersion && ticket?.attention?.id === payload.attentionId
        && task.ticketId === ticket?.id && !ticket?.ended && assignment?.id === payload.assignmentId && assignment.report?.at === payload.reportAt
        && (assignment.report.state === 'blocked' || !!ticket?.attention)
    }
    return false
  }

  schedule(projectId: string, taskId: string, at: string, reason: string, operationId: string): ProjectCheck {
    const project = this.host.store.get(KV.projects.project(projectId))
    const task = project?.tasks.find(item => item.id === taskId)
    if (!project || !task) throw new ProjectError(404, 'Task does not belong to this project')
    if (project.status !== 'active' || !project.autoAdvance || ['done', 'cancelled'].includes(task.status))
      throw new ProjectError(409, 'Enable automatic follow-up on an active, unfinished task first')
    const time = Date.parse(z.iso.datetime().parse(at))
    if (time < this.now() + 60_000 || time > this.now() + 30 * 86400_000) throw new ProjectError(400, 'Schedule a check between one minute and thirty days from now')
    const check: ProjectCheck = { id: key('project-check', operationId), projectId, taskId, at, reason, signature: checkScope(project, task) }
    // One pending appointment per task; updating it supersedes its old event, without a recurring AI loop.
    this.host.store.set(KV.projects.check(key(projectId, taskId)), check)
    this.host.store.afterCommit(() => this.arm())
    return check
  }

  cancel(projectId: string, taskId: string): void {
    this.host.store.delete(KV.projects.check(key(projectId, taskId)))
    this.host.store.afterCommit(() => this.arm())
  }

  checks(projectId: string): ProjectCheck[] {
    return this.host.store.keys(KV.projects.check).map(entry => this.host.store.get(entry)!).filter(check => check.projectId === projectId)
  }

  private arm(): void {
    clearTimeout(this.timer)
    if (this.host.lifetime.aborted) return
    const times = this.host.store.keys(KV.projects.check).map(entry => this.host.store.get(entry)!).filter(check => !check.fired).map(check => Date.parse(check.at))
    if (!times.length) return
    this.timer = setTimeout(() => this.fire(), Math.max(1, Math.min(2 ** 31 - 1, Math.min(...times) - this.now())))
    this.timer.unref()
  }

  private fire(): void {
    if (this.host.lifetime.aborted) return
    this.host.store.atomic(() => {
      for (const entry of this.host.store.keys(KV.projects.check)) {
        const check = this.host.store.get(entry)!
        if (check.fired || Date.parse(check.at) > this.now()) continue
        this.host.events.publisher('clock').publish({ id: check.id, type: checkDue.type, projectId: check.projectId, taskId: check.taskId,
          occurredAt: check.at, data: { checkId: check.id, signature: check.signature, reason: check.reason } })
        this.host.store.set(entry, { ...check, fired: true })
      }
      this.host.store.afterCommit(() => this.arm())
    })
  }
}
