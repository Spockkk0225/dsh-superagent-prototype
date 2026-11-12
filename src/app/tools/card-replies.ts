/** Shared explicit completion replies for cards, independent of ticket readiness or human-only acknowledgement gates. */
import { z } from 'zod'
import { AcknowledgementSchema, tool, type Tool } from './tool.ts'
import type { ChannelRef } from '../../core/index.ts'

export interface CardReplies {
  pending(ticketId?: string): { card_id: string; trigger_id: string; ticket_id?: string }[]
  acknowledge(cardId: string, text: string, ticketId?: string): string
  reply(cardId: string, text: string, ticketId?: string): string
  resolve(cardId: string, ticketId?: string): { ticket_id?: string; channel: ChannelRef }
}

export function cardReplyTools(host: { cardReplies?: CardReplies; sendReplies(): Promise<void> }, ticketId?: string): Tool[] {
  if (!host.cardReplies) return []
  const cards = host.cardReplies
  return [tool({
    name: 'orchestrator_card_reply',
    description: 'List pending cards, send an initial agent confirmation (acknowledge) for any bound card including system events, or explicitly finish it (reply) with a factual terminal outcome. Every card needs both an initial confirmation and a final reply; the automatic receipt is not the confirmation. Does not authorize work or certify ticket readiness. A worker may access only its task cards. Never bypass result/answer/attention permissions or finish a card while work continues.',
    schema: z.object({ action: z.enum(['list', 'acknowledge', 'reply']), card_id: z.string().min(1).optional(),
      text: AcknowledgementSchema.optional() }).strict(),
    execute: async args => {
      if (args.action === 'list') return { cards: cards.pending(ticketId) }
      if (!args.card_id || !args.text) throw new Error('acknowledge/reply requires card_id and text')
      const id = args.action === 'acknowledge' ? cards.acknowledge(args.card_id, args.text, ticketId)
        : cards.reply(args.card_id, args.text, ticketId)
      await host.sendReplies()
      return { reply_id: id, queued: true }
    },
  })]
}
