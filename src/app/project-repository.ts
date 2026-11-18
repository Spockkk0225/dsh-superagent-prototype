/** Ordered repository observations and durable post-acceptance Issue synchronization. */
import { z } from 'zod'
import { key } from '../core/index.ts'
import { KV } from '../kv.ts'
import { CliError, type Commands } from '../infra/commands.ts'
import { RepositoryFact, changeObserved, issueObserved } from '../sources/repository-events.ts'
import type { ProjectEvent, ProjectEventDefinition } from '../sources/project-events.ts'
import type { Store } from './store.ts'
import { currentReview } from './project-deliveries.ts'
import { Projects } from './projects.ts'
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
export interface IssueSync { id: string; projectId: string; taskId: string; reviewId: string; url: string; repository: string; version: number;
  status: 'pending' | 'succeeded' | 'retrying' | 'failed' | 'cancelled'; attempts: number; reason: string; updatedAt: string }
interface Host { store: Store; events: ProjectEvents; effects: Effects; commands: Pick<Commands, 'forRepository'>; delivery: Pick<DeliveryReady, 'observe'>; runnable?(): boolean }
const Remote = z.looseObject({ state: z.enum(['open', 'closed']), state_reason: z.string().nullish(), html_url: z.url(), updated_at: z.iso.datetime(), pull_request: z.unknown().optional() })

/** Joins remote code facts with current delivery and synchronizes only explicit, newly accepted Issue-resolution mandates. */
export class ProjectRepository {
  constructor(private readonly host: Host) {
    host.events.register('repository', [issueCloseRequested, syncResult, issueObserved, changeObserved])
    host.events.handle(issueObserved.type, event => this.observe(event))
    host.events.handle(changeObserved.type, event => this.observe(event))
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
    host.events.observe(event => {
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
