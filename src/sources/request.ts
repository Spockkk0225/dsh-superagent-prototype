/** Local operator-authored requests, delivered by scripts instead of a chat platform. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { SourceKind } from './kind.ts'

export const requestKind: SourceKind = {
  kind: 'request', title: { zh: '本地请求', en: 'Local request' },
  description: { zh: '通过本地 HTTP 接口投递的任务消息', en: 'Task messages delivered through the loopback HTTP API' },
  schema: z.object({}).strict(), fields: [], health: [],
}

export function requestTrigger(prompt: string, conversationId: string): Trigger {
  const id = `request:${randomUUID()}`
  return { id, source: 'request', threads: [{ source: 'request', id }],
    actor: { source: 'request', id: 'local' }, human: true, addressed: 'mention',
    at: new Date().toISOString(), text: prompt,
    channel: { source: 'dingtalk', thread: `dingtalk:${conversationId}`,
      address: { conversationId, triggerId: id } }, meta: {} }
}
