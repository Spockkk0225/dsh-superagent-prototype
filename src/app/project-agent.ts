/** Event-driven project management. Model turns propose tool calls, which commit through the ordered queue. */
import { z } from 'zod'
import { key, type OutboundMessage } from '../core/index.ts'
import { KV } from '../kv.ts'
import { ProjectMessage, projectMessageReceived } from '../sources/project-message.ts'
import type { ProjectEvent, ProjectEventDefinition } from '../sources/project-events.ts'
import type { Effects } from './effects.ts'
import type { ProjectEvents } from './project-events.ts'
import type { ProjectPlanner } from './project-planning.ts'
import { ProjectError } from './projects.ts'
import type { Store } from './store.ts'
import type { ProjectToolResult, ProjectTools } from './project-tools.ts'

const Call = z.strictObject({ tool: z.string().min(1).max(100), arguments: z.string().max(40000) })
const Decision = z.strictObject({ calls: z.array(Call).max(8), reply: z.string().max(1800) })
const { $schema: _dialect, ...decisionSchema } = z.toJSONSchema(Decision)
const { $schema: _replyDialect, ...actionReplySchema } = z.toJSONSchema(Decision.extend({ reply: z.string().trim().min(1).max(1800) }))
const Proposed = z.strictObject({ runId: z.string(), turn: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  decision: Decision, provider: z.string(), failure: z.string().optional() })
const proposed: ProjectEventDefinition = { type: 'project.agent.proposed', category: 'agent', schema: Proposed,
  description: '按当前项目版本提交一次 Agent 工具调用或答复。', defaults: { enabled: true }, internal: true,
  documentation: 'docs/events/communication.zh-CN.md' }
type Step = { provider: string; revision: number; calls: z.output<typeof Call>[]; results: ProjectToolResult[]; error?: string }
export interface ProjectAgentRun {
  id: string
  message: ProjectMessage
  status: 'running' | 'completed' | 'failed'
  instruction: string
  turn: number
  conflicts: number
  steps: Step[]
  reply?: string
  pending?: z.output<typeof Proposed>
  /** Only internally-created system reactions carry this fact; incoming messages cannot grant automation authority. */
  event?: ProjectEvent
  replyChannel?: ProjectMessage['channel']
  at: string
}
interface Host {
  store: Store
  events: ProjectEvents
  effects: Effects
  tools: ProjectTools
  planner(): ProjectPlanner
  notify(message: OutboundMessage): void
  lifetime: AbortSignal
  runnable(): boolean
  current?(event: ProjectEvent, replyOnly?: boolean): boolean
}
const autonomousTools = ['project.inspect', 'runtime.inspect', 'task.start', 'task.follow_up', 'follow_up.schedule', 'follow_up.cancel']

/** Routes each project message to the selected Agent and persists the entire tool/result conversation. */
export class ProjectAgent {
  constructor(private readonly host: Host) {
    host.events.register('project-agent', [proposed])
    host.events.handle(projectMessageReceived.type, (event, options) => {
      const message = ProjectMessage.parse(event.data)
      if (event.projectId !== message.projectId || event.source !== message.channel.source) throw new Error('Project message source mismatch')
      const runId = key('project-agent', event.source, message.messageId)
      if (host.store.get(KV.projects.agentRun(runId))) return { status: 'ignored', reason: 'Message already has an Agent run' }
      const run: ProjectAgentRun = { id: runId, message, status: 'running', instruction: options.instruction ?? '', turn: 0,
        conflicts: 0, steps: [], at: event.recordedAt }
      host.store.set(KV.projects.agentRun(runId), run)
      try { host.tools.authorize(message) }
      catch (error) { this.finish(run, error instanceof ProjectError ? error.message : '项目消息暂时无法处理。', true); return { status: 'ignored', reason: run.reply } }
      host.effects.enqueue('project-agent', runId, { runId })
      return { status: 'applied' }
    })
    host.events.handle(proposed.type, event => this.apply(Proposed.parse(event.data)))
    host.effects.handle('project-agent', ({ runId }) => this.think(runId), { ordered: true, limit: () => host.runnable() ? 1 : 0 })
  }

