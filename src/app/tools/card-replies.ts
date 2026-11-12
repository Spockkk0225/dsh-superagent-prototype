/** Shared explicit completion replies for cards, independent of ticket readiness or human-only acknowledgement gates. */
import { z } from 'zod'
import { AcknowledgementSchema, tool, type Tool } from './tool.ts'

export interface CardReplies {
  pending(ticketId?: string): { card_id: string; trigger_id: string; ticket_id?: string }[]
  reply(cardId: string, text: string, ticketId?: string): string
}

export function cardReplyTools(host: { cardReplies?: CardReplies; sendReplies(): Promise<void> }, ticketId?: string): Tool[] {
  if (!host.cardReplies) return []
  const cards = host.cardReplies
  return [tool({
    name: 'orchestrator_card_reply',
    description: 'List cards requiring a final reply, or explicitly finish one bound card with a brief factual outcome, including ignored, duplicate, no-action, failed or cancelled outcomes. Does not authorize work or certify ticket readiness. A worker may reply only to its own task cards. Never use this to bypass a rejected result/answer/attention reply or to finish a card while work continues.',
    schema: z.object({ action: z.enum(['list', 'reply']), card_id: z.string().min(1).optional(),
      text: AcknowledgementSchema.optional() }).strict(),
    execute: async args => {
      if (args.action === 'list') return { cards: cards.pending(ticketId) }
      if (!args.card_id || !args.text) throw new Error('reply requires card_id and text')
      const id = cards.reply(args.card_id, args.text, ticketId)
      await host.sendReplies()
      return { reply_id: id, queued: true }
    },
  })]
}
