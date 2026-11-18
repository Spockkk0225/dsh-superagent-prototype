/** Auditable project history joins committed facts, Agent decisions, scheduled checks and actual remote receipts. */
import { z } from 'zod'
import { key } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { ProjectEventDefinition } from '../sources/project-events.ts'
import type { ProjectEvents } from './project-events.ts'
import type { Store } from './store.ts'
import { Projects, type Project } from './projects.ts'
import type { ProjectAgentRun } from './project-agent.ts'
import { taskRemoteFacts } from './repository-delivery.ts'

const changed: ProjectEventDefinition = { type: 'project.changed', category: 'history', internal: true,
  description: '保存已提交的项目变化及来源因果。', schema: z.strictObject({ revision: z.number(), reason: z.string(), tasks: z.array(z.string()),
    changes: z.array(z.strictObject({ field: z.string(), before: z.unknown().optional(), after: z.unknown().optional() })) }),
  defaults: { enabled: true }, documentation: 'docs/events/project-history.zh-CN.md' }
const imported: ProjectEventDefinition = { type: 'project.history.imported', category: 'history', internal: true,
  description: '记录存量基线，不重放验收或远端操作。', schema: z.strictObject({ revision: z.number(), reason: z.string(), tasks: z.array(z.strictObject({ id: z.string(), title: z.string(), status: z.string(), issueRole: z.string() })) }),
  defaults: { enabled: true }, documentation: 'docs/events/project-history.zh-CN.md' }

/** Records mutation facts transactionally and exposes causally linked outcomes without changing historical task state. */
export class ProjectHistory {
  constructor(private readonly store: Store, private readonly events: ProjectEvents, lifetime: AbortSignal) {
    events.register('history', [changed, imported])
    for (const type of [changed.type, imported.type]) events.handle(type, () => ({ status: 'applied' }))
    const unobserve = store.observe(KV.projects.project, (project, previous) => {
      if (!project) return
      const changes: { field: string; before: unknown; after: unknown }[] = ['name', 'objective', 'status', 'repository', 'autoAdvance', 'memberIds', 'milestones', 'decisions']
        .filter(field => JSON.stringify(previous?.[field as keyof Project]) !== JSON.stringify(project[field as keyof Project]))
        .map(field => ({ field, before: previous?.[field as keyof Project], after: project[field as keyof Project] }))
      const tasks = project.tasks.filter(task => JSON.stringify(previous?.tasks.find(item => item.id === task.id)) !== JSON.stringify(task))
      for (const task of tasks) changes.push({ field: `task/${task.id}`, before: previous?.tasks.find(item => item.id === task.id), after: task })
      if (!changes.length) return
      events.publisher('history').publish({ id: key(project.id, String(project.revision), JSON.stringify(changes)), type: changed.type, projectId: project.id,
        causeId: events.processing()?.id,
        data: { revision: project.revision, reason: previous ? '项目变更已提交' : '项目已创建', tasks: tasks.map(task => task.id), changes } })
    })
    lifetime.addEventListener('abort', unobserve, { once: true })
  }

  /** One-time, per-project baseline import; does not turn historical completion into a fresh acceptance or remote write. */
  recover(): void {
    this.store.atomic(() => {
      for (const entry of this.store.keys(KV.projects.project)) {
        const project = this.store.get(entry)!
        if (this.store.get(KV.projects.historyBaseline(project.id))) continue
        this.events.publisher('history').publish({ id: key('project-history-baseline', project.id), type: imported.type, projectId: project.id,
          data: { revision: project.revision, reason: '导入已有状态；历史 Issue 关联未明确负责解决时按仅参考处理，不补发验收或关闭动作。',
            tasks: project.tasks.map(task => ({ id: task.id, title: task.title, status: task.status, issueRole: task.issueRole ?? 'reference' })) } })
        this.store.set(KV.projects.historyBaseline(project.id), true)
      }
    })
  }

  view(projectId: string, before?: number) {
    const project = new Projects(this.store).detail(projectId)
    const events = this.events.list({ projectId, limit: 100, before })
    const runs = this.store.keys(KV.projects.agentRun).map(entry => this.store.get(entry)!)
      .filter(run => run.message.projectId === projectId)
    const descriptions = new Map(this.events.view().sources.flatMap(source => source.events
      .map(event => [`${source.source}:${event.type}`, event.effective.description] as const)))
    const entries = events.map(event => {
      const data = event.data as Record<string, unknown>
      const linked = runs.filter(run => run.event?.id === event.id || run.message.messageId === event.id ||
        (typeof data.messageId === 'string' && run.message.messageId === data.messageId) ||
        (typeof data.runId === 'string' && data.runId === run.id) ||
        (!!event.causeId && (run.event?.id === event.causeId || run.id === event.causeId)))
      const label = descriptions.get(`${event.source}:${event.type}`)
      return { event, label: label ?? (event.type === changed.type ? '项目变更已提交' : event.type === imported.type ? '存量基线已导入' : event.type),
        reason: event.reason || (typeof data.reason === 'string' ? data.reason : typeof data.text === 'string' ? data.text : undefined),
        decisions: linked.map((run: ProjectAgentRun) => ({ id: run.id, status: run.status, reply: run.reply, trigger: run.event?.type ?? 'project.message.received',
          steps: run.steps.map(step => ({ provider: step.provider, calls: step.calls, results: step.results, error: step.error })) })) }
    })
    return { entries, next: events.length === 100 ? events.at(-1)!.seq : null,
      notifications: this.store.receipts.forProject(projectId).map(item => ({ id: item.id, origin: item.origin!, status: item.status,
        source: item.channel.source, format: item.format ?? 'text', text: item.text, dropped: item.dropped })),
      synchronization: this.store.keys(KV.projects.issueSync).map(entry => this.store.get(entry)!).filter(item => item.projectId === projectId),
      remote: project.tasks.flatMap(task => taskRemoteFacts(this.store, project, task).map(fact => ({ taskId: task.id, ...fact }))),
      checks: this.store.keys(KV.projects.check).map(entry => this.store.get(entry)!).filter(check => check.projectId === projectId) }
  }
}
