/** Reliable outbound message delivery backed by persistent receipts and retried reply effects. */
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.ts'
import type { Store } from './store.ts'

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'send'>
  readonly commands: Commands
  paused(): boolean
  /** Fix transport correlations before delivery can race with another incoming event. */
  prepare?(message: OutboundMessage): OutboundMessage
  /** Additional destinations for the same explicit reply, persisted atomically with independent retry receipts. */
  mirrors?(message: OutboundMessage): OutboundMessage[]
  acknowledgementId?(ticketId: string, trigger: Trigger): string | undefined
}

/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and `SourceRegistry`.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * Messages wait while processing is paused or their source is unavailable, and settle as dropped when the target conversation is ignored or gone.
 */
export class Outbox implements OutboxPort {
  constructor(private readonly host: OutboxHost) {
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] })
  }
  /** Record a message receipt and enqueue its delivery effect atomically; duplicate message IDs are ignored. */
  send(message: OutboundMessage): void {
    // Validate IM reply length here; acknowledgements are already validated when decided.
    if (message.kind === 'reply' && message.channel.source === 'feishu') checkedImText(message.text)
    const { store, effects } = this.host
    store.atomic(() => {
      if (store.receipts.get(message.id)) return
      let prepared = this.host.prepare?.(message) ?? message
      const mirrors = this.host.mirrors?.(prepared) ?? []
      if (mirrors.length) prepared = { ...prepared, channel: { ...prepared.channel,
        address: { ...prepared.channel.address, mirrorIds: JSON.stringify(mirrors.map(item => item.id)) } } }
      for (const outgoing of [prepared, ...mirrors]) {
        if (store.receipts.add(outgoing)) effects.enqueue('reply', outgoing.id, {})
      }
    })
  }
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  acknowledgementId(ticketId: string, trigger: Trigger): string | undefined { return this.host.acknowledgementId?.(ticketId, trigger) }
  withdraw(id: string): void {
    const { store, effects } = this.host
    store.atomic(() => {
      const saved = store.receipts.get(id)
      const mirrors = saved?.channel.address.mirrorIds
      const ids: string[] = [id, ...mirrors ? JSON.parse(mirrors) as string[] : []]
      for (const outgoing of ids) if (store.receipts.withdraw(outgoing)) effects.cancel('reply', outgoing)
    })
  }
  sent(): Promise<void> { return this.host.effects.idle('reply') }
  private async deliver(id: string): Promise<void> {
    const { store, sources, commands } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off or not installed')
    // Hold later messages for the same ticket and conversation behind an earlier pending message until it exceeds the failure threshold.
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message of this ticket to this conversation waits')
    if (!sources.channelAllowed(receipt.channel)) { store.receipts.settle(receipt, 'channelIgnored'); return }
    // A permanently unreachable target (such as a recalled message or deleted Issue) settles as `channelGone` so its receipt prevents retries.
    const result = await sources.send(receipt, commands)
    if (result === 'waiting') throw new Later('The Source is not installed')
    store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent')
  }
}