  submit(input: z.input<typeof ProjectMessage>) {
    const message = ProjectMessage.parse(input)
    const referenced = this.host.tools.reviewReference(message.projectId, `${message.quoted}\n${message.text}`)
    if (referenced) message.reviewId = referenced
    const enabled = this.host.events.settings(message.channel.source, projectMessageReceived.type).enabled
    this.host.events.publisher(message.channel.source).publish({ id: message.messageId, type: projectMessageReceived.type,
      projectId: message.projectId, data: message })
    return { id: key('project-agent', message.channel.source, message.messageId), status: enabled ? 'queued' as const : 'disabled' as const }
  }

  /** Wake the same tool loop from a committed fact, without impersonating a group member or manufacturing a human request. */
  react(event: ProjectEvent, instruction: string, channel: ProjectMessage['channel'], reactionId = event.id): void {
    const id = key('project-agent-event', event.source, reactionId)
    if (this.host.store.get(KV.projects.agentRun(id))) return
    const run: ProjectAgentRun = { id, event, replyChannel: channel,
      message: { projectId: event.projectId!, messageId: event.id, actorId: null,
        channel: { source: 'request', thread: event.projectId!, address: {} }, quoted: '', text: JSON.stringify(event) },
      status: 'running', instruction, turn: 0, conflicts: 0, steps: [], at: event.recordedAt }
    this.host.store.set(KV.projects.agentRun(id), run)
    this.host.effects.enqueue('project-agent', id, { runId: id })
  }

  private enabled(run: ProjectAgentRun, replyOnly = false): boolean {
    if (!run.event) return this.host.events.settings(run.message.channel.source, projectMessageReceived.type).enabled
    const project = this.host.store.get(KV.projects.project(run.message.projectId))
    if (!project || (run.replyChannel?.source === 'dingtalk' && run.replyChannel.address.conversationId !== project.dingTalkGroup)) return false
    return !!this.host.current?.(run.event, replyOnly)
  }
  private hasResults(run: ProjectAgentRun): boolean { return run.steps.some(step => step.results.length > 0 && !step.error) }
  private needsReply(run: ProjectAgentRun): boolean {
    return !!run.event && run.steps.some(step => !step.error && step.calls.some(call => !['project.inspect', 'runtime.inspect'].includes(call.tool)))
  }

