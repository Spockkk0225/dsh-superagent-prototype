/** Reads linked project resources using the configured GitHub account, producing normalized facts on the shared queue. */
import { z } from 'zod'
import { key } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import { changeObserved, issueObserved, type ProjectRepositoryTarget } from './repository-events.ts'

const Resource = z.looseObject({ state: z.enum(['open', 'closed']), html_url: z.url(), updated_at: z.iso.datetime(),
  pull_request: z.unknown().optional(), merged: z.boolean().optional(), merge_commit_sha: z.string().nullish(),
  head: z.looseObject({ sha: z.string() }).optional(), base: z.looseObject({ ref: z.string() }).optional() })

/** Poll exact linked objects rather than treating new-issue intake switches as project-delivery authorization. */
export async function pollProjectFacts(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  if (!ctx.projectEvents || !ctx.projectResources || !ctx.config('github')) return
  const reads = new Map<string, Promise<z.output<typeof Resource>>>()
  const failures: unknown[] = []
  for (const target of ctx.projectResources()) {
    for (const [kind, urls] of [['issues', target.issueUrl ? [target.issueUrl] : []], ['pulls', target.pullUrls]] as const) {
      for (const url of urls) {
        const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/([1-9]\d*)$/.exec(url)
        if (!match || match[1]!.toLowerCase() !== target.repository.toLowerCase()) continue
        signal?.throwIfAborted()
        const path = `${kind}/${match[3]}`
        try {
          const resourceKey = `${target.repository.toLowerCase()}/${path}`
          let reading = reads.get(resourceKey)
          if (!reading) { reading = ctx.commands.forRepository(target.repository).withSignal(signal).api(Resource, path); reads.set(resourceKey, reading) }
          const remote = await reading
          if (kind === 'issues' && remote.pull_request) continue
          publishProjectFact(ctx, target, kind, remote)
        } catch (error) { signal?.throwIfAborted(); failures.push(error) }
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Some linked repository resources could not be verified')
}

/** Shared normalization entry for authoritative reads; callers must verify webhook authenticity before requesting a read. */
export function publishProjectFact(ctx: SourceContext, target: ProjectRepositoryTarget, kind: 'issues' | 'pulls', raw: unknown): void {
  const remote = Resource.parse(raw)
  const type = kind === 'issues' ? issueObserved.type : changeObserved.type
  const data = { repository: target.repository, url: remote.html_url, state: remote.merged ? 'merged' as const : remote.state,
    updatedAt: remote.updated_at, deliveryVersion: target.deliveryVersion,
    ...(kind === 'pulls' ? { ticketId: target.ticketId, head: remote.head?.sha, base: remote.base?.ref,
      ...(remote.merge_commit_sha ? { mergeCommit: remote.merge_commit_sha } : {}) } : {}) }
  ctx.projectEvents?.publish({ id: key(type, target.projectId, target.taskId, JSON.stringify(data)), type,
    projectId: target.projectId, taskId: target.taskId, occurredAt: remote.updated_at, data })
}
