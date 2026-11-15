/** DingTalk card transport; original Source KV and Outbox retain ownership of delivery and reply routing. */
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import type { SourceContext } from './host.ts'
import { githubChannel } from './github-trigger.ts'

interface Card {
  triggerId: string; conversationId: string; templateId: string; used: boolean; sent: boolean
  ticketId?: string
  ticketIds?: string[]
  closed?: boolean
  informational?: boolean
  replyReminded?: boolean
  acknowledgementId?: string
  /** Legacy transport delivery binding, retained only to finish inputs already in flight. */
  deliveryId?: string
  githubMentions?: string[]
  githubMirrorSuppressed?: boolean
  githubMessages?: { id: string; text: string }[]
  messages?: { id: string; text: string; flowStatus: '2' | '3' }[]
}
const cards = family<Card, [string]>('dingtalk-card:')
const deliveries = family<string, [string]>('dingtalk-card-delivery:')
const triggerCards = family<string, [string]>('dingtalk-card-trigger:')
const workerDeliveries = family<string, [string, string]>('dingtalk-card-worker-delivery:')
export const receiptId = (triggerId: string) => key('dingtalk-received', triggerId)
const receiptText = (trigger: Trigger) => `已收到 ${trigger.channel?.address.eventLabel ?? trigger.source} 消息。`
const triggerKey = (conversation: string, trigger: string) => triggerCards(key(conversation, trigger, ''))
const closed = (card: Card) => card.closed ?? card.messages?.at(-1)?.flowStatus === '3'
const acknowledged = (card: Card) => !!card.acknowledgementId || !!card.messages?.some(message => message.flowStatus === '2')

const belongsTo = (card: Card, ticketId: string) => card.ticketId === ticketId || !!card.ticketIds?.includes(ticketId)
function bindTicket(card: Card, ticketId?: string): void {
  if (!ticketId) return
  card.ticketIds = [...new Set([...card.ticketIds ?? [], ...card.ticketId ? [card.ticketId] : [], ticketId])]
  card.ticketId ??= ticketId
}

/** Includes completed events so missing input context cannot fall back to an older source card. */
export function hasCardBinding(context: SourceContext, ticketId?: string, triggerId?: string): boolean {
  return context.state.keys(cards).some(name => {
    const card = context.state.get(name)
    return !!card && (ticketId ? belongsTo(card, ticketId) : !!triggerId && card.triggerId === triggerId)
  })
}

/** Resolve the card supplied by an input/handoff, never a worker's latest card. */
export function resolveCardReply(context: SourceContext, id: string, ticketId?: string) {
  const card = context.state.get(cards(id))
  if (!card || ticketId && !belongsTo(card, ticketId)) throw new Error('Card is not bound to this task')
  if (!closed(card) && !pendingCardReplies(context, ticketId).some(pending => pending.card_id === id)) {
    throw new Error('This card has no open processing round; do not send another final reply')
  }
  return { ticket_id: ticketId ?? card.ticketId, closed: !!closed(card), channel: { source: 'dingtalk', thread: `dingtalk:${card.conversationId}`,
    address: { conversationId: card.conversationId, triggerId: card.triggerId, cardId: id } } }
}

/** Confirmation identity follows the input event, including across task handoffs. */
export function cardAcknowledgementId(context: SourceContext, _ticketId: string, trigger: Trigger): string | undefined {
  if (trigger.channel?.source !== 'dingtalk') return undefined
  const conversation = trigger.channel.address.conversationId!
  const id = trigger.channel.address.cardId ?? context.state.get(triggerKey(conversation, trigger.id))
  const card = id ? context.state.get(cards(id)) : undefined
  if (!card) return undefined
  return card.acknowledgementId ?? card.messages?.find(message => message.flowStatus === '2')?.id
    ?? key('dingtalk-card-ack', id!)
}