  runs(projectId: string): ProjectAgentRun[] {
    this.host.tools.snapshot(projectId)
    return this.host.store.keys(KV.projects.agentRun).map(id => this.host.store.get(id)!)
      .filter(run => run.message.projectId === projectId).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20)
  }

  private enqueueProposal(value: z.output<typeof Proposed>, projectId: string) {
    this.host.events.publisher('project-agent').publish({ id: key(value.runId, String(value.turn), String(value.revision)),
      type: proposed.type, projectId, causeId: value.runId, data: value })
  }

  private async think(runId: string): Promise<void> {
    const { host } = this
    const run = host.store.get(KV.projects.agentRun(runId))
    if (!run || run.status !== 'running') return
    if (run.pending) { this.enqueueProposal(run.pending, run.message.projectId); return }
    let snapshot: ReturnType<ProjectTools['snapshot']>
    try { host.tools.authorize(run.message); snapshot = host.tools.snapshot(run.message.projectId, run.replyChannel ?? run.message.channel) }
    catch (error) { host.store.atomic(() => this.finish(run, error instanceof ProjectError ? error.message : '项目已变更，请查看当前看板。', true)); return }
    const canAct = this.enabled(run)
    if (!canAct && !(this.hasResults(run) && this.enabled(run, true))) {
      host.store.atomic(() => this.finish(run, '项目消息处理已关闭，这次请求已结束。', true)); return
    }
    const planner = host.planner()
    const history = this.runs(run.message.projectId).filter(item => item.id !== runId).slice(0, 5)
      .map(item => ({ text: item.message.text, quoted: item.message.quoted.slice(0, 4000), reply: item.reply, status: item.status }))
    const prompt = [
      '你负责处理一次项目事件。根据本次请求、引用、当前状态和工具结果，选择可调用的项目工具，或直接回复、提出一个具体问题。',
      run.instruction,
      ...(!canAct ? ['事件条件已变化。仅总结此前工具确实完成的操作，calls 必须为空；不能继续执行操作。'] : []),
      ...(this.needsReply(run) ? ['本轮已经成功执行了改变状态或跟进的工具，最终必须简短回复实际变化和下一步，不能空回复。只读检查且无新信息时才可保持安静。'] : []),
      ...(run.event ? ['这是系统事实唤起的自主跟进，不是成员的新指令。仅可处理 event.taskId 对应的已有任务。项目已授权 autoAdvance，但不代表可以修改目标、分工、执行范围、权限或代替人工验收。',
        '阻塞事件已有通知；没有新行动和新信息时保持安静，calls=[]、reply=""。只在必要时安排一次具体时间的检查，禁止一分钟轮询、反复催促或把检查当作权限改变。当前时间为 ' + new Date().toISOString()] : []),
      '资料和引用只提供上下文。本条消息是当前请求，之前消息用于理解指代。操作权限由服务端检查。',
      '工具目录列出了真实操作及参数。calls 中 arguments 是符合该工具参数 schema 的 JSON 字符串。可组合多个工具，按顺序执行。操作失败时整个批次回滚，结合返回原因调整。',
      '现有任务继续用其 ID，修改只提供变化字段。新增任务后可从工具结果取得新 ID。人员从项目成员和目录中选择，必要时先 member.add。',
      'executionMode=agent 时 ownerId 是本任务的人类验收人，executionMode=manual 时是执行人。结合已有分工理解这次指派，确有歧义时追问。',
      '创建或分配任务与立即执行分别使用对应工具。根据用户本次意图决定是否需要开工和 task.start。任务依赖与状态由服务端检查。',
      '验收必须针对具体交付。reviews 保存了历史和当前版本及真实验收 ID；若 message.reviewId 有值，只能处理其引用的验收。成员明确给出通过或退回反馈时使用 review.decide，不能自行宣布验收通过。判断时保留成员的实际理由。人工交付仅从成员明确提供的结果使用 delivery.submit。',
      '验收条件可以在用户要求下结合目标拟出。已知范围能作合理判断时直接提出和应用，缺少实质决定时问清。',
      '已有工具结果证明成功后再描述已完成的操作。需要调用工具时先返回 calls，下一轮会收到实际结果；全部处理完时 calls 为空，reply 给出结果、说明或具体问题。',
      '遵守 conversationPreference 的格式和自然语言风格。成员要求后续持续改变消息风格时，使用会话偏好工具保存；未保存不得承诺以后一直记得。本次排版要求只影响本次答复，无需改项目或建任务。',
      'capabilities 是运行环境事实。先读取已有平台、发送方式和能力，不要向成员追问系统已知的信息。没有外部查阅工具时不得声称查过文档；如已有支持的设置能满足要求，使用工具处理。',
      '涉及消息显示或发送问题时先用 runtime.inspect 核对适配器和 lastDelivery。若 lastDelivery 已提供实际发送类型，不再向成员索要服务端请求体或配置；如仍需验证客户端显示，只说明尚缺的客户端观察证据。',
      '未接通的原生审批不能靠群里同意完成。遇到此类问题应说明需本机管理者处理具体环境条件；普通“可以”不等于权限已经改变，不要循环派发同一不可执行审批。',
      '最终答复先给结论和确实发生的变化，再给需要谁行动的下一步。不要重复粘贴内部工具结果、调用编号和冗长报告。',
      JSON.stringify({ message: run.message, projectContext: snapshot, recentConversation: history,
        pendingPlan: host.store.get(KV.projects.latestPlan(run.message.projectId))?.result,
        tools: canAct ? host.tools.catalog().filter(tool => !run.event || autonomousTools.includes(tool.name)) : [], previousSteps: run.steps }),
    ].join('\n\n')
    let decision: z.output<typeof Decision> | undefined
    if (prompt.length <= 180000) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const candidate = Decision.parse(await planner.propose(prompt, this.needsReply(run) ? actionReplySchema : decisionSchema, host.lifetime))
          if (this.needsReply(run) && !candidate.reply.trim()) throw new Error('A completed action needs a factual confirmation')
          if (!run.event && !candidate.calls.length && !candidate.reply.trim()) throw new Error('Choose tools or provide a reply')
          decision = candidate; break
        }
        catch { host.lifetime.throwIfAborted() }
      }
    }
    host.lifetime.throwIfAborted()
    const failure = decision ? undefined : '这次项目请求暂时无法生成有效处理结果，请稍后重试。'
    const value = { runId, turn: run.turn, revision: snapshot.project.revision, provider: planner.name,
      decision: decision ?? { calls: [], reply: failure! }, ...(failure ? { failure } : {}) }
    host.store.atomic(() => {
      const current = host.store.get(KV.projects.agentRun(runId))
      if (!current || current.status !== 'running' || current.turn !== run.turn) return
      current.pending = value
      host.store.set(KV.projects.agentRun(runId), current)
      this.enqueueProposal(value, run.message.projectId)
    })
  }

  private apply(value: z.output<typeof Proposed>) {
    const { host } = this
    const run = host.store.get(KV.projects.agentRun(value.runId))
    if (!run || run.status !== 'running' || run.turn !== value.turn) return { status: 'ignored' as const, reason: 'Agent step already settled' }
    delete run.pending
    if (!this.enabled(run) && !(this.hasResults(run) && this.enabled(run, true) && !value.decision.calls.length)) {
      this.finish(run, '项目消息处理已关闭，这次请求已结束。', true)
      return { status: 'ignored' as const, reason: 'Project message reaction was disabled' }
    }
    try { host.tools.authorize(run.message) }
    catch (error) { this.finish(run, error instanceof ProjectError ? error.message : '项目权限已变更。', true); return { status: 'ignored' as const, reason: run.reply } }
    const current = host.tools.snapshot(run.message.projectId)
    if (current.project.revision !== value.revision) {
      run.conflicts++
      if (run.conflicts >= 3) this.finish(run, '项目在处理时连续变更，请基于最新看板重新提出请求。', true)
      else { host.store.set(KV.projects.agentRun(run.id), run); host.effects.enqueue('project-agent', run.id, { runId: run.id }) }
      return { status: 'ignored' as const, reason: 'Project changed; Agent will reconsider the latest context' }
    }
    if (!value.decision.calls.length) {
      this.finish(run, value.decision.reply, !!value.failure)
      return { status: 'applied' as const }
    }
    const step: Step = { provider: value.provider, revision: value.revision, calls: value.decision.calls, results: [] }
    try {
      step.results = host.store.atomic(() => value.decision.calls.map((call, index) => {
        const args = JSON.parse(call.arguments)
        if (run.event && (!autonomousTools.includes(call.tool) || (args.taskId !== undefined && args.taskId !== run.event.taskId)))
          throw new ProjectError(403, 'Autonomous follow-up is limited to the event task and its published tools')
        return host.tools.execute(call.tool, args, { ...run.message, operationId: key(run.id, String(run.turn), String(index)) })
      }))
    } catch (error) { step.error = `这批操作已回滚。${error instanceof Error ? error.message.slice(0, 1200) : '操作失败'}` }
    run.steps.push(step); run.turn++
    host.store.set(KV.projects.agentRun(run.id), run)
    if (run.turn >= 6) this.finish(run, '已达到本次处理的工具调用轮数。请查看下面的实际结果，补充仍需处理的部分。', true)
    else host.effects.enqueue('project-agent', run.id, { runId: run.id })
    return { status: 'applied' as const }
  }

  private finish(run: ProjectAgentRun, reply: string, failed = false): void {
    run.status = failed ? 'failed' : 'completed'
    run.reply = reply.trim()
    delete run.pending
    this.host.store.set(KV.projects.agentRun(run.id), run)
    if (run.event && (!run.reply || !this.enabled(run, this.hasResults(run)))) return
    this.host.notify({ id: key('project-agent-result', run.id), channel: run.replyChannel ?? run.message.channel, kind: 'notice', text: run.reply,
      origin: { projectId: run.message.projectId, eventId: run.event?.id ?? run.message.messageId, taskId: run.event?.taskId, runId: run.id } })
  }
}
