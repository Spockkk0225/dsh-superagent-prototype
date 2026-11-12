/** App-scoped directed requests from timeline events; callers advance cursors only after intake succeeds. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import type { SourceContext } from './host.ts'
import { githubChannel, githubPage, isHumanLogin, UserSchema } from './github-trigger.ts'
import { POLL_HORIZON_MS } from './poll.ts'

/** Source labels accompany existing acknowledgement and result replies in the configured group. */
export function githubEventLabel(trigger: Trigger): string {
  if (trigger.meta.ci) return trigger.meta.branch === 'main' ? 'GitHub Main CI' : 'GitHub PR CI'
  if (trigger.meta.kind === 'assignment') return 'GitHub Issue Assign'
  if (trigger.meta.kind === 'review_request') return 'GitHub PR Review Request'
  if (trigger.meta.kind === 'review') return 'GitHub PR Review'
  return trigger.addressed ? 'GitHub Comment Mention' : 'GitHub PR Comment'
}

const ScheduledRun = z.looseObject({ id: z.number(), run_attempt: z.number().default(1), name: z.string().nullish(),
  event: z.string(), status: z.string(), conclusion: z.string().nullable(), head_branch: z.string().nullable(),
  head_sha: z.string(), html_url: z.string().url(), updated_at: z.string() })

/** Scheduled runs report every completion, including success and reruns of the same commit. */
export async function pollScheduledCi(ctx: SourceContext, branch: string, started: string, signal?: AbortSignal): Promise<void> {
  const name = KV.github.scheduledSince(branch)
  const since = ctx.state.get(name) ?? started
  ctx.state.set(name, since)
  const created = new Date(Date.parse(started) - POLL_HORIZON_MS).toISOString()
  const pages = await ctx.commands.withSignal(signal).api(z.array(z.looseObject({ workflow_runs: z.array(ScheduledRun) })),
    `actions/runs?branch=${encodeURIComponent(branch)}&event=schedule&status=completed&per_page=100&created=${encodeURIComponent(`>=${created}`)}`,
    '--paginate', '--slurp')
  for (const run of pages.flatMap(page => page.workflow_runs).sort((a, b) => a.updated_at.localeCompare(b.updated_at))) {
    if (run.event !== 'schedule' || run.status !== 'completed' || run.head_branch !== branch || !run.conclusion
      || Date.parse(run.updated_at) < Date.parse(since)) continue
    await ctx.receive({ id: key('github-scheduled-ci', String(run.id), String(run.run_attempt)), source: 'github',
      threads: [{ source: 'github', id: `ci:${branch}` }], actor: { source: 'github', id: '' }, human: false,
      at: run.updated_at, url: run.html_url,
      text: `Scheduled CI completed: ${run.name ?? run.id}\nBranch: ${branch}\nCommit: ${run.head_sha}\nConclusion: ${run.conclusion}\n${run.html_url}`,
      meta: { ci: true, branch, sha: run.head_sha, event: 'schedule', runId: run.id, runAttempt: run.run_attempt,
        workflow: run.name, conclusion: run.conclusion } })
  }
}

const Event = z.looseObject({ event: z.string(), id: z.number().optional(), created_at: z.string().optional(),
  actor: UserSchema.optional(), assigner: UserSchema.optional(), review_requester: UserSchema.optional(),
  assignee: UserSchema.optional(), requested_reviewer: UserSchema.optional() })

/** Directed requests enter as new source events for the main agent to route. */
export async function pollRequests(ctx: SourceContext, number: number, isPr: boolean, since: string,
  title: string, body: string | null | undefined, signal?: AbortSignal): Promise<void> {
  const tally = { skipped: 0 }
  const events = await ctx.commands.withSignal(signal).pages(Event, `issues/${number}/timeline?per_page=100`, tally)
  if (tally.skipped) throw new Error('GitHub returned unreadable timeline events')
  const login = ctx.deployment.github.login
  for (const kinds of [['assigned', 'unassigned'], ['review_requested', 'review_request_removed']]) {
    const relevant = events.filter(event => kinds.includes(event.event) && sameName(
      (event.event.startsWith('review_') ? event.requested_reviewer : event.assignee)?.login ?? '', login))
      .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || (a.id ?? 0) - (b.id ?? 0))
    const event = relevant.at(-1)
    if (!event || event.event !== kinds[0] || !event.id || !event.created_at || Date.parse(event.created_at) < Date.parse(since)) continue
    if (event.event === 'review_requested' && !isPr) continue
    const actor = (event.event === 'assigned' ? event.assigner : event.review_requester) ?? event.actor
    if (!actor || sameName(actor.login, login)) continue
    const review = event.event === 'review_requested'
    const url = githubPage(ctx.deployment.repository, number, isPr)
    await ctx.receive({ id: key('github-request', String(event.id)), source: 'github',
      threads: [{ source: 'github', id: `request:${event.id}` }],
      actor: { source: 'github', id: actor.login }, human: isHumanLogin(actor), addressed: 'mention', at: event.created_at,
      text: `${review ? 'Review requested' : 'Issue assigned'} by @${actor.login} to @${login}: ${title}\n\n${body ?? ''}`,
      url, channel: githubChannel(number, url), meta: { number, isPr, kind: review ? 'review_request' : 'assignment',
        eventId: event.id, eventLabel: review ? 'GitHub PR Review Request' : 'GitHub Issue Assign' } })
  }
}
