/** Shared repository-source template: adapters implement protocol reads; ordering, binding cursors and durable publication live here. */
import { key } from '../core/index.ts'
import { family } from '../kv.ts'
import type { SourceContext } from './host.ts'
import { changeObserved, feedbackReceived, issueObserved, type ProjectRepositoryTarget, type RepositoryFact, type RepositoryFeedback } from './repository-events.ts'

export type RepositoryResource = { repository: string; url: string; kind: 'issue' | 'change' }
const cursors = family<{ at: string }, [string]>('repository-feedback-cursor:')

/** Template method for any repository provider, independent of its API endpoints, pagination and reply addressing. */
export abstract class RepositorySource {
  abstract readonly kind: string
  protected abstract accepts(resource: RepositoryResource): boolean
  protected abstract read(context: SourceContext, resource: RepositoryResource, signal?: AbortSignal): Promise<Omit<RepositoryFact, 'deliveryVersion' | 'ticketId'>>
  protected abstract feedback(context: SourceContext, resource: RepositoryResource, since: string, signal?: AbortSignal): Promise<Omit<RepositoryFeedback, 'deliveryVersion' | 'ticketId'>[]>

  async poll(context: SourceContext, signal?: AbortSignal): Promise<void> {
    if (!context.projectEvents || !context.projectResources || !context.config(this.kind)) return
    const resources = new Map<string, { resource: RepositoryResource; targets: ProjectRepositoryTarget[] }>()
    for (const target of context.projectResources()) for (const [kind, urls] of [['issue', target.issueUrl ? [target.issueUrl] : []], ['change', target.pullUrls]] as const) {
      for (const url of urls) {
        if (!this.accepts({ repository: target.repository, url, kind })) continue
        const id = key(this.kind, target.repository.toLowerCase(), url)
        const item = resources.get(id) ?? { resource: { repository: target.repository, url, kind }, targets: [] }
        item.targets.push(target); resources.set(id, item)
      }
    }
    const failures: unknown[] = []
    for (const { resource, targets } of resources.values()) {
      signal?.throwIfAborted()
      try {
        const fact = await this.read(context, resource, signal)
        for (const target of targets) this.publish(context, target, resource.kind === 'issue' ? issueObserved.type : changeObserved.type, fact)
        if (resource.kind !== 'change') continue
        const started = new Date().toISOString()
        const bindings = targets.map(target => ({ target, cursor: cursors(key(this.kind, target.projectId, target.taskId, String(target.deliveryVersion), resource.url)),
          initial: target.since ?? started }))
        const since = bindings.map(binding => context.state.get(binding.cursor)?.at ?? binding.initial).sort((a,b) => Date.parse(a)-Date.parse(b))[0]!
        const feedback = await this.feedback(context, resource, since, signal)
        context.atomic(() => {
          for (const { target, cursor, initial } of bindings) {
            const after = context.state.get(cursor)?.at ?? initial
            for (const item of feedback) if (Date.parse(item.updatedAt) >= Date.parse(after))
              this.publish(context, target, feedbackReceived.type, item)
            // Overlap is deliberate; event identity includes remote ID and edit timestamp, not the polling clock.
            context.state.set(cursor, { at: new Date(Date.parse(started) - 5000).toISOString() })
          }
        })
      } catch (error) { signal?.throwIfAborted(); failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Some linked repository resources could not be verified')
  }

  protected publish(context: SourceContext, target: ProjectRepositoryTarget, type: string, data: object & { updatedAt: string }): void {
    const payload = { ...data, deliveryVersion: target.deliveryVersion, ...(target.ticketId ? { ticketId: target.ticketId } : {}) }
    context.projectEvents!.publish({ id: key(type, target.projectId, target.taskId, JSON.stringify(payload)), type,
      projectId: target.projectId, taskId: target.taskId, occurredAt: data.updatedAt, data: payload })
  }
}
