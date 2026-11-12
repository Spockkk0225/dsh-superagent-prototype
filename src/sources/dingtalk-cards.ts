/** DingTalk card transport; original Source KV and Outbox retain ownership of delivery and reply routing. */
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import type { SourceContext } from './host.ts'
import { githubChannel } from './github-trigger.ts'

interface Card {
  triggerId: string; conversationId: string; templateId: string; used: boolean; sent: boolean
  ticketId?: string
  closed?: boolean
  informational?: boolean
  replyReminded?: boolean
  acknowledgementId?: string
  awaitingWorker?: boolean
  deliveryId?: string
  githubMentions?: string[]
  githubMirrorSuppressed?: boolean
  messages?: { id: string; text: string; flowStatus: '2' | '3' }[]
}
const cards = family<Card, [string]>('dingtalk-card:')
const deliveries = family<string, [string]>('dingtalk-card-delivery:')
const activeCards = family<string, [string]>('dingtalk-card-active:')
const triggerCards = family<string, [string]>('dingtalk-card-trigger:')
const taskCards = family<string, [string]>('dingtalk-card-task:')
const workerDeliveries = family<string, [string, string]>('dingtalk-card-worker-delivery:')
export const receiptId = (triggerId: string) => key('dingtalk-received', triggerId)
const activeKey = (conversation: string, ticket: string) => activeCards(key(conversation, ticket))
const triggerKey = (conversation: string, trigger: string, ticket = '') => triggerCards(key(conversation, trigger, ticket))
const closed = (card: Card) => card.closed ?? card.messages?.at(-1)?.flowStatus === '3'
const acknowledged = (card: Card) => !!card.acknowledgementId || !!card.messages?.some(message => message.flowStatus === '2')

export function workerReplyCard(context: SourceContext, ticketId: string) {
  const id = context.state.get(taskCards(ticketId))
  return id ? { card_id: id, ticket_id: ticketId } : undefined
}

/** Resolve an explicit reply destination without changing a newer round's active binding. */
export function resolveCardReply(context: SourceContext, id: string, ticketId?: string) {
  const card = context.state.get(cards(id))
  if (!card || ticketId && card.ticketId !== ticketId) throw new Error('Card is not bound to this task')
  if (!pendingCardReplies(context, ticketId).some(pending => pending.card_id === id)) {
    throw new Error('This card has no open processing round; do not send another final reply')
  }
  return { ticket_id: card.ticketId, channel: { source: 'dingtalk', thread: `dingtalk:${card.conversationId}`,
    address: { conversationId: card.conversationId, triggerId: card.triggerId, cardId: id } } }
}

/** Confirmation identity follows a card/round, never a source trigger shared by several workers. */
export function cardAcknowledgementId(context: SourceContext, ticketId: string, trigger: Trigger): string | undefined {
  if (trigger.channel?.source !== 'dingtalk') return undefined
  const conversation = trigger.channel.address.conversationId!
  const id = trigger.channel.address.cardId ?? context.state.get(triggerKey(conversation, trigger.id, ticketId))
    ?? context.state.get(triggerKey(conversation, trigger.id))
  const card = id ? context.state.get(cards(id)) : undefined
  if (!card || card.ticketId && card.ticketId !== ticketId) return undefined
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
  return [...targets].map(([target, trigger]) => ({ ...message,
    id: key('github-mention-reply', message.id, target),
    channel: githubChannel(Number(trigger.meta.number), trigger.url),
    text: message.text.startsWith(prefix) ? message.text : `${prefix}\n\n${message.text}`,
  }))
}

