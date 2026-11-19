/** GitHub data source: payloads, reads, polling, project facts, thread binding and idempotent replies. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger, type ThreadFact, type OutboundMessage, liveTicket, type Follow, type Ticket, type Thread } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'
import { validItems, type Commands, type Tally, CliError } from '../infra/commands.ts'
import { type ContextMessage, type ThreadContext, type ChannelLink, type ChannelLinks, type Localized, type SourceKind } from './kind.ts'
import { type SourceContext, health, sourceContext, type Health } from './host.ts'
import { type Deployment, GithubAccountsSchema } from '../deployment.ts'
import { changeObserved, issueObserved, feedbackReceived, type RepositoryFeedback, type ProjectRepositoryTarget } from './repository-events.ts'
import { type Context } from '@deepseek-ai/cordis'
import { KV } from '../kv.ts'
import { RepositorySource, type RepositoryResource } from './repository-source.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'

// trigger: provider implementation
export const SOURCE = 'github'
export const repositoryThreadId = (repository: string, number: number, pr: boolean): string =>
  `${repository.toLowerCase()}/${pr ? 'pull' : 'issues'}/${number}`
/** Project repository observations retain their own identity and cannot be mistaken for a deployment-wide request. */
export function repositoryEvent(trigger: Trigger, repository: string): Trigger {
  const number = trigger.meta.number
  const id = typeof number === 'number' ? repositoryThreadId(repository, number, trigger.meta.isPr === true)
    : `${repository}/${trigger.threads[0]!.id}`
  return { ...trigger, id: key('github-repository', repository, trigger.id), threads: [{ source: SOURCE, id }],
    ...(trigger.channel && { channel: { ...trigger.channel, thread: `${SOURCE}:${id}`, address: { ...trigger.channel.address, repository } } }),
    meta: { ...trigger.meta, repository, repositoryObservation: true } }
}
/** GitHub reply address: issue/PR conversation, or a review thread when `url` points at a discussion comment. */
export const githubChannel = (number: number, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: `github:${number}`, address: { number: String(number), ...(url ? { url } : {}) } })
export const githubPage = (repository: string, number: number, pr = false): string =>
  `https://github.com/${repository}/${pr ? 'pull' : 'issues'}/${number}`
/** Parses a web or API URL for an Issue, PR, or review comment in `repository`; returns undefined for other URLs or repositories. */
export function githubAddress(url: string, repository: string): { number: number; pr: boolean; discussion?: number } | undefined {
  const address = /^https:\/\/(?:api\.github\.com\/repos|github\.com)\/([^/]+\/[^/]+)\/(issues|pulls?)\/(\d+)\/?(?:#discussion_r(\d+)|#[\w-]*)?$/i
  const match = address.exec(url)
  if (!match || !sameName(match[1]!, repository)) return undefined
  return { number: Number(match[3]), pr: match[2]!.toLowerCase() !== 'issues', ...match[4] ? { discussion: Number(match[4]) } : {} }
}
/** GitHub returns a deleted account as `null` and displays it as `ghost`. */
export const UserSchema = z.looseObject({ login: z.string(), type: z.string().optional() }).nullable()
  .transform(user => user ?? { login: 'ghost', type: 'User' })
/**
 * A GitHub comment or review; a review carries `state` and `commit_id`, and an inline review comment carries its file,
 * line, diff hunk, and `in_reply_to_id` (the root comment ID of its review thread).
 */
export const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), user: UserSchema, html_url: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), submitted_at: z.string().nullish(),
  state: z.string().nullish(), commit_id: z.string().nullish(),
  path: z.string().nullish(), line: z.number().nullish(), original_line: z.number().nullish(), diff_hunk: z.string().nullish(),
  in_reply_to_id: z.number().nullish(),
})
export type GithubComment = z.infer<typeof CommentSchema>
/** An Issue as `issues/<number>` returns it; GitHub sets `pull_request` when the number is a pull request. */
export const IssueSchema = CommentSchema.extend({
  number: z.number(), title: z.string(), state: z.string(), created_at: z.string(), html_url: z.string(),
  pull_request: z.looseObject({ url: z.string() }).nullish(),
})
export type GithubIssue = z.infer<typeof IssueSchema>
type Opened = Pick<GithubIssue, 'number' | 'title' | 'body' | 'user' | 'created_at' | 'html_url'>
export interface PullRef { number: number; isPr: boolean; url?: string; prAuthor?: string }
/**
 * True when GitHub reports the account as a regular user rather than a bot or GitHub App.
 * Review bots running under ordinary user accounts count as human here; the prompts identify which accounts are automated.
 */
export const isHumanLogin = (user: { login: string; type?: string }): boolean =>
  !/\[bot\]$/.test(user.login) && (!user.type || user.type === 'User')
/** Formats an inline review comment's file:line and the trailing lines of its diff hunk, which GitHub ends at the commented line. */
export function reviewPlace(comment: GithubComment): string {
  const line = comment.line ?? comment.original_line
  const hunk = (comment.diff_hunk ?? '').split('\n').slice(-3).join('\n')
  return [`${comment.path}${line != null ? `:${line}` : ''}`, hunk].filter(Boolean).join('\n')
}
function commentText(comment: GithubComment, kind: 'conversation' | 'inline' | 'review'): string {
  const decided = kind === 'review' && comment.state && comment.state !== 'COMMENTED'
  const decision = decided ? `${comment.state} review of commit ${comment.commit_id ?? 'unknown'}` : ''
  const place = kind === 'inline' && comment.path ? reviewPlace(comment) : ''
  return [decision, place, comment.body ?? ''].filter(Boolean).join('\n\n')
}
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)
const author = (user: { login: string; type?: string }, agent: string) =>
  ({ actor: { source: SOURCE, id: user.login }, human: isHumanLogin(user) && !sameName(user.login, agent) })
/** Builds a trigger for a comment or review; text is empty for a bodyless comment or a `COMMENTED` review without a body. */
export function commentTrigger(comment: GithubComment, ref: PullRef, kind: 'conversation' | 'inline' | 'review', agent: string): Trigger {
  const at = comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? new Date().toISOString()
  const version = comment.updated_at ?? comment.submitted_at ?? ''
  const id = key('github-comment', comment.html_url ?? `github:${ref.number}`, String(comment.id), version)
  return { id, source: SOURCE, threads: [{ source: SOURCE, id: String(ref.number) }], ...author(comment.user, agent), at,
    text: commentText(comment, kind),
    ...(mentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(ref.number, comment.html_url ?? undefined),
    ...(comment.html_url ?? ref.url ? { url: comment.html_url ?? ref.url } : {}),
    meta: { number: ref.number, isPr: ref.isPr, ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}), commentId: comment.id, kind,
      ...comment.path ? { path: comment.path, line: comment.line ?? comment.original_line ?? null } : {},
      ...comment.in_reply_to_id ? { inReplyTo: comment.in_reply_to_id } : {} } }
}
/**
 * Builds the trigger for a newly opened Issue's title and body.
 * The ID is the same as when Issue bodies were stored previously, so already-stored bodies are not ingested again.
 */
export function issueTrigger(issue: Opened, agent: string): Trigger {
  const body = issue.body ?? ''
  return { id: key('github-issue', String(issue.number)), source: SOURCE,
    threads: [{ source: SOURCE, id: String(issue.number) }], ...author(issue.user, agent), at: issue.created_at,
    text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(issue.number, issue.html_url), url: issue.html_url, meta: { number: issue.number, isPr: false, kind: 'issue' } }
}
/**
 * Builds the trigger for a newly opened PR's title and description.
 * PR and Issue numbers share one sequence in GitHub and never collide, so this reuses `issueTrigger`'s `github-issue` ID format.
 */
export function pullTrigger(pull: Opened, agent: string): Trigger {
  return { ...issueTrigger(pull, agent), meta: { number: pull.number, isPr: true, prAuthor: pull.user.login, kind: 'pull' } }
}
/** Builds a trigger for a default-branch CI transition; default-branch CI has no person to reply to, so it has no `channel`. */
export function branchCiTrigger(branch: string, sha: string, revision: number, summary: string, url: string, failed: number): Trigger {
  return { id: key('github-ci', `branch:${branch}`, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: `ci:${branch}` }], actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, url, meta: { ci: true, branch, sha, revision, failed } }
}
export function ciTrigger(pr: { number: number; html_url: string; user: { login: string } }, revision: number, summary: string): Trigger {
  return { id: key('github-ci', String(pr.number), String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: String(pr.number) }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, channel: githubChannel(pr.number), url: pr.html_url,
    meta: { number: pr.number, isPr: true, prAuthor: pr.user.login, ci: true, revision } }
}

// read: provider implementation
const CheckSchema = z.looseObject({ name: z.string(), status: z.string(), conclusion: z.string().nullable(),
  id: z.number().optional(), started_at: z.string().nullish(), completed_at: z.string().nullish() })