/** Explicit confirmation/results for GitHub mentions are delivered to GitHub as well as the bound IM channel. */
export function githubMentionReplies(context: SourceContext, message: OutboundMessage): OutboundMessage[] {
  if (message.channel.source !== 'dingtalk' || !['acknowledgement', 'reply'].includes(message.kind)) return []
  const cardId = message.channel.address.cardId
  const card = cardId ? context.state.get(cards(cardId)) : undefined
  // An IM follow-up in this round may contain private context; it does not authorize publishing that context to GitHub.
  if (card?.githubMirrorSuppressed) return []
  const ids = card?.githubMentions?.length ? card.githubMentions : [message.channel.address.triggerId ?? '']
  const targets = new Map<string, Trigger>()
  for (const id of ids) {
    const trigger = context.triggers.get(id)
    if (trigger?.source !== 'github' || !trigger.human || !trigger.addressed) continue
    const number = Number(trigger.meta.number)
    if (!Number.isInteger(number) || number < 1) continue
    const root = trigger.meta.kind === 'inline' ? String(trigger.meta.inReplyTo ?? trigger.meta.commentId) : ''
    targets.set(key(String(number), root), trigger)
  }
  const prefix = 'This is by an automated agent, not a human.'
  let text = message.text.startsWith(prefix) ? message.text : `${prefix}\n\n${message.text}`
  let revision: number | undefined
  if (card && targets.size) {
    // Save cumulative snapshots at enqueue time, rather than depending on which destination is delivered first.
    const parts = card.githubMessages ?? []
    if (!parts.some(part => part.id === message.id)) parts.push({ id: message.id,
      text: message.text.startsWith(prefix) ? message.text.slice(prefix.length).trimStart() : message.text })
    card.githubMessages = parts
    context.state.set(cards(cardId!), card)
    revision = parts.length
    text = `${prefix}\n\n${parts.map(part => part.text).join('\n\n---\n\n')}`
  }
  return [...targets].map(([target, trigger]) => ({ ...message,
    id: key('github-mention-reply', message.id, target),
    channel: { ...githubChannel(Number(trigger.meta.number), trigger.url), address: {
      ...githubChannel(Number(trigger.meta.number), trigger.url).address,
      ...revision !== undefined ? { commentKey: key('github-card-comment', cardId!, target), revision: String(revision) } : {},
    } },
    text,
  }))
}

/** Transport-owned event cards awaiting a final outcome. */
export function pendingCardReplies(context: SourceContext, ticketId?: string) {
  return context.state.keys(cards).flatMap(name => {
    const card = context.state.get(name)
    if (!card || closed(card) || ticketId && !belongsTo(card, ticketId)) return []
    const id = name.slice(cards.prefix.length)
    // Leave historical cards from the FIFO implementation untouched.
    const bound = context.state.get(triggerKey(card.conversationId, card.triggerId)) === id
      || !!card.ticketId && !!card.deliveryId && context.state.get(workerDeliveries(card.ticketId, card.deliveryId)) === id
    if (!bound) return []
    return [{ card_id: id, trigger_id: card.triggerId, ticket_id: ticketId ?? card.ticketId,
      conversation_id: card.conversationId, initial_confirmation_required: !acknowledged(card),
      reply_reminded: card.replyReminded ?? false }]
  })
}

export function remindCardReply(context: SourceContext, id: string): boolean {
  const card = context.state.get(cards(id))
  if (!card || closed(card) || card.replyReminded) return false
  context.state.set(cards(id), { ...card, replyReminded: true })
  return true
}

/** Initial agent confirmation for any bound card, including system events and cards owned by the main agent. */
export function acknowledgeCard(context: SourceContext, id: string, text: string, ticketId?: string): string {
  return context.atomic(() => {
    const card = context.state.get(cards(id))
    if (!card || ticketId && !belongsTo(card, ticketId)) throw new Error('Card is not bound to this session')
    if (card.acknowledgementId) return card.acknowledgementId
    const previous = card.messages?.find(message => message.flowStatus === '2')
    if (previous) return previous.id
    if (!pendingCardReplies(context, ticketId).some(pending => pending.card_id === id)) {
      throw new Error('Card has no open delivery binding')
    }
    const replyId = key('dingtalk-card-ack', id)
    context.state.set(cards(id), { ...card, acknowledgementId: replyId })
    const owner = ticketId ?? card.ticketId
    context.notify({ id: replyId, kind: 'acknowledgement', ...owner ? { ticketId: owner } : {}, text,
      channel: { source: 'dingtalk', thread: `dingtalk:${card.conversationId}`, address: {
        conversationId: card.conversationId, triggerId: card.triggerId, cardId: id,
      } } })
    return replyId
  })
}

