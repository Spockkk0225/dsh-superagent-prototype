/** App-scoped directed requests from timeline events; callers advance cursors only after intake succeeds. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { githubChannel, githubPage, isHumanLogin, UserSchema } from './github-trigger.ts'

/** Source labels accompany existing acknowledgement and result replies in the configured group. */
export function githubEventLabel(trigger: Trigger): string {
  if (trigger.meta.ci) return trigger.meta.branch === 'main' ? 'GitHub Main CI' : 'GitHub PR CI'
  if (trigger.meta.kind === 'assignment') return 'GitHub Issue Assign'
  if (trigger.meta.kind === 'review_request') return 'GitHub PR Review Request'
  if (trigger.meta.kind === 'review') return 'GitHub PR Review'
  return trigger.addressed ? 'GitHub Comment Mention' : 'GitHub PR Comment'
}

/** A deployment-authored group request. Keep the GitHub actor and payload for audit and never attribute it to a group member. */
export function githubEventTask(event: Trigger, conversationId: string): Trigger {
  const ci = event.meta.ci === true
  const failed = Number(event.meta.failed) > 0
  const title = ci ? failed ? 'Investigate main CI failures' : 'Report main CI results' : 'Assess the GitHub event'
  const replyInstructions = [
    'Write the final DingTalk card in the language of the group. Open with what triggered CI.',
    'Inspect and report only the checks and statuses listed in the original event; do not include previously reported results from the same commit. Use the supplied check IDs to locate their workflow runs and logs.',
    'Verify the event field of each GitHub Actions run for this commit SHA. For a push to main, include the PR number if you confirm it was merged. Identify schedule runs as scheduled checks and name any other event type.',
    'If the commit has runs from multiple sources, group the workflows by source on the same card. Mark an unverified source as unknown. A workflow name such as nightly does not establish the trigger.',
    'Give the branch, short SHA, and check count by status. Name the main checks, including nightly if present, and their results. Explain known reasons for failures or skips and link to the checks.',
  ].join(' ')
  const task = ci ? failed ? 'Inspect the failed checks and logs for this commit and explain the cause with evidence on the original card.'
    : 'Report the CI results for this commit on the original card.'
    : 'Assess this GitHub event within the scope of the existing ticket and reply with the outcome in the language of the DingTalk group. If there is no related ticket, verify and report what happened.'
  const instruction = ci ? `${task} ${replyInstructions}` : task
  return {
    id: event.id, source: 'dingtalk', human: true, addressed: 'mention', actor: { source: 'dingtalk', id: 'github-event-adapter' },
    // Each CI execution is independent. A pull event uses the original thread so its existing worker receives the request.
    threads: ci ? [{ source: 'dingtalk', id: event.id }] : event.threads,
    at: event.at, url: event.url, text: `${instruction}\n\nOriginal GitHub event:\n${event.text}`,
    channel: { source: 'dingtalk', thread: `dingtalk:${conversationId}`,
      address: { conversationId, triggerId: event.id, eventLabel: githubEventLabel(event) } },
    meta: { conversationType: '2', conversationId, githubEvent: event },
    taskRequest: { title, scope: instruction, name: ci ? 'main-ci' : 'github-event',
      ...(ci ? { replyInstructions } : {}),
      acknowledgement: ci ? failed ? '收到，正在排查本次 main CI 的失败原因。' : '收到，正在核对本次 main CI 结果。' : '收到，正在核对这条 GitHub 事件。' },
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
