import type { ChannelRef, OutboundMessage, MessagePresentation } from '../core/index.ts'
import { dingTalkRoute } from '../sources/dingtalk.ts'
import type { Member, ProjectDetail } from './projects.ts'
import type { Store } from './store.ts'

export function announce(host: { store: Store; notify(message: OutboundMessage): void }, project: ProjectDetail,
  id: string, content: string | MessagePresentation, recipient?: Member) {
  if (!project.dingTalkGroup || host.store.replyStatus(id)) return
  host.notify({ id, kind: 'notice', text: typeof content === 'string' ? content : content.summary,
    ...(typeof content === 'string' ? {} : { presentation: content }), channel: projectChannel(host.store, project, recipient) })
}

/** Resolve a project's current delivery channel and verified, corporation-scoped member mention. */
export function projectChannel(store: Store, project: Pick<ProjectDetail, 'id' | 'dingTalkGroup' | 'decisions'>, recipient?: Member): ChannelRef {
  if (!project.dingTalkGroup) return { source: 'request', thread: project.id, address: {} }
  const conversationId = project.dingTalkGroup
  const address: Record<string, string> = { conversationId }
  if (recipient) {
    const route = store.get(dingTalkRoute(conversationId))
    const meeting = route?.corpId ? undefined : project.decisions.findLast(decision => decision.meetingSource?.source === 'dingtalk')?.meetingSource
    const origin = meeting && store.triggers.get(meeting.triggerId)
    const corpId = route?.corpId ?? (origin?.meta.conversationId === conversationId ? origin.meta.senderCorpId : undefined)
    const account = recipient.accounts.find(item => item.provider === 'dingtalk' && item.scope === corpId)
    if (account) address.mentionUserId = account.accountId
  }
  return { source: 'dingtalk', thread: `dingtalk:${conversationId}`, address }
}
