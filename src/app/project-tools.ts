/** Project operations exposed to the management Agent, using the same domain methods as the board. */
import { z } from 'zod'
import { KV } from '../kv.ts'
import type { ChannelRef } from '../core/index.ts'
import { ProjectChange, ProjectError, Projects, TaskInput, type ProjectDetail } from './projects.ts'
import type { ProjectIssues } from './project-issues.ts'
import type { Store } from './store.ts'
import { ReviewEvidence, type ProjectReviews } from './project-reviews.ts'
import { CommunicationPreference, type Communication } from './communication.ts'
import type { ProjectProgress } from './project-progress.ts'
import { taskRemoteFacts } from './repository-delivery.ts'

const id = z.string().min(1).max(128)
const editable = TaskInput.omit({ status: true, ticketId: true })
const patch = z.strictObject(Object.fromEntries(Object.entries(editable.shape)
  .map(([key, value]) => [key, (value instanceof z.ZodDefault ? value.removeDefault() : value).optional()])) as Record<string, z.ZodType>)
  .refine(value => Object.values(value).some(item => item !== undefined), 'Supply at least one task field')

export interface ProjectToolContext {
  projectId: string
  /** Null identifies the trusted local management API operator. Group requests always carry a member ID. */
  actorId: string | null
  messageId: string
  operationId: string
  channel: ChannelRef
  reviewId?: string
}
export interface ProjectToolResult { summary: string; data?: unknown }
export interface ProjectOperation {
  name: string
  description: string
  schema: z.ZodType
  execute(context: ProjectToolContext, args: unknown): ProjectToolResult
}
export interface ProjectToolsHost {
  store: Store
  issues: Pick<ProjectIssues, 'request'>
  reviews: ProjectReviews
  communication: Communication
  capabilities(channel?: ChannelRef): unknown
  progress?(): ProjectProgress | undefined
  start(projectId: string, taskId: string, revision: number): ProjectDetail
  stop(projectId: string, taskId: string, ticketId: string): ProjectDetail
  follow(projectId: string, taskId: string, ticketId: string, text: string): ProjectDetail
}

function operation<S extends z.ZodType>(name: string, description: string, schema: S,
  execute: (context: ProjectToolContext, args: z.output<S>) => ProjectToolResult): ProjectOperation {
  return { name, description, schema, execute: (context, args) => execute(context, args as z.output<S>) }
}