const StatusSchema = z.looseObject({ context: z.string(), state: z.string() })
type Check = Pick<z.infer<typeof CheckSchema>, 'name' | 'status' | 'conclusion' | 'id' | 'started_at' | 'completed_at'>
type Status = Pick<z.infer<typeof StatusSchema>, 'context' | 'state'>
export interface CiSnapshot { head: string; checks: Check[]; statuses: Status[] }
/** Check conclusions and status states that count as failures; `success`, `neutral`, `skipped`, and `stale` do not. */
const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error'])
export function ciCounts(snapshot: CiSnapshot): { failed: number; running: number } {
  const statuses = snapshot.statuses ?? []
  return {
    failed: snapshot.checks.filter(check => FAILING.has(check.conclusion ?? '')).length + statuses.filter(status => FAILING.has(status.state)).length,
    running: snapshot.checks.filter(check => check.status !== 'completed').length + statuses.filter(status => status.state === 'pending').length,
  }
}
export function ciSummary(snapshot: CiSnapshot, where: string, read: string): string {
  const checks = snapshot.checks.map(check => ({ name: check.name, failed: FAILING.has(check.conclusion ?? ''), running: check.status !== 'completed' }))
  const statuses = (snapshot.statuses ?? []).map(status => ({ name: status.context, failed: FAILING.has(status.state), running: status.state === 'pending' }))
  const results = [...checks, ...statuses]
  const failed = results.filter(result => result.failed).map(result => result.name)
  const running = results.filter(result => result.running).map(result => result.name)
  const names = (list: string[]) => list.slice(0, 5).join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '')
  const at = `on ${where} at ${snapshot.head.slice(0, 7)}`
  const still = running.length ? `; ${running.length} still running` : ''
  const line = failed.length ? `CI failed ${failed.length}/${results.length} ${at}: ${names(failed)}${still}`
    : running.length ? `CI running ${running.length}/${results.length} ${at}: ${names(running)}`
      : `CI passed ${results.length}/${results.length} ${at}`
  return `${line}\nRead ${read} for every check.`
}
export function ciFailures(snapshot: CiSnapshot): string[] {
  return [...snapshot.checks.filter(check => FAILING.has(check.conclusion ?? '')).map(check => check.name),
    ...(snapshot.statuses ?? []).filter(status => FAILING.has(status.state)).map(status => status.context)].sort()
}
export function ciFact(counts: { failed: number; running: number }): ThreadFact {
  if (counts.failed) return { label: { zh: 'CI 失败', en: 'CI failed' }, value: String(counts.failed), problem: true }
  if (counts.running) return { label: { zh: 'CI 进行中', en: 'CI running' }, value: String(counts.running) }
  return { label: 'CI', value: { zh: '通过', en: 'passed' } }
}
/** Reads a non-hidden file or directory listing from the repository's default branch via the GitHub API; hidden entries and `node_modules` are rejected. */
export async function readRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  const resource = `contents/${parts.map(encodeURIComponent).join('/')}`
  if (kind === 'file') return commands.api(resource, '-H', 'Accept: application/vnd.github.raw')
  // GitHub returns an entry array for a directory and a single object for a file.
  const entries = await commands.api(z.union([z.array(z.looseObject({ name: z.string() })), z.looseObject({})]), resource)
  if (!Array.isArray(entries)) throw new Error(`${path} is not a directory`)
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}
/** Reads check runs and commit statuses for a commit without emitting a trigger. */
export async function pullChecks(commands: Commands, head: string, tally?: Tally): Promise<CiSnapshot> {
  const page = z.looseObject({ check_runs: z.array(z.unknown()) })
  const pages = await commands.api(z.array(page), `commits/${head}/check-runs?per_page=100`, '--paginate', '--slurp')
  const runs = validItems(CheckSchema, pages.flatMap(page => page.check_runs), tally)
  const statuses = await commands.pages(StatusSchema, `commits/${head}/statuses?per_page=100`, tally)
  const latest = new Map<string, string>()
  for (const status of statuses) if (!latest.has(status.context)) latest.set(status.context, status.state)
  const checks = runs.map(({ name, status, conclusion, id, started_at, completed_at }) => ({ name, status, conclusion,
    ...id !== undefined ? { id } : {}, ...started_at !== undefined ? { started_at } : {},
    ...completed_at !== undefined ? { completed_at } : {} }))
  return { head, checks: checks.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    statuses: [...latest].map(([context, state]) => ({ context, state })).sort((a, b) => a.context.localeCompare(b.context)) }
}
/** Formats a GitHub comment, review, or issue as a model-facing ContextMessage, marking bots and GitHub Apps because bot messages never authorize work. */
function githubMessage(item: GithubComment, text: string, id: string): ContextMessage {
  const line = item.line ?? item.original_line
  return { id, from: item.user.login, at: item.created_at ?? item.submitted_at ?? '', text,
    ...!isHumanLogin(item.user) ? { bot: true } : {}, ...item.html_url ? { url: item.html_url } : {},
    ...item.path ? { path: item.path, ...line != null ? { line } : {} } : {} }
}
const reviewText = (review: GithubComment): string =>
  [review.state && review.state !== 'COMMENTED' ? review.state : '', review.body ?? ''].filter(Boolean).join('\n\n')
const DescriptionSchema = IssueSchema.extend({
  labels: z.array(z.looseObject({ name: z.string() })).nullish(), draft: z.boolean().nullish(), merged: z.boolean().nullish(),
  head: z.looseObject({ ref: z.string() }).nullish(), base: z.looseObject({ ref: z.string() }).nullish(),
})
async function reviewThread(commands: Commands, number: number, comment: number, tally?: Tally): Promise<GithubComment[]> {
  const comments = await commands.pages(CommentSchema, `pulls/${number}/comments?per_page=100`, tally)
  const root = comments.find(item => item.id === comment)?.in_reply_to_id ?? comment
  return comments.filter(item => item.id === root || item.in_reply_to_id === root)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
}
function threadMessages(thread: GithubComment[], id: (comment: GithubComment) => string): ContextMessage[] {
  const [first] = thread
  return thread.map(item => item === first
    ? githubMessage(item, [reviewPlace(item), item.body ?? ''].filter(Boolean).join('\n\n'), id(item))
    : { ...githubMessage(item, item.body ?? '', id(item)), ...first ? { reply_to: id(first) } : {} })
}
/**
 * Reads an Issue or PR, a page of its comments or reviews, a review thread, or a CI snapshot as model-facing
 * `{ id, from, at, text, reply_to?, path?, line?, url }` messages rather than raw GitHub API records.
 */
export async function readGithub(commands: Commands, resource: string): Promise<unknown> {
  // A commit's CI, such as the default branch's, which no PR names.
  const commit = /^github\/commits\/([0-9a-f]{7,40})\/checks$/.exec(resource)
  if (commit) return pullChecks(commands, commit[1]!)
  const match = /^github\/(issues|pulls)\/([1-9]\d*)(?:\/(comments|reviews|checks|thread)(?:\/([1-9]\d*))?)?$/.exec(resource)
  if (!match) {
    throw new Error('Use github/issues/<number>, github/pulls/<number>, or append /comments/<page>, /reviews/<page>, /thread/<comment-id> or /checks; or github/commits/<sha>/checks')
  }
  const [, kind, number, section, page = '1'] = match
  if (kind === 'issues' && (section === 'reviews' || section === 'checks' || section === 'thread')) {
    throw new Error('Reviews, review threads and checks require a pull request')
  }
  const path = `${kind}/${number}`
  if (section === 'checks') {
    if (match[4]) throw new Error('Checks do not take a page number')
    const pr = await commands.api(z.looseObject({ head: z.looseObject({ sha: z.string() }) }), path)
    return pullChecks(commands, pr.head.sha)
  }
  if (section === 'thread') {
    if (!match[4]) throw new Error('Name the review thread by one of its comments: github/pulls/<number>/thread/<comment-id>')
    const thread = await reviewThread(commands, Number(number), Number(match[4]))
    if (!thread.length) throw new Error('No review comment of this PR has that id')
    return { messages: threadMessages(thread, item => String(item.id)) }
  }
  if (!section) {
    const item = await commands.api(DescriptionSchema, path)
    const branches = item.head && item.base ? { head: item.head.ref, base: item.base.ref } : {}
    const labels = item.labels?.length ? { labels: item.labels.map(label => label.name) } : {}
    return { number: item.number, title: item.title, state: item.state, ...item.merged ? { merged: true } : {},
      ...item.draft ? { draft: true } : {}, ...branches, ...labels, ...githubMessage(item, item.body ?? '', String(item.number)) }
  }
  const listed = await commands.api(z.array(z.unknown()), `${path}/${section}?per_page=20&page=${page}`)
  const tally = { skipped: 0 }
  const items = validItems(CommentSchema, listed, tally)
  const messages = items.map(item => section === 'reviews'
    ? githubMessage({ ...item, created_at: item.submitted_at ?? item.created_at }, reviewText(item), String(item.id))
    : { ...githubMessage(item, item.body ?? '', String(item.id)), ...item.in_reply_to_id ? { reply_to: String(item.in_reply_to_id) } : {} })
  return { messages, ...tally.skipped ? { skipped: tally.skipped } : {},
    ...listed.length === 20 ? { next_resource: `github/${kind}/${number}/${section}/${Number(page) + 1}` } : {} }
}
/** Reads one page of an Issue or PR conversation (with the Issue/PR description first on page 1), using comment URLs as message IDs. */
async function conversationPage(commands: Commands, number: number, page: number) {
  const messages: ContextMessage[] = []
  if (page === 1) {
    const issue = await commands.api(IssueSchema, `issues/${number}`)
    messages.push(githubMessage(issue, `${issue.title}\n\n${issue.body ?? ''}`, issue.html_url))
  }
  const listed = await commands.api(z.array(z.unknown()), `issues/${number}/comments?per_page=100&page=${page}`)
  const tally = { skipped: 0 }
  const comments = validItems(CommentSchema, listed, tally)
  messages.push(...comments.map(comment => githubMessage(comment, comment.body ?? '', comment.html_url ?? String(comment.id))))
  return { messages, next_resource: listed.length === 100 ? String(page + 1) : null, ...tally.skipped ? { skipped: tally.skipped } : {} }
}
/**
 * Context reader for a GitHub Trigger: reads the review thread for an inline review comment (whose first comment is its
 * root and parent), or the Issue/PR conversation by page otherwise (whose first page is its root and parent).
 */