/** Called only by an agent's explicit reply tool, never synthesizes a successful result. */
export function replyToCard(context: SourceContext, id: string, text: string, ticketId?: string): string {
  return context.atomic(() => {
    const card = context.state.get(cards(id))
    if (!card || ticketId && !belongsTo(card, ticketId)) throw new Error('Card is not bound to this session')
    if (closed(card)) throw new Error('This card already has a final reply queued; do not send another')
    if (!pendingCardReplies(context, ticketId).some(pending => pending.card_id === id)) {
      throw new Error('Card has no current delivery binding')
    }
    if (!acknowledged(card)) throw new Error('Send the initial card confirmation with action=acknowledge before the final reply')
    const replyId = key('dingtalk-card-final', id, text)
    context.state.set(cards(id), { ...card, closed: true })
    const owner = ticketId ?? card.ticketId
    context.notify({ id: replyId, kind: 'reply', ...owner ? { ticketId: owner } : {}, text,
      channel: { source: 'dingtalk', thread: `dingtalk:${card.conversationId}`, address: {
        conversationId: card.conversationId, triggerId: card.triggerId, cardId: id,
      } } })
    return replyId
  })
}

/** Bind a reply at enqueue time; retries and later events cannot move it to a different card. */
export function bindDingTalkReply(context: SourceContext, message: OutboundMessage): OutboundMessage {
  if (message.channel.source !== 'dingtalk') return message
  if (message.channel.address.cardId) {
    const id = message.channel.address.cardId
    const card = context.state.get(cards(id))
    if (!card || message.ticketId && !belongsTo(card, message.ticketId)) throw new Error('Card is not bound to this reply')
    if (message.kind === 'acknowledgement' && !acknowledged(card)) card.acknowledgementId = message.id
    if (message.kind === 'reply') {
      if (!acknowledged(card)) throw new Error('Send the initial card confirmation with action=acknowledge before the final reply')
      card.closed = true
    }
    context.state.set(cards(id), card)
    return message
  }
  const conversation = message.channel.address.conversationId!
  const trigger = message.channel.address.triggerId
  if (!trigger) return message
  const id = context.state.get(triggerKey(conversation, trigger))
  // A text-only deployment has no event-card binding.
  if (!id) return message
  const card = context.state.get(cards(id))
  if (!card) throw new Error('Event card binding is missing its card')
  bindTicket(card, message.ticketId)
  if (message.kind === 'acknowledgement' && !acknowledged(card)) card.acknowledgementId = message.id
  if (message.kind === 'reply') {
    if (!acknowledged(card)) throw new Error('Send the initial card confirmation with action=acknowledge before the final reply')
    card.closed = true
  }
  context.state.set(cards(id), card)
  return { ...message, channel: { ...message.channel, thread: `dingtalk:${card.conversationId}`,
    address: { ...message.channel.address, conversationId: card.conversationId, triggerId: card.triggerId, cardId: id } } }
}
/** Creates AI receipts/feedback cards whose summary carries the task reference for native quoted replies. */
export class DingTalkCards {
  constructor(private readonly context: SourceContext, private readonly templateId: string,
    private readonly token: () => Promise<string>, private readonly http: typeof fetch = fetch,
    private readonly robotCode?: string, private readonly robotName = 'Super agent') {}

  /** Called in the same transaction as intake; no model call or remote API delays the receive ACK. */
  received(trigger: Trigger): void {
    const conversation = trigger.channel!.address.conversationId!
    const binding = triggerKey(conversation, trigger.id)
    if (this.context.state.get(binding)) return
    const id = receiptId(trigger.id)
    this.context.state.set(binding, id)
    this.context.state.set(cards(id), this.context.state.get(cards(id)) ?? { triggerId: trigger.id, conversationId: conversation,
      templateId: this.templateId, used: false, sent: false, closed: false,
      ...trigger.source === 'github' && trigger.human && trigger.addressed ? { githubMentions: [trigger.id] } : {} })
    this.context.notify({ id, kind: 'notice',
      channel: { ...trigger.channel!, address: { ...trigger.channel!.address, cardId: id } }, text: receiptText(trigger) })
  }

  /** Called synchronously immediately before a worker message is submitted; every delivery has an immutable card binding. */
  delivery(ticketId: string, deliveryId: string, triggerId: string) {
    return this.context.atomic(() => {
      const saved = this.context.state.get(workerDeliveries(ticketId, deliveryId))
      if (saved) {
        const card = this.context.state.get(cards(saved))
        if (!card || card.triggerId !== triggerId) throw new Error('Delivery is already bound to another event')
        return { card_id: saved, ticket_id: ticketId, trigger_id: triggerId }
      }
      const trigger = this.context.triggers.get(triggerId)
      if (trigger?.channel?.source !== 'dingtalk') return undefined
      this.received(trigger)
      const id = this.context.state.get(triggerKey(trigger.channel.address.conversationId!, triggerId))!
      const card = this.context.state.get(cards(id))!
      bindTicket(card, ticketId)
      card.ticketId = ticketId
      // A new handoff continues the same event even if a previous handler closed it.
      card.closed = false
      card.replyReminded = false
      if (trigger.source === 'github' && trigger.human && trigger.addressed) {
        card.githubMentions = [...new Set([...card.githubMentions ?? [], triggerId])]
      } else if (trigger.source !== 'github') card.githubMirrorSuppressed = true
      this.context.state.set(cards(id), card)
      this.context.state.set(workerDeliveries(ticketId, deliveryId), id)
      return { card_id: id, ticket_id: ticketId, trigger_id: triggerId }
    })
  }

