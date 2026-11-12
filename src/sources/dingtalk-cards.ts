/** DingTalk card transport; original Source KV and Outbox retain ownership of delivery and reply routing. */
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import type { SourceContext } from './host.ts'

interface Card {
  triggerId: string; conversationId: string; templateId: string; used: boolean; sent: boolean
  ticketId?: string
  closed?: boolean
  informational?: boolean
  replyReminded?: boolean
  messages?: { id: string; text: string; flowStatus: '2' | '3' }[]
}
const cards = family<Card, [string]>('dingtalk-card:')
const deliveries = family<string, [string]>('dingtalk-card-delivery:')
const activeCards = family<string, [string]>('dingtalk-card-active:')
const triggerCards = family<string, [string]>('dingtalk-card-trigger:')
const taskCards = family<string, [string]>('dingtalk-card-task:')
export const receiptId = (triggerId: string) => key('dingtalk-received', triggerId)
const activeKey = (conversation: string, ticket: string) => activeCards(key(conversation, ticket))
const triggerKey = (conversation: string, trigger: string, ticket = '') => triggerCards(key(conversation, trigger, ticket))
const closed = (card: Card) => card.closed ?? card.messages?.at(-1)?.flowStatus === '3'

/** Explicit replies are required for current bound rounds, including no-op and ignored requests. */
export function pendingCardReplies(context: SourceContext, ticketId?: string) {
  return context.state.keys(cards).flatMap(name => {
    const card = context.state.get(name)
    if (!card || closed(card) || ticketId && card.ticketId !== ticketId) return []
    const id = name.slice(cards.prefix.length)
    // Leave historical cards from the FIFO implementation untouched.
    const bound = context.state.get(triggerKey(card.conversationId, card.triggerId, card.ticketId)) === id
      || !!card.ticketId && context.state.get(taskCards(card.ticketId)) === id
    if (!bound) return []
    return [{ card_id: id, trigger_id: card.triggerId, ticket_id: card.ticketId,
      conversation_id: card.conversationId, reply_reminded: card.replyReminded ?? false }]
  })
}

export function remindCardReply(context: SourceContext, id: string): boolean {
  const card = context.state.get(cards(id))
  if (!card || closed(card) || card.replyReminded) return false
  context.state.set(cards(id), { ...card, replyReminded: true })
  return true
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
  if (message.channel.source !== 'dingtalk' || message.channel.address.cardId) return message
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
    card.ticketId = message.ticketId
    context.state.set(activeKey(card.conversationId, message.ticketId), id)
    context.state.set(taskCards(message.ticketId), id)
    context.state.set(triggerKey(conversation, trigger, message.ticketId), id)
  }
  if (message.kind === 'reply') card.closed = true
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
    for (const ticket of targets.length ? targets : [undefined]) {
      const binding = triggerKey(conversation, trigger.id, ticket)
      if (this.context.state.get(binding)) continue
      const active = ticket ? this.context.state.get(activeKey(conversation, ticket)) : undefined
      const previous = active ? this.context.state.get(cards(active)) : undefined
      const id = previous && !closed(previous) ? active!
        : ticket ? key('dingtalk-round', conversation, ticket, trigger.id) : receiptId(trigger.id)
      this.context.state.set(binding, id)
      if (ticket) {
        this.context.state.set(activeKey(conversation, ticket), id)
        this.context.state.set(taskCards(ticket), id)
      }
      // Additional inputs in an executing round share its card and create no extra receipt.
      if (id === active) continue
      this.context.state.set(cards(id), { triggerId: trigger.id, conversationId: conversation,
        templateId: this.templateId, used: false, sent: false, closed: false,
        ...ticket ? { ticketId: ticket } : {} })
      this.context.notify({ id: ticket ? key('dingtalk-round-received', id) : receiptId(trigger.id), kind: 'notice',
        channel: { ...trigger.channel!, address: { ...trigger.channel!.address, cardId: id } },
        ...ticket ? { ticketId: ticket } : {}, text: '已收到，处理中…' })
    }
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
        flowStatus: message.kind === 'acknowledgement' && !!message.ticketId ? '2' : '3' })
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