export const githubThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? '',
  read: async (commands, trigger, part, cursor) => {
    // The default branch's CI has no conversation; its Trigger is its context.
    if (typeof trigger.meta.branch === 'string') {
      const message = { id: trigger.url ?? trigger.id, from: 'CI', at: trigger.at, text: trigger.text, bot: true as const }
      return { messages: [message], body: { status: 'branch_ci', messages: [message] }, status: 'branch_ci' }
    }
    if (trigger.meta.repositoryObservation === true && typeof trigger.meta.repository === 'string')
      commands = commands.forRepository(trigger.meta.repository)
    const number = Number(trigger.meta.number)
    if (trigger.meta.kind === 'inline' && typeof trigger.meta.commentId === 'number') {
      const thread = await reviewThread(commands, number, trigger.meta.commentId)
      const messages = threadMessages(thread, item => item.html_url ?? String(item.id))
      const read = part === 'thread' ? messages : messages.slice(0, 1)
      return { messages: read, body: { status: 'review_thread', messages: read }, status: 'review_thread' }
    }
    const body = await conversationPage(commands, number, Number(cursor ?? '1'))
    return { messages: body.messages, next: body.next_resource ?? undefined, body }
  },
}

// channel: provider implementation
const SentCommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), in_reply_to_id: z.number().nullish(), user: z.looseObject({ login: z.string() }).nullish(),
})
/** True when an issue is permanently deleted (410) or locked (403); 404 is retried because it can indicate temporary permission loss on a private repo. */
const gone = (error: unknown): boolean => error instanceof CliError
  && (error.code === 410 || (error.code === 403 && /locked/i.test(error.message)))
const missing = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)
/** Create/update one comment per mirrored card/round; markers make retries idempotent and prevent stale snapshots winning. */
export async function sendGithub(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const commands = message.channel.address.repository ? host.commands.forRepository(message.channel.address.repository) : host.commands
  const { repository, github } = commands.deployment
  const number = Number(message.channel.address.number)
  if (!number) throw new Error('Missing GitHub reply target')
  try {
    // Retained trigger URLs also route replies queued before thread-aware delivery.
    const address = githubAddress(message.channel.address.url ?? '', repository)
    let rootId: number | undefined
    if (address?.pr && address.discussion && address.number === number) {
      // Fall back to a top-level PR comment if the target inline review comment was deleted.
      const source = await commands.api(SentCommentSchema, `pulls/comments/${address.discussion}`)
        .catch((error: unknown) => { if (missing(error)) return undefined; throw error })
      rootId = source ? source.in_reply_to_id ?? source.id : undefined
    }
    const path = rootId === undefined ? `issues/${number}/comments` : `pulls/${number}/comments`
    const commentKey = message.channel.address.commentKey
    const revision = commentKey ? Number(message.channel.address.revision) : undefined
    if (commentKey && (!/^[a-f0-9]{32}$/.test(commentKey) || !Number.isSafeInteger(revision) || revision! < 1)) {
      throw new Error('Invalid GitHub card-comment revision')
    }
    const marker = commentKey ? `<!-- dsh-superagent-card:${commentKey} -->` : `<!-- dsh-superagent:${message.id} -->`
    const mine = (comment: z.infer<typeof SentCommentSchema>) => sameName(comment.user?.login ?? '', github.login)
      && (rootId === undefined || comment.in_reply_to_id === rootId) && (comment.body ?? '').includes(marker)
    const existing = (await commands.pages(SentCommentSchema, path)).find(mine)
    if (existing && !commentKey) return 'sent'
    const body = `${message.text}\n\n${marker}${commentKey ? `\n<!-- dsh-superagent-revision:${revision} -->` : ''}`
    if (existing) {
      const savedRevision = Number(/<!-- dsh-superagent-revision:(\d+) -->/.exec(existing.body ?? '')?.[1] ?? 0)
      // An earlier confirmation retry must never replace a result that was delivered ahead of it.
      if (savedRevision >= revision!) return 'sent'
      const edit = rootId === undefined ? `issues/comments/${existing.id}` : `pulls/comments/${existing.id}`
      await commands.api(z.unknown(), edit, '--method', 'PATCH', '-f', `body=${body}`)
      return 'sent'
    }
    const target = rootId === undefined ? path : `${path}/${rootId}/replies`
    await commands.api(z.unknown(), target, '--method', 'POST', '-f', `body=${body}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
export function githubLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const number = address.number ?? ''
  const repository = address.repository || links.repository
  const review = !!repository && !!githubAddress(address.url ?? '', repository)?.discussion
  return { url: address.url ?? (repository ? githubPage(repository, Number(number)) : ''),
    label: review ? { zh: `GitHub #${number} 的 review 讨论`, en: `Review discussion on GitHub #${number}` }
      : { zh: `GitHub #${number}`, en: `GitHub #${number}` } }
}

// pull: provider implementation
const PullSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), html_url: z.string(), user: UserSchema,
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), auto_merge: z.unknown().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
export type Pull = z.infer<typeof PullSchema> & { number: number }
export const readPull = async (ctx: SourceContext, number: number, signal?: AbortSignal): Promise<Pull> =>
  ({ ...await ctx.commands.withSignal(signal).api(PullSchema, `pulls/${number}`), number })
const pullNumber = (thread: string): number | undefined => /^github:[1-9]\d*$/.test(thread) ? Number(thread.slice(SOURCE.length + 1)) : undefined
export function projectPull(thread: string): { repository: string; number: number } | undefined {
  const match = /^github:([a-z0-9-]+\/[a-z0-9_.-]+)\/pull\/([1-9]\d*)$/i.exec(thread)
  return match ? { repository: match[1]!, number: Number(match[2]) } : undefined
}
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => pullNumber(item.thread) ?? [])
export const pullOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => pullsOf(ticket, true).at(-1) ?? pullsOf(ticket).at(-1)
/** True for the agent's PR from the watched repository or an explicitly authorized App fork. */
export const agentPull = (pr: { user: { login: string }; head?: { repo?: { full_name: string } | null } | null },
  deployment: Pick<Deployment, 'github' | 'repository'>): boolean =>
  sameName(pr.user.login, deployment.github.login)
  && [deployment.repository, ...(deployment.github.auth === 'app' ? deployment.github.repositories ?? [] : [])]
    .some(repository => sameName(pr.head?.repo?.full_name ?? '', repository))
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }
/**
 * Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or an agent-authored PR on the ticket's branch, enforcing that one PR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the PR is bound or when the PR is not open (which is not an error).
 */