  async send(message: OutboundMessage): Promise<void> {
    // The fallback send path must register the event binding before creating a card.
    const incoming = message.channel.address.triggerId
    const event = incoming ? this.context.triggers.get(incoming) : undefined
    if (event?.channel?.source === 'dingtalk' && !message.channel.address.cardId) this.received(event)
    message = bindDingTalkReply(this.context, message)
    const conversationId = message.channel.address.conversationId!
    const triggerId = message.channel.address.triggerId
    const origin = triggerId ? this.context.triggers.get(triggerId) : undefined
    if (!origin || origin.channel?.source !== 'dingtalk' || origin.channel.address.conversationId !== conversationId) {
      throw new Error('DingTalk card has no matching source message')
    }
    const placeholder = message.kind === 'notice' && (message.id === receiptId(origin.id)
      || message.id === key('dingtalk-round-received', message.channel.address.cardId ?? ''))
    const mapped = this.context.state.get(deliveries(message.id))
    const id = mapped ?? message.channel.address.cardId ?? receiptId(origin.id)
    const saved = this.context.state.get(cards(id))
    // A model may enqueue its acknowledgement before the receipt was delivered. Never overwrite that feedback with a late placeholder.
    if (placeholder && saved?.used) return
    this.context.state.set(deliveries(message.id), id)
    const card: Card = saved ?? { triggerId: origin.id, conversationId, templateId: this.templateId, used: false, sent: false }
    card.templateId ||= this.templateId
    bindTicket(card, message.ticketId)
    if (!placeholder) {
      card.used = true
      card.messages ??= []
      if (!card.messages.some(item => item.id === message.id)) card.messages.push({ id: message.id, text: message.text,
        flowStatus: message.kind === 'acknowledgement' ? '2' : '3' })
    }
    this.context.state.set(cards(id), card)
    const taskLabel = card.ticketId ? `#${card.ticketId.slice(0, 12)}` : ''
    const cardOrigin = this.context.triggers.get(card.triggerId) ?? origin
    const eventLabel = cardOrigin.channel?.address.eventLabel
    const heading = [taskLabel, eventLabel].filter(Boolean).join(' · ')
    const flowStatus = placeholder ? card.informational ? '3' : '2' : card.messages!.at(-1)!.flowStatus
    const text = [receiptText(cardOrigin), ...card.messages?.map(item => item.text) ?? []].join('\n\n---\n\n')
    const data = { title: [heading, this.robotName].filter(Boolean).join(' '),
      status: flowStatus === '2' ? '输出中' : '完成',
      markdown: heading ? `${heading}\n\n${text}` : text, flowStatus,
      replyHint: '---\n\n引用此卡片以回复消息。',
    }
    const body = { outTrackId: id, cardData: { cardParamMap: data } }
    const response = await this.http(`https://api.dingtalk.com/v1.0/card/instances${card.sent ? '' : '/createAndDeliver'}`, {
      method: card.sent ? 'PUT' : 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': await this.token() },
      body: JSON.stringify(card.sent ? { ...body, cardUpdateOptions: { updateCardDataByKey: true } } : {
        ...body, cardTemplateId: card.templateId, userIdType: 1,
        openSpaceId: `dtv1.card//IM_GROUP.${conversationId}`,
        imGroupOpenSpaceModel: { supportForward: false }, imGroupOpenDeliverModel: { robotCode: origin.meta.robotCode ?? this.robotCode },
      }),
    })
    if (!response.ok) throw new Error(`DingTalk card delivery failed (HTTP ${response.status}); check template and card permissions`)
    const result = await response.json() as { code?: string }
    if (result.code) throw new Error('DingTalk card delivery was rejected; check template and card permissions')
    // Intake/reply enqueue may have advanced this round while the HTTP request was in flight.
    // Preserve its newer bindings, completion state and cumulative GitHub snapshot.
    this.context.state.set(cards(id), { ...this.context.state.get(cards(id)) ?? card, sent: true })
  }

}