/** Explicit replies are required for current bound rounds, including no-op and ignored requests. */
export function pendingCardReplies(context: SourceContext, ticketId?: string) {
  return context.state.keys(cards).flatMap(name => {
    const card = context.state.get(name)
    if (!card || closed(card) || ticketId && card.ticketId !== ticketId) return []
    const id = name.slice(cards.prefix.length)
    // Leave historical cards from the FIFO implementation untouched.
    const bound = context.state.get(triggerKey(card.conversationId, card.triggerId, card.ticketId)) === id
      || !!card.ticketId && context.state.get(taskCards(card.ticketId)) === id
      || !!card.ticketId && !!card.deliveryId && context.state.get(workerDeliveries(card.ticketId, card.deliveryId)) === id
    if (!bound) return []
    return [{ card_id: id, trigger_id: card.triggerId, ticket_id: card.ticketId,
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
    if (!card || ticketId && card.ticketId !== ticketId) throw new Error('Card is not bound to this session')
    if (card.acknowledgementId) return card.acknowledgementId
    const previous = card.messages?.find(message => message.flowStatus === '2')
    if (previous) return previous.id
    if (!pendingCardReplies(context, ticketId).some(pending => pending.card_id === id)) {
      throw new Error('Card has no open delivery binding')
    }
    const replyId = key('dingtalk-card-ack', id)
    context.state.set(cards(id), { ...card, acknowledgementId: replyId })
    context.notify({ id: replyId, kind: 'acknowledgement', ...card.ticketId ? { ticketId: card.ticketId } : {}, text,
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
    if (!card || ticketId && card.ticketId !== ticketId) throw new Error('Card is not bound to this session')
    if (closed(card)) throw new Error('This card already has a final reply queued; do not send another')
    if (!pendingCardReplies(context, ticketId).some(pending => pending.card_id === id)) {
      throw new Error('Card has no current delivery binding')
    }
    if (!acknowledged(card)) throw new Error('Send the initial card confirmation with action=acknowledge before the final reply')
    const replyId = key('dingtalk-card-final', id)
    context.state.set(cards(id), { ...card, closed: true })
    context.notify({ id: replyId, kind: 'reply', ...card.ticketId ? { ticketId: card.ticketId } : {}, text,
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
    if (!card || card.ticketId && message.ticketId && card.ticketId !== message.ticketId) throw new Error('Card is not bound to this reply')
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
    ?? (message.ticketId ? context.tickets.get(message.ticketId)?.origin.triggerId : undefined)
  if (!trigger) return message
  const explicit = context.state.get(triggerKey(conversation, trigger, message.ticketId))
  const current = message.ticketId ? context.state.get(taskCards(message.ticketId))
    ?? context.state.get(activeKey(conversation, message.ticketId)) : undefined
  const currentCard = current ? context.state.get(cards(current)) : undefined
  const provisional = context.state.get(triggerKey(conversation, trigger))
  const provisionalCard = provisional ? context.state.get(cards(provisional)) : undefined
  // Text-only transports and messages predating card intake have no card binding to prepare.
  if (!explicit && !current && !provisional) return message
  // A final result often names the original request, while this round was started by a later follow-up.
  const id = message.kind === 'reply' && current ? current : explicit
    ?? (currentCard && !closed(currentCard) && currentCard.conversationId === conversation ? current : undefined)
    ?? (provisionalCard && (!provisionalCard.ticketId || provisionalCard.ticketId === message.ticketId) ? provisional : undefined)
    ?? key('dingtalk-feedback', message.id)
  const card = context.state.get(cards(id)) ?? { triggerId: trigger, conversationId: conversation,
    templateId: '', used: false, sent: false }
  if (message.ticketId) {
    if (!card.ticketId) card.awaitingWorker = true
    card.ticketId = message.ticketId
    context.state.set(activeKey(card.conversationId, message.ticketId), id)
    context.state.set(taskCards(message.ticketId), id)
    context.state.set(triggerKey(conversation, trigger, message.ticketId), id)
  }
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
    const targets = this.context.triggers.targets?.(trigger.id) ?? []
    // Worker cards are allocated at actual delivery, when its busy/idle state is known.
    if (targets.length) return
    const binding = triggerKey(conversation, trigger.id)
    if (this.context.state.get(binding)) return
    const id = receiptId(trigger.id)
    this.context.state.set(binding, id)
    this.context.state.set(cards(id), { triggerId: trigger.id, conversationId: conversation,
      templateId: this.templateId, used: false, sent: false, closed: false,
      ...trigger.source === 'github' && trigger.human && trigger.addressed ? { githubMentions: [trigger.id] } : {} })
    this.context.notify({ id, kind: 'notice',
      channel: { ...trigger.channel!, address: { ...trigger.channel!.address, cardId: id } }, text: '已收到，处理中…' })
  }

  /** Called synchronously immediately before a worker message is submitted; every delivery has an immutable card binding. */
  delivery(ticketId: string, deliveryId: string, triggerId: string, busy: boolean) {
    return this.context.atomic(() => {
      const saved = this.context.state.get(workerDeliveries(ticketId, deliveryId))
      if (saved) return { card_id: saved, ticket_id: ticketId }
      const trigger = this.context.triggers.get(triggerId)
      if (trigger?.channel?.source !== 'dingtalk') return undefined
      const conversation = trigger.channel.address.conversationId!
      const active = this.context.state.get(activeKey(conversation, ticketId))
      const current = active ? this.context.state.get(cards(active)) : undefined
      const provisional = this.context.state.get(triggerKey(conversation, triggerId))
      const waiting = provisional ? this.context.state.get(cards(provisional)) : undefined
      const adopt = waiting && !closed(waiting) && (!waiting.ticketId || waiting.ticketId === ticketId && waiting.awaitingWorker)
      const id = busy && current && !closed(current) ? active!
        : adopt ? provisional! : key('dingtalk-worker-round', conversation, ticketId, deliveryId)
      const existing = this.context.state.get(cards(id))
      const card: Card = existing ?? { triggerId, conversationId: conversation, templateId: this.templateId,
        used: false, sent: false, closed: false }
      card.ticketId = ticketId
      card.awaitingWorker = false
      card.deliveryId ??= deliveryId
      if (trigger.source === 'github' && trigger.human && trigger.addressed) {
        card.githubMentions = [...new Set([...card.githubMentions ?? [], triggerId])]
      } else if (trigger.source !== 'github' && existing) card.githubMirrorSuppressed = true
      this.context.state.set(cards(id), card)
      this.context.state.set(workerDeliveries(ticketId, deliveryId), id)
      this.context.state.set(triggerKey(conversation, triggerId, ticketId), id)
      this.context.state.set(activeKey(conversation, ticketId), id)
      this.context.state.set(taskCards(ticketId), id)
      if (!existing) this.context.notify({ id: key('dingtalk-round-received', id), kind: 'notice', ticketId,
        channel: { ...trigger.channel, address: { ...trigger.channel.address, cardId: id } }, text: '已收到，处理中…' })
      return { card_id: id, ticket_id: ticketId }
    })
  }

  async send(message: OutboundMessage): Promise<void> {
    message = bindDingTalkReply(this.context, message)
    const conversationId = message.channel.address.conversationId!
    const triggerId = message.channel.address.triggerId
      ?? (message.ticketId ? this.context.tickets.get(message.ticketId)?.origin.triggerId : undefined)
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
    if (message.ticketId) card.ticketId = message.ticketId
    if (!placeholder) {
      card.used = true
      card.messages ??= []
      if (!card.messages.some(item => item.id === message.id)) card.messages.push({ id: message.id, text: message.text,
        flowStatus: message.kind === 'acknowledgement' ? '2' : '3' })
    }
    this.context.state.set(cards(id), card)
    const taskLabel = card.ticketId ? `#${card.ticketId.slice(0, 12)}` : ''
    const eventLabel = this.context.triggers.get(card.triggerId)?.channel?.address.eventLabel
    const heading = [taskLabel, eventLabel].filter(Boolean).join(' · ')
    const flowStatus = placeholder ? card.informational ? '3' : '1' : card.messages!.at(-1)!.flowStatus
    const text = placeholder ? message.text : card.messages!.map(item => item.text).join('\n\n---\n\n')
    const data = { title: [heading, this.robotName].filter(Boolean).join(' '),
      status: flowStatus === '1' ? '处理中' : flowStatus === '2' ? '输出中' : '完成',
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
    card.sent = true; this.context.state.set(cards(id), card)
  }

}