export function claimPull(ctx: SourceContext, ticketId: string, pr: Pull): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.isPr === true && source.meta.number === pr.number
  const opened = agentPull(pr, ctx.deployment) && ticketBranch(ticket, pr.head.ref)
  if (!started && !opened) {
    const { login } = ctx.deployment.github
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const owner = ctx.tickets.open().find(item => pullsOf(item, true).includes(pr.number))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === `${SOURCE}:${pr.number}`)
  if (pr.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, pr, opened)
  return undefined
}
/** Claims a project PR in a repository-qualified thread so PR numbers can repeat across projects. */
export function claimProjectPull(ctx: SourceContext, ticket: Ticket, repository: string, pr: Pull): string | undefined {
  if (!agentPull(pr, { ...ctx.deployment, repository }) || !ticketBranch(ticket, pr.head.ref))
    return 'The pull request must belong to this ticket branch in its project repository.'
  if (pr.state !== 'open') return 'Report a project PR while it is still open.'
  const id = `${repository}/pull/${pr.number}`
  const thread = `${SOURCE}:${id}`
  if (ctx.tickets.open().some(item => item.id !== ticket.id && item.follows?.some(follow => follow.thread === thread && !follow.closed)))
    return 'PR already belongs to another active ticket'
  ctx.tickets.bindThread(ticket.id, { source: SOURCE, id }, true)
  ctx.threads.patch(thread, { number: pr.number, isPr: true, url: githubPage(repository, pr.number, true), prAuthor: pr.user.login })
  return undefined
}
/** Reconciles only PRs already reported by project Workers, independently of repository-wide intake. */
export async function pollProjectPulls(ctx: SourceContext, signal: AbortSignal): Promise<boolean> {
  const follows = new Set(ctx.tickets.open().flatMap(ticket => (ticket.follows ?? []).filter(follow => !follow.closed).map(follow => follow.thread)))
  let watched = false
  let failure: unknown
  for (const thread of follows) {
    const target = projectPull(thread)
    if (!target || signal.aborted) continue
    watched = true
    try {
      const repo = ctx.commands.forRepository(target.repository).withSignal(signal)
      const pr = await repo.api(PullSchema, `pulls/${target.number}`)
      if (pr.merged)
        ctx.tickets.threadClosed({ source: SOURCE, id: thread.slice(SOURCE.length + 1) }, 'merged',
          pr.merged_at ?? pr.closed_at ?? new Date().toISOString())
    } catch (error) { failure ??= error }
  }
  if (failure) throw failure
  return watched
}
/**
 * Reconciles a polled PR's open/merged/closed state and auto-merge fact with any bound or branch-matching ticket.
 * An open agent PR auto-binds to the single open ticket on its branch unless that ticket already follows another open PR
 * (which only the Executor's report changes).
 * @returns whether the PR has ended.
 */
export async function observePull(ctx: SourceContext, pr: Pull): Promise<boolean> {
  const ended = pr.state === 'closed' || !!pr.merged
  if (ended) closePull(ctx, pr)
  else {
    const candidates = agentPull(pr, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, pr.head.ref)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // A PR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === `${SOURCE}:${pr.number}` && item.closed)
    if (ticket && (reopened || pullsOf(ticket, true).every(number => number === pr.number))) claimPull(ctx, ticket.id, pr)
  }
  ctx.threads.describe(`github:${pr.number}`, { facts: { autoMerge: !ended && pr.auto_merge != null ? AUTO_MERGE_ON : null } })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, pr: Pull, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: String(pr.number) }, own)
    ctx.threads.patch(`github:${pr.number}`, { number: pr.number, isPr: true, url: pr.html_url, prAuthor: pr.user.login })
  })
}
/**
 * Reports a merged PR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the PR stays so a later human comment there resumes the ticket.
 */
