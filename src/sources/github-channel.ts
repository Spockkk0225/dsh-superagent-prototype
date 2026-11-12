/** GitHub outbound channel: posts issue/PR comments and review thread replies under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { githubAddress, githubPage } from './github-trigger.ts'

const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), in_reply_to_id: z.number().nullish(), user: z.looseObject({ login: z.string() }).nullish(),
})
/** True when an issue is permanently deleted (410) or locked (403); 404 is retried because it can indicate temporary permission loss on a private repo. */
const gone = (error: unknown): boolean => error instanceof CliError
  && (error.code === 410 || (error.code === 403 && /locked/i.test(error.message)))
const missing = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)
/** Create/update one comment per mirrored card/round; markers make retries idempotent and prevent stale snapshots winning. */
export async function sendGithub(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const { repository, github } = commands.deployment
  const number = Number(message.channel.address.number)
  if (!number) throw new Error('Missing GitHub reply target')
  try {
    // Retained trigger URLs also route replies queued before thread-aware delivery.
    const address = githubAddress(message.channel.address.url ?? '', repository)
    let rootId: number | undefined
    if (address?.pr && address.discussion && address.number === number) {
      // Fall back to a top-level PR comment if the target inline review comment was deleted.
      const source = await commands.api(CommentSchema, `pulls/comments/${address.discussion}`)
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
    const mine = (comment: z.infer<typeof CommentSchema>) => sameName(comment.user?.login ?? '', github.login)
      && (rootId === undefined || comment.in_reply_to_id === rootId) && (comment.body ?? '').includes(marker)
    const existing = (await commands.pages(CommentSchema, path)).find(mine)
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
  const review = !!links.repository && !!githubAddress(address.url ?? '', links.repository)?.discussion
  return { url: address.url ?? (links.repository ? githubPage(links.repository, Number(number)) : ''),
    label: review ? { zh: `GitHub #${number} 的 review 讨论`, en: `Review discussion on GitHub #${number}` }
      : { zh: `GitHub #${number}`, en: `GitHub #${number}` } }
}