/** Holds executable tool contracts. The Agent chooses and combines operations from the published catalog. */
export class ProjectTools {
  private readonly projects: Projects
  private readonly operations = new Map<string, ProjectOperation>()
  constructor(private readonly host: ProjectToolsHost) {
    this.projects = new Projects(host.store)
    const change = (context: ProjectToolContext, update: ProjectChange['change']) => this.projects.change(context.projectId,
      ProjectChange.parse({ revision: this.projects.detail(context.projectId).revision, change: update }))
    const task = (context: ProjectToolContext, taskId: string) => {
      const found = this.projects.detail(context.projectId).tasks.find(item => item.id === taskId)
      if (!found) throw new ProjectError(404, 'Task does not belong to this project')
      return found
    }
    this.register(operation('project.inspect', '读取当前项目、任务、执行报告、成员及团队目录。', z.strictObject({}), context => ({
      summary: '已读取项目现状', data: this.snapshot(context.projectId, context.channel),
    })))
    this.register(operation('runtime.inspect', '读取真实运行能力、消息通道、格式支持、最近成功发送的实际格式和原生审批限制；不能修改权限或假装已查阅外部文档。', z.strictObject({}), context => ({
      summary: '已读取运行能力', data: host.capabilities(context.channel),
    })))
    this.register(operation('follow_up.schedule', '为当前任务预约一次后续检查；到时由事件唤起 Agent，而非持续扫描。每个任务保留一个预约，新预约替换旧预约；自动推进须已授权。',
      z.strictObject({ taskId: id, at: z.iso.datetime(), reason: z.string().trim().min(1).max(2000) }), (context, args) => {
        task(context, args.taskId)
        const progress = host.progress?.()
        if (!progress) throw new ProjectError(409, 'Autonomous follow-up is unavailable')
        return { summary: '已保存一次后续检查预约', data: progress.schedule(context.projectId, args.taskId, args.at, args.reason, context.operationId) }
      }))
    this.register(operation('follow_up.cancel', '取消当前任务尚待处理的检查预约。', z.strictObject({ taskId: id }), (context, args) => {
      task(context, args.taskId)
      host.progress?.()?.cancel(context.projectId, args.taskId)
      return { summary: '已取消检查预约' }
    }))
    this.register(operation('conversation.preferences.inspect', '读取当前会话已保存的沟通偏好及修订号；会话偏好独立于项目保存。', z.strictObject({}), context => ({
      summary: '已读取本会话沟通偏好', data: host.communication.read(context.channel),
    })))
    this.register(operation('conversation.preferences.update', '根据成员明确要求持久保存当前会话的格式和风格偏好。仅影响本会话；不是任务变更，也不改变执行权限。',
      z.strictObject({ revision: z.number().int().nonnegative(), value: CommunicationPreference }), (context, args) => ({
        summary: '会话偏好更新已登记；确认保存结果后再承诺后续生效。', data: host.communication.update(context, args.revision, args.value),
      })))
    this.register(operation('member.add', '把团队目录中已有的成员加入当前项目。', z.strictObject({ memberId: id }), (context, args) => {
      const result = change(context, { kind: 'add-member', memberId: args.memberId })
      return { summary: `已将「${result.members.find(member => member.id === args.memberId)!.name}」加入项目` }
    }))
    this.register(operation('task.create', '新建一项任务。执行方式、人员、验收条件和依赖均由参数明确指定。', editable, (context, args) => {
      const result = change(context, { kind: 'task', value: args })
      const created = result.tasks.at(-1)!
      return { summary: `已创建「${created.title}」`, data: created }
    }))
    this.register(operation('task.update', '修改现有任务，包括验收条件、分工、执行方式、截止日期和依赖。只改变提供的字段。',
      z.strictObject({ taskId: id, changes: patch }), (context, args) => {
        const current = task(context, args.taskId)
        const fields = Object.fromEntries(Object.entries(args.changes).filter(([, value]) => value !== undefined))
        const active = this.projects.detail(context.projectId).tickets.some(item => !item.ended && (item.id === current.ticketId || item.taskId === current.id))
        if (active && ['title', 'description', 'acceptance', 'executionMode', 'blockedBy', 'deliveryMode', 'pullRequestUrl', 'targetBranch'].some(field => field in fields))
          throw new ProjectError(409, 'This task is executing. Stop the current execution before changing its delivery scope.')
        const result = change(context, { kind: 'task', id: args.taskId, value: { ...TaskInput.strip().parse(current), ...fields } })
        return { summary: `已更新「${current.title}」`, data: result.tasks.find(item => item.id === args.taskId) }
      }))
    this.register(operation('project.update', '更新项目说明、目标或推进状态。开工与任务派工是独立操作，可在同一批工具调用中完成。',
      z.strictObject({ name: z.string().trim().min(1).max(200).optional(), description: z.string().max(20000).optional(),
        objective: z.string().max(20000).optional(), status: z.enum(['planning', 'active', 'paused']).optional(), autoAdvance: z.boolean().optional() })
        .refine(value => Object.keys(value).length > 0, 'Supply at least one project field'), (context, args) => {
        const current = this.projects.detail(context.projectId)
        const fields = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
        const result = change(context, { kind: 'project', value: { name: current.name, description: current.description,
          objective: current.objective, status: current.status, ...fields } })
        return { summary: `已更新项目「${result.name}」`, data: { status: result.status, objective: result.objective, autoAdvance: result.autoAdvance } }
      }))
    this.register(operation('task.start', '启动指定任务的 Agent 执行。项目须已开工，依赖须已验收，人工任务使用人工执行方式。',
      z.strictObject({ taskId: id }), (context, args) => {
        task(context, args.taskId)
        const result = host.start(context.projectId, args.taskId, this.projects.detail(context.projectId).revision)
        const started = result.tasks.find(item => item.id === args.taskId)!
        return { summary: `已为「${started.title}」登记 Agent 执行`, data: { taskId: started.id, ticketId: started.ticketId, status: started.status } }
      }))
    this.register(operation('task.stop', '停止任务当前工单。保留已经产生的结果和历史。', z.strictObject({ taskId: id }), (context, args) => {
      const current = task(context, args.taskId)
      if (!current.ticketId) throw new ProjectError(409, 'Task has no execution ticket')
      host.stop(context.projectId, current.id, current.ticketId)
      return { summary: `已停止「${current.title}」的当前执行` }
    }))
    this.register(operation('task.follow_up', '向该任务正在执行的 Agent 补充上下文或回答阻塞问题。',
      z.strictObject({ taskId: id, text: z.string().trim().min(1).max(8000) }), (context, args) => {
        const current = task(context, args.taskId)
        if (!current.ticketId) throw new ProjectError(409, 'Task has no execution ticket')
        host.follow(context.projectId, current.id, current.ticketId, args.text)
        return { summary: `已将补充信息交给「${current.title}」的执行 Agent` }
      }))
    this.register(operation('delivery.submit', '提交人工任务的交付证据并请求验收。仅提交成员明确提供的结果，不得自行编造已完成的产物。Agent 任务由成功工单自动发起验收。',
      ReviewEvidence.extend({ taskId: id }), (context, { taskId, ...evidence }) => ({
        summary: '人工交付的验收请求已登记，状态以事件处理结果为准。', data: host.reviews.submit(context, taskId, evidence),
      })))
    this.register(operation('review.decide', '根据成员对具体交付的明确反馈，提交通过或退回验收。必须使用该交付的真实验收 ID、明确理由；只有指定负责人或本地管理者可以验收。不得将旧引用替换为新版，不得代替人自行通过验收。',
      z.strictObject({ taskId: id, reviewId: id, outcome: z.enum(['accepted', 'rejected']), reason: z.string().trim().min(1).max(8000) }),
      (context, args) => ({ summary: '验收决定已登记，状态以事件处理结果为准。',
        data: host.reviews.decide({ ...context, replyOwner: 'agent' }, args.taskId, args.reviewId, args.outcome, args.reason, context.reviewId) })))
    this.register(operation('issue.create', '为当前任务建立或取回 GitHub Issue。使用项目绑定仓库，创建结果通过现有可靠队列回写。',
      z.strictObject({ taskId: id }), (context, args) => {
        const current = task(context, args.taskId)
        const result = host.issues.request({ projectId: context.projectId, taskId: current.id, actorId: context.actorId,
          messageId: context.operationId, channel: context.channel })
        return { summary: result ?? `正在为「${current.title}」创建 Issue`, data: { taskId: current.id, issueUrl: current.issueUrl } }
      }))
  }