function closePull(ctx: SourceContext, pr: Pull): void {
  if (!pr.merged) return
  if (!ctx.tickets.open().some(ticket => pullsOf(ticket, true).includes(pr.number))) return
  const at = pr.merged_at ?? pr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: String(pr.number) }, 'merged', at)
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its PR (selecting the last-closed PR it
 * opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
 * Han characters and no kana, otherwise English.
 */
export function pullEndNotices(ticket: Ticket, request: string, repository: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && (projectPull(item.thread) || pullNumber(item.thread) !== undefined))
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const target = projectPull(follow.thread)
  const number = target?.number ?? pullNumber(follow.thread)!
  const url = githubPage(target?.repository ?? repository, number, true)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[PR #${number}](${url}) 已合并。` : `[PR #${number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[PR #${number}](${url}) has merged.` : `[PR #${number}](${url}) was closed without merging.`
  // GitHub timelines and linked issues already show the merge or closure, so GitHub channels are skipped.
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('pr-terminal', target ? follow.thread : String(number), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}

// events: provider implementation
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
    at: event.at, url: event.url, originalChannel: event.originalChannel ?? event.channel, text: `${instruction}\n\nOriginal GitHub event:\n${event.text}`,
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

// repositories: provider implementation
export interface RepositoryBinding { repository: string; since: string }
export interface RepositoryWatch extends RepositoryBinding { configured: boolean; projects: number }
/** The configured legacy repository and live project bindings share a single entry per canonical repository. */
export function repositoryWatches(configured: string, bindings: readonly RepositoryBinding[]): RepositoryWatch[] {
  const watches = new Map<string, RepositoryWatch>()
  if (configured) watches.set(configured.toLowerCase(), { repository: configured.toLowerCase(), since: '', configured: true, projects: 0 })
  for (const binding of bindings) {
    const repository = binding.repository.toLowerCase()
    const existing = watches.get(repository)
    if (existing) {
      existing.projects++
      if (binding.since < existing.since) existing.since = binding.since
    } else watches.set(repository, { repository, since: binding.since, configured: false, projects: 1 })
  }
  return [...watches.values()].sort((a, b) => a.repository.localeCompare(b.repository))
}
export function hasRepositoryStreams(config?: Record<string, unknown>): boolean {
  return !!config && [config.observeIssues, config.observePulls, config.observeComments, config.observeCi].some(value => value === true)
}

// project-events: provider implementation
const Resource = z.looseObject({ state: z.enum(['open', 'closed']), html_url: z.url(), updated_at: z.iso.datetime(),
  pull_request: z.unknown().optional(), merged: z.boolean().optional(), merge_commit_sha: z.string().nullish(),
  head: z.looseObject({ sha: z.string() }).optional(), base: z.looseObject({ ref: z.string() }).optional() })
/** Poll exact linked objects rather than treating new-issue intake switches as project-delivery authorization. */
/** GitHub supplies API paths and payload conversion to the shared repository-source template. */
export class GithubSource extends RepositorySource {
  readonly kind = SOURCE
  protected accepts(resource: RepositoryResource): boolean {
    const address = githubAddress(resource.url, resource.repository)
    return !!address && address.pr === (resource.kind === 'change')
  }
  protected async read(context: SourceContext, resource: RepositoryResource, signal?: AbortSignal) {
    const number = this.number(resource)
    const remote = await context.commands.forRepository(resource.repository).withSignal(signal).api(Resource, `${resource.kind === 'issue' ? 'issues' : 'pulls'}/${number}`)
    if (remote.html_url.toLowerCase() !== resource.url.toLowerCase() || resource.kind === 'issue' && remote.pull_request)
      throw new Error('GitHub returned a different linked resource')
    return { repository: resource.repository, url: resource.url, state: remote.merged ? 'merged' as const : remote.state,
      updatedAt: remote.updated_at, ...(remote.head ? { head: remote.head.sha } : {}), ...(remote.base ? { base: remote.base.ref } : {}),
      ...(remote.merge_commit_sha ? { mergeCommit: remote.merge_commit_sha } : {}) }
  }
  protected async feedback(context: SourceContext, resource: RepositoryResource, since: string, signal?: AbortSignal): Promise<Omit<RepositoryFeedback, 'deliveryVersion' | 'ticketId'>[]> {
    const number = this.number(resource), commands = context.commands.forRepository(resource.repository).withSignal(signal)
    const output: Omit<RepositoryFeedback, 'deliveryVersion' | 'ticketId'>[] = []
    const tally = { skipped: 0 }
    const paths = [ ['comment', `issues/${number}/comments?per_page=100&since=${encodeURIComponent(since)}`],
      ['inline', `pulls/${number}/comments?per_page=100&since=${encodeURIComponent(since)}`], ['review', `pulls/${number}/reviews?per_page=100`] ] as const
    for (const [kind,path] of paths) for (const raw of await commands.pages(CommentSchema, path, tally)) {
      const item = CommentSchema.parse(raw)
      const at = item.updated_at ?? item.submitted_at ?? item.created_at
      if (!at || Date.parse(at) < Date.parse(since) || this.automationEcho(context, item)) continue
      if (!item.html_url || !item.html_url.startsWith(resource.url + '#')) throw new Error('GitHub feedback belongs to a different resource')
      const channel = { source: SOURCE, thread: `github:${repositoryThreadId(resource.repository, number, true)}`,
        address: { repository: resource.repository, number: String(number), url: item.html_url } }
      output.push({ id: String(item.id), kind, repository: resource.repository, resourceUrl: resource.url, url: item.html_url,
        body: item.body ?? '', actor: { id: item.user.login, human: isHumanLogin(item.user) }, updatedAt: at, channel,
        ...(item.commit_id ? { commit: item.commit_id } : {}), ...(item.path ? { path: item.path, line: item.line ?? item.original_line ?? null } : {}),
        ...(item.diff_hunk ? { diff: item.diff_hunk } : {}),
        ...(item.in_reply_to_id ? { threadId: String(item.in_reply_to_id) } : {}), ...(item.state ? { state: item.state } : {}) })
    }
    if (tally.skipped) throw new Error('GitHub returned unreadable feedback; its cursor was not advanced')
    return output.sort((a,b) => Date.parse(a.updatedAt)-Date.parse(b.updatedAt) || a.id.localeCompare(b.id))
  }
  private number(resource: RepositoryResource): number {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/([1-9]\d*)$/.exec(resource.url)
    if (!match || !sameName(match[1]!, resource.repository) || (match[2] === 'issues') !== (resource.kind === 'issue'))
      throw new Error('Linked resource does not belong to this GitHub repository')
    return Number(match[3])
  }
  private automationEcho(context: SourceContext, item: GithubComment): boolean {
    if (!sameName(item.user.login, context.deployment.github.login)) return false
    const standard = /\n\n<!-- dsh-superagent:([a-f0-9]{32}) -->$/.exec(item.body ?? '')
    const card = /\n\n<!-- dsh-superagent-card:([a-f0-9]{32}) -->\n<!-- dsh-superagent-revision:(\d+) -->$/.exec(item.body ?? '')
    const marker = standard ?? card
    const id = standard?.[1] ?? (card ? `${card[1]}:${card[2]}` : undefined)
    const message = id && context.outgoingMessage?.(id)
    return !!message && !!marker && message.source === SOURCE && item.body!.slice(0, marker.index) === message.text
  }
}
export async function pollProjectFacts(context: SourceContext, signal?: AbortSignal): Promise<void> { await new GithubSource().poll(context, signal) }

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

// github: provider implementation
/** A notification of the agent account; `subject.url` is the API address of its Issue or PR. */
const NotificationSchema = z.looseObject({
  repository: z.looseObject({ full_name: z.string() }), subject: z.looseObject({ url: z.string().nullish() }),
})
const GithubConfigSchema = GithubAccountsSchema.extend({ pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observePulls: z.boolean().default(false), observeComments: z.boolean().default(false),
  observeCi: z.boolean().default(false) }).strict()
export type GithubConfig = z.infer<typeof GithubConfigSchema>
const OBSERVED = { issues: 'observeIssues', pulls: 'observePulls', comments: 'observeComments', ci: 'observeCi' } as const
type Scope = keyof typeof OBSERVED
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.ci === true) return typeof meta.branch === 'string' ? 'ci' : undefined
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'pull') return 'pulls'
  return meta.kind === 'conversation' || meta.kind === 'inline' || meta.kind === 'review' ? 'comments' : undefined
}
export const githubKind: SourceKind<GithubConfig> = {
  kind: SOURCE,
  projectEvents: [changeObserved, issueObserved, feedbackReceived],
  discussion: (repository, url) => {
    const target = githubAddress(url, repository)
    return target?.pr ? { source: SOURCE, thread: `github:${repositoryThreadId(repository, target.number, true)}`,
      address: { repository, number: String(target.number), url } } : undefined
  },
  title: { zh: 'GitHub', en: 'GitHub' },
  description: { zh: '智能体的 GitHub 账号；接收仓库里发给它的通知、已订阅 Issue 与 PR 的讨论、CI 状态变化和 PR 合并关闭。', en: 'The agent\'s GitHub accounts; receives notifications to it in the repository, discussion on subscribed Issues and PRs, CI changes, and PR merge or close.' },
  schema: GithubConfigSchema,
  fields: [
    { key: 'commitEmail', type: 'text', label: { zh: '提交邮箱', en: 'Commit email' },
      hint: { zh: '可选；覆盖提交使用的 bot 邮箱，保存后重启生效。', en: 'Optional override for the bot commit email; restart to apply.' } },
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+', label: { zh: '默认仓库', en: 'Default repository' },
      hint: { zh: '写作 owner/name。此仓库接收账号通知。项目关联的仓库也会按下方选项监听事件。修改默认仓库会检查推送权限并重启服务。', en: 'Written owner/name. This repository receives account notifications. The options below also apply to linked project repositories. Changing the default checks push access and restarts the service.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitHub CLI', en: 'Agent GitHub CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 GH_CONFIG_DIR 登录智能体账号的 gh 包装脚本。智能体以它登录的账号行事，执行器以 gh 调用它。保存时检查它登录的账号能否推送到仓库，然后重启 dsh-superagent。', en: 'A command name or absolute path, usually a gh wrapper signed in to the agent account through GH_CONFIG_DIR. The agent acts as the account it is signed in to, and the Executor calls it as gh. Saving checks that this account can push to the repository, then restarts dsh-superagent.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' }, hint: { zh: 'GitHub 要求更长间隔时以 GitHub 为准。', en: 'A longer interval requested by GitHub wins.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' }, hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收仓库里的新 Issue', en: 'Receive new Issues in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observePulls', type: 'switch', label: { zh: '接收仓库里的新 PR', en: 'Receive new pull requests in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 PR 也会收到，由策略的接收表决定是否成为候选。', en: 'New pull requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收仓库里的评论', en: 'Receive comments in the repository' },
      hint: { zh: '打开后，Issue 和 PR 上没有 @ 智能体的评论和代码评论也会收到，由策略的接收表决定是否成为候选。', en: 'Comments and review comments on Issues and PRs that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeCi', type: 'switch', label: { zh: '接收默认分支的 CI', en: 'Receive the default branch\'s CI' },
      hint: { zh: '打开后，默认分支的 CI 失败和恢复会收到，由策略的接收表决定是否成为候选。', en: 'Failures of the default branch\'s CI, and its recovery, are received, and the Policy\'s admission table decides whether they become candidates.' } }],
  // What the Source observes across the repository it receives in full; elsewhere, only what addresses the agent.
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['github'],
  channel: { send: sendGithub, link: githubLink },
  threadContext: githubThreadContext,
  find: (query, config) => {
    const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(pull|issues)\/([1-9]\d*)(?:[/?#].*)?$/i.exec(query.trim())
    const number = url?.[3] ?? /^#?(\d+)$/.exec(query.trim())?.[1]
    const thread = url && config && !sameName(url[1]!, config.repository)
      ? repositoryThreadId(url[1]!, Number(number), url[2]!.toLowerCase() === 'pull') : number
    return { threads: thread ? [`${SOURCE}:${thread}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9-]+(\[bot\])?$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitHub 账号', en: 'GitHub accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的机器人账号（例如 dependabot[bot]）的评论在来源收到时成为推断的候选，交给评估：评论 @ 了智能体，或者打开了“接收仓库里的评论”。它们不能发起明确的请求，也不能停止工单；其他机器人的评论不接收。', en: 'A comment of a bot account on this list, such as dependabot[bot], becomes an inferred candidate for an assessment when the Source receives it: when it mentions the agent, or with Receive comments in the repository on. Such a comment never makes an explicit request or stops a ticket; other bots\' comments are not admitted.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9\\-]+(\\[bot\\])?' }] }],
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue or a comment.' },
    rows(stored) {
      const config = GithubConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('pulls', { zh: '新 PR', en: 'New pull requests' }),
        row('comments', { zh: '评论', en: 'Comments' }),
        // CI has no sender, so only the cell of a sender off the list who does not address the agent applies.
        { id: 'ci', label: { zh: '默认分支的 CI', en: 'Default branch CI' }, note: config.observeCi ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observeCi } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', description: { zh: '这个来源监听的仓库，owner/name。智能体在这里开的 PR，分支最后一段是 DSH_SUPERAGENT_NAME 时（例如 agent/$DSH_SUPERAGENT_NAME）会关联到工单', en: 'The repository this Source watches, as owner/name. A PR the agent opens here from a branch whose last path segment is DSH_SUPERAGENT_NAME (for example agent/$DSH_SUPERAGENT_NAME) binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_GITHUB_REPOSITORIES', description: { zh: '已授权仓库列表（逗号分隔）。App 模式按目标仓库切换身份令牌：代码推送到指定 fork，在监听的上游仓库评论和创建 PR；gh 使用显式 --repo，跨 fork 的 PR 使用 --head owner:branch。', en: 'Authorized repositories, comma-separated. In App mode credentials follow the target repository: push code to the intended fork, comment and create PRs on the watched upstream. Use explicit gh --repo and --head owner:branch for cross-fork PRs.' } },
      { key: 'DSH_SUPERAGENT_GITHUB_ACCOUNT', description: { zh: '智能体的 GitHub 账号；gh 以它登录，除自动合并外的 GitHub 操作都用 gh，不用其他账号或凭据', en: 'The agent\'s GitHub account. gh is signed in to it; use gh for every GitHub operation except auto-merge, and never another account or credential' } },
      { key: 'DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITHUB_NUMBER', description: { zh: '接下工单的 Issue 或 PR 编号；工单不是从 GitHub 来的时为空', en: 'Number of the Issue or PR that started the ticket; empty when the ticket did not start on GitHub' } },
      { key: 'DSH_SUPERAGENT_GITHUB_PR_HEAD', description: { zh: '接下工单的 PR 的 head 引用 refs/pull/<编号>/head；不是 PR 时为空', en: 'Head ref refs/pull/<number>/head of the PR that started the ticket; empty when it was not a PR' } },
    ],
    values: ({ deployment, trigger }) => {
      const number = trigger?.threads[0]?.source === SOURCE ? Number(trigger.meta.number) || 0 : 0
      return { DSH_SUPERAGENT_GITHUB_REPOSITORY: deployment.repository,
        DSH_SUPERAGENT_GITHUB_REPOSITORIES: (deployment.github.repositories ?? [deployment.repository]).join(','),
        DSH_SUPERAGENT_GITHUB_ACCOUNT: deployment.github.login, DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL: deployment.github.noreply, DSH_SUPERAGENT_GITHUB_NUMBER: number ? String(number) : '',
        DSH_SUPERAGENT_GITHUB_PR_HEAD: number && trigger?.meta.isPr === true ? `refs/pull/${number}/head` : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment ? {
    cli: { zh: `当前账号 @${deployment.github.login}`, en: `Current account @${deployment.github.login}` },
  } : {},
}
export const name = 'dsh-superagent-github'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(githubKind), 'github: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, githubKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watchGithub(source, controller.signal)
    return async () => { controller.abort(); await running }
  })
}
/** Runs the shared polling lifecycle for plugin and headless hosts; the caller aborts and awaits it before shutdown. */
export async function watchGithub(source: SourceContext, signal: AbortSignal): Promise<void> {
  try { await watch(source, signal) }
  catch (error) { if (!signal.aborted) source.report('github', { state: 'error', detail: String(error) }) }
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('github', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GithubConfig>(SOURCE)
    try {
      const [primary, project, repositories, facts] = await Promise.allSettled([
        config && ctx.deployment.repository ? pollConfiguredRepository(ctx, signal) : undefined,
        ctx.deployment.github.cli ? pollProjectPulls(ctx, signal) : false,
        pollProjectRepositories(ctx, signal),
        ctx.deployment.github.cli ? pollProjectFacts(ctx, signal) : undefined,
      ])
      if (primary.status === 'rejected') throw primary.reason
      if (project.status === 'rejected') throw project.reason
      if (repositories.status === 'rejected') throw repositories.reason
      if (facts.status === 'rejected') throw facts.reason
      if (primary.value !== undefined) interval = primary.value
      else if (repositories.value.length) {
        const ready = repositories.value.filter(item => item.state === 'ready').length
        ctx.report('github', { state: ready === repositories.value.length ? 'ready' : 'error',
          detail: `${ready} / ${repositories.value.length} project repositories polled` })
      }
      else if (project.value) ctx.report('github', { state: 'ready', detail: 'Tracking project pull requests' })
      else ctx.report('github', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('github', failed)
    }
    await pause(Math.max(interval, ctx.config<GithubConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
async function pollConfiguredRepository(ctx: SourceContext, signal: AbortSignal): Promise<number> {
  const status = KV.github.repositoryHealth(ctx.deployment.repository.toLowerCase())
  try {
    return await pollRound({ ...ctx, report: (name, value) => { ctx.state.set(status, value); ctx.report(name, value) } }, signal)
  } catch (error) {
    if (!signal.aborted) ctx.state.set(status, { state: 'error', detail: String(error), at: new Date().toISOString() })
    throw error
  }
}
interface Round {
  started: string; signal?: AbortSignal | undefined
  pulls: Map<number, Promise<Pull>>; read: Set<number>; failures: string[]; dropped: number[]; abandoned: number[]
  tally: Tally
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, pulls: new Map(), read: new Set(),
  failures: [], dropped: [], abandoned: [], tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
/** A shared round reads extra project repositories separately so a failure cannot overwrite their peers' health. */
export async function pollProjectRepositories(ctx: SourceContext, signal?: AbortSignal): Promise<Health[]> {
  if (!ctx.deployment.github.cli || !hasRepositoryStreams(ctx.config(SOURCE))) return []
  const targets = repositoryWatches(ctx.deployment.repository, ctx.projectRepositories?.() ?? []).filter(target => !target.configured)
  const results: Health[] = []
  for (let i = 0; i < targets.length && !signal?.aborted; i += 4) {
    results.push(...await Promise.all(targets.slice(i, i + 4).map(async target => {
      const round = newRound(signal)
      try { await pollRepository(ctx, round, target) }
      catch (error) { round.failures.push(String(error)) }
      const result: Health = round.failures.length ? { state: 'error', detail: round.failures[0]!, at: round.started }
        : { state: 'ready', detail: 'Repository event streams polled', at: round.started }
      if (!stopped(ctx, round)) ctx.state.set(KV.github.repositoryHealth(target.repository), result)
      return result
    })))
  }
  return results
}
export interface Retry { since: string; pr: boolean; failedAt?: string; attempts?: number }
const RETRY_WINDOW_MS = 24 * 3600_000
/** True when GitHub returns HTTP 410 (Gone); HTTP 404 is retried because it can indicate revoked access to a private repository. */
const deleted = (error: unknown): boolean => error instanceof CliError && error.code === 410
/** Records a failed read on the Thread and in the round; deleted (410) or abandoned (24h+) threads do not fail the round. */
function failed(ctx: SourceContext, round: Round, number: number, error: unknown, abandoned = false): void {
  if (deleted(error)) round.dropped.push(number)
  else if (abandoned) round.abandoned.push(number)
  else round.failures.push(`#${number}: ${String(error)}`)
  ctx.threads.patch(`github:${number}`, { pollError: String(error) })
}
function included(raw: string): { headers: string; body: string } {
  const split = raw.search(/\r?\n\r?\n/)
  if (split < 0) throw new Error('GitHub returned no HTTP headers')
  return { headers: raw.slice(0, split), body: raw.slice(split).trim() }
}
const ListedSchema = CommentSchema.extend({ issue_url: z.string().nullish(), pull_request_url: z.string().nullish() })
/** Repository-wide event streams; GitHub's `/issues` endpoint includes PRs, and `/issues/comments` covers issue and PR conversation comments (excluding inline review comments). */
const STREAMS = [
  { id: 'issues', observed: (config: GithubConfig) => config.observeIssues || config.observePulls, path: 'issues?state=all' },
  { id: 'comments', observed: (config: GithubConfig) => config.observeComments, path: 'issues/comments?' },
  { id: 'review-comments', observed: (config: GithubConfig) => config.observeComments, path: 'pulls/comments?' },
] as const
/** Polls repository-wide streams (new Issues/PRs, comments, default-branch CI); each stream reads from when it was switched on, resets when switched off, and fails independently. */
async function pollRepository(ctx: SourceContext, round: Round, target?: RepositoryBinding): Promise<void> {
  const stored = ctx.config<GithubConfig>(SOURCE)
  if (!stored) return
  // App installations have no personal notification inbox. Read repository streams to discover mentions;
  // the unchanged Source configuration and policy still decide which unaddressed events are admitted.
  const config = !target && ctx.deployment.github.auth === 'app'
    ? { ...stored, observeIssues: true, observePulls: true, observeComments: true, observeCi: true } : stored
  for (const stream of STREAMS) {
    if (stopped(ctx, round)) return
    const cursor = KV.github.stream(target ? `${target.repository}:${stream.id}` : stream.id)
    if (!stream.observed(config)) { ctx.state.set(cursor, undefined); continue }
    try { await readStream(ctx, round, stream.id, stream.path, config, cursor, target) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${stream.id}: ${String(error)}`) }
  }
  // When CI observation is turned off, clear the failure baseline but preserve the revision counter so future triggers have unique IDs.
  if (!config.observeCi) {
    const name = target ? KV.github.repositoryCi(target.repository) : KV.github.branchCi
    const seen = ctx.state.get(name)
    ctx.state.set(name, seen && { revision: seen.revision })
    return
  }
  try { await pollBranchCi(ctx, round, target?.repository) }
  catch (error) { if (!stopped(ctx, round)) round.failures.push(`default branch CI: ${String(error)}`) }
}
/**
 * Polls one repository-wide event stream (oldest first) since its cursor and steps the cursor to five seconds before the
 * newest item (`cursorAt`), relying on Trigger ID deduplication so repeated messages are no-ops. While the cursor stays
 * unchanged (including when clamped to the hourly horizon), sending the last page's ETag makes an unchanged list return
 * HTTP 304 and cost no rate limit. Items from before their kind was switched on or beyond the horizon are ignored.
 */
async function readStream(ctx: SourceContext, round: Round, id: string, path: string, config: GithubConfig,
  name: ReturnType<typeof KV.github.stream>, target?: RepositoryBinding): Promise<void> {
  const previous = ctx.state.get(name)
  const stored = previous?.boundAt === target?.since ? previous : undefined
  const boundAt = target ? Date.parse(target.since) : NaN
  const start = Number.isFinite(boundAt) ? new Date(Math.floor(boundAt / 1000) * 1000).toISOString() : round.started
  const kinds = id === 'issues' ? [...config.observeIssues ? ['issues'] : [], ...config.observePulls ? ['pulls'] : []] : ['comments']
  const before = typeof stored?.started === 'object' ? stored.started : {}
  const started: Record<string, string> = Object.fromEntries(kinds.map(kind => [kind, before[kind] ?? (stored ? round.started : start)]))
  const horizon = Math.floor((Date.parse(round.started) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
  const since = new Date(Math.max(Date.parse(stored?.since ?? start), horizon)).toISOString()
  const conditional = stored?.etag && stored.since === since ? ['-H', `If-None-Match: ${stored.etag}`] : []
  let raw: string
  const listed = `${path}&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`
  const commands = target ? ctx.commands.forRepository(target.repository) : ctx.commands
  try { raw = await commands.withSignal(round.signal).api(listed, '--include', ...conditional) }
  catch (error) {
    if (error instanceof CliError && error.code === 304) return
    throw error
  }
  if (target && !ctx.projectRepositories?.().some(binding => sameName(binding.repository, target.repository))) return
  const { headers, body } = included(raw)
  const items = validItems(ListedSchema, z.array(z.unknown()).parse(JSON.parse(body)), round.tally)
  const { login } = ctx.deployment.github
  const receive = (trigger: Parameters<typeof ctx.receive>[0]) => ctx.receive(target ? repositoryEvent(trigger, target.repository) : trigger)
  const fresh = (at: string | null | undefined, kind: string) =>
    kind in started && Date.parse(at ?? '') >= Math.max(Date.parse(started[kind]!), horizon)
  for (const item of items) {
    // Stopping mid-stream aborts before advancing the cursor so unread items are retried.
    if (stopped(ctx, round)) throw new Error('The GitHub Source stopped during the poll')
    if (sameName(item.user.login, login) && !(id === 'issues' && ctx.deployment.github.auth === 'app')) continue
    if (id === 'issues') {
      const issue = IssueSchema.safeParse(item)
      const pr = issue.success && !!issue.data.pull_request
      if (!target && issue.success && ctx.deployment.github.auth === 'app') {
        await pollRequests(ctx, issue.data.number, !!pr, since, issue.data.title, issue.data.body, round.signal)
      }
      if (!target && issue.success && pr && ctx.deployment.github.auth === 'app') {
        round.read.add(issue.data.number)
        await readNotified(ctx, round, issue.data.number, { since, pr: true })
        continue
      }
      if (sameName(item.user.login, login)) continue
      if (!issue.success || !fresh(issue.data.created_at, pr ? 'pulls' : 'issues')) continue
      await receive(pr ? pullTrigger(issue.data, login) : issueTrigger(issue.data, login))
      nameThread(ctx, issue.data.number, issue.data.title, target?.repository, !!pr)
      continue
    }
    const number = Number(/\/(?:issues|pulls)\/(\d+)$/.exec((id === 'comments' ? item.issue_url : item.pull_request_url) ?? '')?.[1])
    if (!number || !fresh(item.updated_at ?? item.created_at, 'comments')) continue
    const isPr = id === 'review-comments' || /\/pull\//.test(item.html_url ?? '')
    const ref = { number, isPr, ...item.html_url ? { url: item.html_url } : {} }
    if (isPr && linkedProjectPull(ctx, target?.repository ?? ctx.deployment.repository, number)) continue
    const trigger = commentTrigger(item, ref, id === 'comments' ? 'conversation' : 'inline', login)
    if (trigger.text) await receive(trigger)
  }
  const newest = Math.max(...items.map(item => Date.parse(item.updated_at ?? '')).filter(Number.isFinite))
  const moved = Number.isFinite(newest) ? cursorAt(new Date(newest).toISOString()) : since
  const next = Date.parse(moved) > Date.parse(since) ? moved : since
  const etag = /^etag:\s*(.+)$/im.exec(headers)?.[1]?.trim()
  // The ETag belongs to this request, which the next round repeats only while the cursor stays unchanged.
  ctx.state.set(name, { since: next, started, ...(target && { boundAt: target.since }), ...etag && next === since ? { etag } : {} })
}
/** Report a stable completed branch CI snapshot once per head/execution; never report partial results. */
async function pollBranchCi(ctx: SourceContext, round: Round, repository?: string): Promise<void> {
  const commands = (repository ? ctx.commands.forRepository(repository) : ctx.commands).withSignal(round.signal)
  const name = repository ? KV.github.repositoryCi(repository) : KV.github.branchCi
  const app = !repository && ctx.deployment.github.auth === 'app'
  const branch = app ? 'main' : (await commands.api(z.looseObject({ default_branch: z.string() }), '')).default_branch
  const head = await commands.api(z.looseObject({ sha: z.string() }), `commits/${encodeURIComponent(branch)}`)
  const snapshot = await pullChecks(commands, head.sha, round.tally)
  const previous = ctx.state.get(name)
  const failures = ciFailures(snapshot)
  const counts = ciCounts(snapshot)
  const fingerprint = key(JSON.stringify(snapshot))
  const sameBranch = previous?.branch === branch
  let revision = previous?.revision ?? 0
  let reported = sameBranch ? previous?.reported : undefined
  let reportedSnapshot = sameBranch ? previous?.reportedSnapshot : undefined
  if (counts.running || !snapshot.checks.length && !snapshot.statuses.length
    || snapshot.checks.some(check => check.conclusion === null)) {
    ctx.state.set(name, { branch, failures: sameBranch ? previous?.failures : undefined, revision, reported,
      reportedSnapshot })
    return
  }
  if (sameBranch && previous?.settled === fingerprint && reported !== fingerprint) {
    const last = reportedSnapshot?.head === head.sha ? reportedSnapshot : undefined
    const checks = new Set(last?.checks.map(check => check.id ?? check.name))
    const statuses = new Set(last?.statuses.map(status => status.context))
    const changes = { head: snapshot.head,
      checks: snapshot.checks.filter(check => !checks.has(check.id ?? check.name)),
      statuses: snapshot.statuses.filter(status => !statuses.has(status.context)) }
    if (changes.checks.length || changes.statuses.length) {
      revision += 1
      const summary = ciSummary(changes, branch, `github/commits/${head.sha}/checks`)
      const url = `https://github.com/${repository ?? ctx.deployment.repository}/commit/${head.sha}`
      const trigger = branchCiTrigger(branch, head.sha, revision, summary, url, ciCounts(changes).failed)
      trigger.meta.checks = changes
      trigger.text += `\nNew checks and statuses for this task:\n${JSON.stringify(changes)}`
      const event = repository ? repositoryEvent(trigger, repository) : trigger
      await ctx.receive(event)
      ctx.threads.describe(`github:${event.threads[0]!.id}`, { label: `CI on ${branch}`, facts: { ci: ciFact(counts) } })
      reportedSnapshot = snapshot
    }
    reported = fingerprint
  }
  ctx.state.set(name, { branch, failures, revision, settled: fingerprint, reported,
    reportedSnapshot })
}
/**
 * One polling round: notifications, then observed repository streams, then lifecycle state of ticket PRs, then
 * subscribed Threads. Each step and each Issue, PR, or Thread fails independently so all steps run before the round fails.
 * Other read failures (including 404) fail the round toward the error threshold, whereas deleted (410) or abandoned
 * (24h+) threads are recorded only on the thread and in health detail.
 * @returns the polling interval requested by GitHub, in seconds.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  const notified = await (ctx.deployment.github.auth === 'app' ? Promise.resolve({ count: 0, interval: 60 })
    : pollNotifications(ctx, round)).then(value => ({ value }), (error: unknown) => ({ error }))
  await pollRepository(ctx, round)
  await pollTicketPulls(ctx, signal, round)
  await pollThreads(ctx, signal, round)
  if ('error' in notified) throw notified.error
  const { count, interval } = notified.value
  if (signal?.aborted) return interval
  if (round.failures.length) throw new Error(`${round.failures.length} GitHub reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const named = (numbers: number[]) => [...new Set(numbers)].sort((a, b) => a - b).map(number => `#${number}`).join(', ')
  const dropped = (round.dropped.length ? `; deleted on GitHub: ${named(round.dropped)}` : '')
    + (round.abandoned.length ? `; dropped after their reads kept failing: ${named(round.abandoned)}` : '')
    + (round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : '')
  ctx.report('github', { state: 'ready', detail: `${ctx.deployment.github.auth === 'app' ? 'App repository polling' : `${count} notifications`}; next poll ≥ ${interval}s${dropped}`, at: round.started })
  return interval
}
/** Reads notifications since the cursor and each Issue or PR they name, advancing the cursor atomically with the retry map for failed reads; deleted (410) Issues are dropped once their error is recorded. */
async function pollNotifications(ctx: SourceContext, round: Round): Promise<{ count: number; interval: number }> {
  const { state } = ctx
  const commands = ctx.commands.withSignal(round.signal)
  const since = state.get(KV.github.since) ?? round.started
  if (state.get(KV.github.since) === undefined) state.set(KV.github.since, since)
  const { repository } = ctx.deployment
  const path = `notifications?all=true&per_page=50&since=${encodeURIComponent(since)}`
  const raw = await commands.api(path, '--include')
  const split = raw.search(/\r?\n\r?\n/)
  if (split < 0) throw new Error('GitHub returned no HTTP headers')
  const headers = raw.slice(0, split)
  const body = raw.slice(split).trim()
  const asked = Number(/x-poll-interval:\s*(\d+)/i.exec(headers)?.[1] ?? 60)
  const interval = Math.max(60, Number.isFinite(asked) ? asked : 60)
  const notifications = /rel="next"/.test(headers)
    ? await commands.pages(NotificationSchema, path, round.tally)
    : validItems(NotificationSchema, z.array(z.unknown()).parse(JSON.parse(body)), round.tally)
  const retries = { ...state.get(KV.github.retries) }
  // Failed items from the previous round run first, followed by newly notified items in chronological order; each is read once.
  const items = new Map(Object.entries(retries).map(([number, retry]) => [Number(number), retry]))
  for (const notification of notifications.reverse()) {
    if (!sameName(notification.repository.full_name, repository)) continue
    const address = githubAddress(notification.subject.url ?? '', repository)
    if (!address || address.discussion || items.has(address.number)) continue
    const { number, pr } = address
    items.set(number, { since: [state.get(KV.github.cursor(number)) ?? since, since].sort().at(-1)!, pr })
  }
  for (const [number, item] of items) {
    if (stopped(ctx, round)) return { count: notifications.length, interval }
    round.read.add(number)
    try {
      await readNotified(ctx, round, number, item)
      delete retries[number]
    } catch (error) {
      if (stopped(ctx, round)) return { count: notifications.length, interval }
      const retry = { ...item, failedAt: item.failedAt ?? round.started, attempts: (item.attempts ?? 0) + 1 }
      // Abandon notification retries after 24 hours of failures so a permanently unreadable thread does not hold source health in error; its cursor stays so a later notification or thread poll still reads what was missed.
      const abandoned = Date.parse(round.started) - Date.parse(retry.failedAt) >= RETRY_WINDOW_MS
      failed(ctx, round, number, error, abandoned)
      if (!deleted(error) && !abandoned) { retries[number] = retry; continue }
      delete retries[number]
    }
  }
  ctx.atomic(() => { state.set(KV.github.since, cursorAt(round.started)); state.set(KV.github.retries, retries) })
  return { count: notifications.length, interval }
}
async function readNotified(ctx: SourceContext, round: Round, number: number, item: Retry): Promise<void> {
  const { since } = item
  let isPr = item.pr
  if (!isPr) {
    const issue = await ctx.commands.withSignal(round.signal).api(IssueSchema, `issues/${number}`)
    // `issues/<n>` also returns PRs with `pull_request` set; handle them in the PR branch below.
    isPr = !!issue.pull_request
    if (!isPr) {
      // An Issue opened by someone other than the agent since the cursor brings its body so a mention in it reaches the gate.
      // A mention added by a later edit to the body is not read: only the author can be the actor of the body.
      const { login } = ctx.deployment.github
      const opened = Date.parse(issue.created_at) >= Date.parse(since) && !sameName(issue.user.login, login)
      if (opened) await ctx.receive(issueTrigger(issue, login))
      await intakeComments(ctx, { number, isPr: false, url: issue.html_url }, since, round)
      nameThread(ctx, number, issue.title)
    }
  }
  if (isPr) {
    const pr = await pull(ctx, round, number)
    // Emit a PR description trigger for PRs opened since the cursor; its ID is the same as the one produced by the repository PR stream.
    const { login } = ctx.deployment.github
    if (pr.created_at && Date.parse(pr.created_at) >= Date.parse(since) && !sameName(pr.user.login, login)) {
      const opened = { number, title: pr.title ?? '', body: pr.body, user: pr.user, created_at: pr.created_at, html_url: pr.html_url }
      await ctx.receive(pullTrigger(opened, login))
    }
    await intakeComments(ctx, { number, isPr: true, url: pr.html_url, prAuthor: pr.user.login }, since, round)
    if (pr.title) nameThread(ctx, number, pr.title)
  }
  ctx.state.set(KV.github.cursor(number), cursorAt(round.started))
  ctx.threads.patch(`github:${number}`, { pollError: undefined })
}
/** Reads and observes a PR at most once per polling round. */
function pull(ctx: SourceContext, round: Round, number: number): Promise<Pull> {
  let read = round.pulls.get(number)
  if (!read) {
    read = readPull(ctx, number, round.signal).then(async pr => { await observePull(ctx, pr); return pr })
    round.pulls.set(number, read)
  }
  return read
}
async function intakeComments(ctx: SourceContext, ref: PullRef, since: string, round: Round): Promise<void> {
  if (ref.isPr && linkedProjectPull(ctx, ctx.deployment.repository, ref.number)) return
  const commands = ctx.commands.withSignal(round.signal)
  const { login } = ctx.deployment.github
  const kinds = ref.isPr ? ['conversation', 'inline', 'review'] as const : ['conversation'] as const
  for (const kind of kinds) {
    const suffix = `&since=${encodeURIComponent(since)}`
    const path = kind === 'conversation' ? `issues/${ref.number}/comments?per_page=100${suffix}` : kind === 'inline' ? `pulls/${ref.number}/comments?per_page=100${suffix}` : `pulls/${ref.number}/reviews?per_page=100`
    const comments = await commands.pages(CommentSchema, path, round.tally)
    for (const comment of comments) {
      // Stopping mid-read throws so the thread's cursor stays where it was.
      if (stopped(ctx, round)) throw new Error('The GitHub Source stopped during the poll')
      const timestamp = Date.parse(comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? '')
      if (!Number.isFinite(timestamp) || timestamp < Date.parse(since)) continue
      if (sameName(comment.user.login, login)) continue
      // A review decision without a body still reaches the ticket: a worker may be waiting for that approval.
      const trigger = commentTrigger(comment, ref, kind, login)
      if (trigger.text) await ctx.receive(trigger)
    }
  }
}
export async function pollTicketPulls(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  const numbers = [...new Set(ctx.tickets.open().flatMap(ticket => pullsOf(ticket, true)))]
  for (const number of numbers) {
    if (stopped(ctx, round)) return
    try {
      await pull(ctx, round, number)
    } catch (error) { if (!stopped(ctx, round)) failed(ctx, round, number, error) }
  }
}
function nameThread(ctx: SourceContext, number: number, title: string, repository?: string, pr?: boolean): void {
  const thread = repository ? `github:${repositoryThreadId(repository, number, !!pr)}` : `github:${number}`
  ctx.threads.patch(thread, { title, ...(repository && { repository, isPr: !!pr, number, url: `https://github.com/${repositoryThreadId(repository, number, !!pr)}` }) })
  ctx.threads.describe(thread, { label: `${repository ?? ''}#${number} ${title}`, facts: { number: { value: `#${number}` } } })
}
/** Polls subscribed Issue and PR Threads not already read in this round; a deleted (410) Issue is still polled within the horizon (costing one read) and does not fail the round. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) {
      if (stopped(ctx, round)) throw error
      if (deleted(error)) round.dropped.push(Number(thread.ref.id)); else round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  }, thread => round.read.has(Number(thread.ref.id)))
}
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  // The default branch's CI Thread has no Issue or PR to read; its CI arrives as Triggers.
  if (thread.ref.id.startsWith('ci:') || thread.ref.id.startsWith('request:') || thread.ref.id.includes('/')) return
  const number = Number(thread.ref.id)
  if (!number) throw new Error('Subscribed thread has no GitHub issue or PR number')
  round.read.add(number)
  if (typeof thread.meta.isPr !== 'boolean' || typeof thread.meta.title !== 'string') {
    const issue = await ctx.commands.withSignal(round.signal).api(IssueSchema, `issues/${number}`)
    ctx.threads.patch(thread.key, { number, isPr: !!issue.pull_request, url: issue.html_url })
    if (issue.title) nameThread(ctx, number, issue.title)
    thread = ctx.threads.get(thread.key) ?? thread
  }
  const checkpoint = KV.github.cursor(number)
  const since = ctx.state.get(checkpoint) ?? thread.createdAt
  if (thread.meta.isPr === true) {
    const pr = await pull(ctx, round, number)
    await intakeComments(ctx, { number, isPr: true, url: pr.html_url, prAuthor: pr.user.login }, since, round)
  } else await intakeComments(ctx, { number, isPr: false }, since, round)
  ctx.state.set(checkpoint, cursorAt(round.started))
}

function linkedProjectPull(context: SourceContext, repository: string, number: number): boolean {
  return context.projectResources?.().some(target => sameName(target.repository, repository)
    && target.pullUrls.some(url => url.toLowerCase() === `https://github.com/${repository.toLowerCase()}/pull/${number}`)) ?? false
}