  reviewReference(projectId: string, quoted: string): string | undefined { return this.host.reviews.reference(projectId, quoted) }

  register(tool: ProjectOperation): void {
    if (this.operations.has(tool.name)) throw new Error(`Project tool already registered: ${tool.name}`)
    this.operations.set(tool.name, tool)
  }

  catalog() {
    return [...this.operations.values()].map(tool => ({ name: tool.name, description: tool.description,
      parameters: z.toJSONSchema(tool.schema, { io: 'input' }) }))
  }

  snapshot(projectId: string, channel?: ChannelRef) {
    const project = this.projects.detail(projectId)
    return { now: new Date().toISOString(), project, directory: this.projects.members().map(({ id, name }) => ({ id, name })), capabilities: this.host.capabilities(channel),
      conversationPreference: channel ? this.host.communication.read(channel) : undefined,
      scheduledChecks: this.host.progress?.()?.checks(projectId) ?? [],
      repositoryFacts: project.tasks.flatMap(task => taskRemoteFacts(this.host.store, project, task).map(fact => ({ taskId: task.id, ...fact }))),
      synchronization: this.host.store.keys(KV.projects.issueSync).map(entry => this.host.store.get(entry)!).filter(item => item.projectId === projectId) }
  }

  authorize(context: Pick<ProjectToolContext, 'projectId' | 'actorId' | 'channel'>): void {
    const project = this.projects.detail(context.projectId)
    if (context.actorId === null && context.channel.source === 'request') return
    if (!context.actorId || !project.memberIds.includes(context.actorId)) throw new ProjectError(403, '请先登记为这个项目的成员。')
    if (context.channel.source === 'dingtalk' && context.channel.address.conversationId !== project.dingTalkGroup)
      throw new ProjectError(403, '这条消息来自另一个项目群。')
  }

  execute(name: string, args: unknown, context: ProjectToolContext): ProjectToolResult {
    this.authorize(context)
    const tool = this.operations.get(name)
    if (!tool) throw new ProjectError(400, `Unknown project tool: ${name}`)
    return tool.execute(context, tool.schema.parse(args))
  }
}
