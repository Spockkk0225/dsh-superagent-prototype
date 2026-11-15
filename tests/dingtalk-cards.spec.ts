import { beforeEach, expect, it, vi } from 'vitest'
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream'
import { DingTalk, dingTalkTrigger } from '../src/sources/dingtalk.ts'
import { acknowledgeCard, DingTalkCards, pendingCardReplies, receiptId, replyToCard, resolveCardReply } from '../src/sources/dingtalk-cards.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { OutboundMessage, Trigger } from '../src/core/index.ts'
import { readFileSync } from 'node:fs'

let context: SourceContext, origin: Trigger, cards: DingTalkCards
let http: ReturnType<typeof vi.fn>, notify: ReturnType<typeof vi.fn>
const raw = { msgId: 'incoming', conversationId: 'group', conversationType: '2', isInAtList: true,
  senderStaffId: 'author', senderCorpId: 'corp', robotCode: 'robot', chatbotUserId: 'bot-dingtalk-id', msgtype: 'text', text: { content: '检查 PR' },
  sessionWebhook: 'https://oapi.dingtalk.com/robot/send?example', sessionWebhookExpiredTime: Date.now() + 60000 }
beforeEach(() => {
  const state = new Map(), triggers = new Map<string, Trigger>()
  notify = vi.fn()
  context = { state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => { state.set(key, value) },
    keys: (family: { prefix: string }) => [...state.keys()].filter(key => key.startsWith(family.prefix)) },
    triggers: { get: (id: string) => triggers.get(id) }, tickets: { get: (id: string) => id === 'ticket' ? { id, origin: { triggerId: origin.id } } : undefined, open: () => [] },
    receive: vi.fn((trigger: Trigger) => {
      if (triggers.has(trigger.id)) return 'duplicate'
      triggers.set(trigger.id, trigger); return 'stored'
    }), notify, atomic: (work: () => unknown) => work(),
  } as unknown as SourceContext
  origin = dingTalkTrigger(raw, context)!.trigger
  context.receive(origin)
  http = vi.fn(async () => ({ ok: true, json: async () => ({ outTrackId: 'card' }) }))
  cards = new DingTalkCards(context, 'template.schema', async () => 'access-token', http as typeof fetch)
})
const message = (overrides: Partial<OutboundMessage> = {}): OutboundMessage => ({
  id: 'ack', channel: origin.channel!, text: '正在检查', kind: 'acknowledgement', ticketId: 'ticket', ...overrides,
})
async function receipt() {
  cards.received(origin)
  const pending = notify.mock.calls.at(-1)![0] as OutboundMessage
  await cards.send(pending)
  return pending
}
const requestBody = (call: number) => JSON.parse(http.mock.calls[call]![1].body)
it.each([
  { source: 'dingtalk', eventLabel: 'GitHub Main CI', label: 'GitHub Main CI' },
  { source: 'request', eventLabel: undefined, label: 'request' },
])('identifies $label in the pending receipt', async ({ source, eventLabel, label }) => {
  origin.source = source
  if (eventLabel) origin.channel!.address.eventLabel = eventLabel
  const pending = await receipt()
  const text = `已收到 ${label} 消息。`
  expect(pending.text).toBe(text)
  expect(requestBody(0).cardData.cardParamMap).toMatchObject({ flowStatus: '2', markdown: expect.stringContaining(text) })
})
it('queues a durable AI waiting card immediately on intake without registering a private reply callback', async () => {
  const listeners = new Map<string, (frame: any) => Promise<void>>()
  const register = vi.spyOn(DWClient.prototype, 'registerCallbackListener').mockImplementation(function (this: DWClient, topic, listener) {
    listeners.set(topic, listener as any); return this
  })
  const ack = vi.spyOn(DWClient.prototype, 'socketCallBackResponse').mockImplementation(() => {})
  try {
    new DingTalk(context, { clientId: 'client', clientSecret: 'secret' }, () => {}, http as typeof fetch, 'template.schema')
    expect(listeners.size).toBe(1)
    const frame = { data: JSON.stringify({ ...raw, msgId: 'second' }), headers: { messageId: 'delivery' } }
    await listeners.get(TOPIC_ROBOT)!(frame)
    expect(notify).toHaveBeenCalledOnce()
    const pending = notify.mock.calls[0]![0] as OutboundMessage
    expect(pending.text).toBe('已收到 dingtalk 消息。')
    expect(context.triggers.get(pending.channel.address.triggerId!)).toBeDefined()
    expect(ack).toHaveBeenCalledWith('delivery', null)
    expect(http).not.toHaveBeenCalled() // No remote API or model call blocks the Stream receive ACK.
    await listeners.get(TOPIC_ROBOT)!(frame)
    expect(notify).toHaveBeenCalledOnce()
  } finally { register.mockRestore(); ack.mockRestore() }
})
it('keeps the source receipt and appends confirmation and result, retaining the spinner until the final reply', async () => {
  await receipt()
  expect(requestBody(0)).toMatchObject({ cardTemplateId: 'template.schema',
    openSpaceId: 'dtv1.card//IM_GROUP.group', cardData: { cardParamMap: {
      flowStatus: '2', status: '输出中', markdown: '已收到 dingtalk 消息。' } } })
  await cards.send(message())
  expect(http.mock.calls[1]![1].method).toBe('PUT')
  expect(requestBody(1)).toMatchObject({ outTrackId: receiptId(origin.id), cardData: { cardParamMap: {
    flowStatus: '2', status: '输出中', markdown: '#ticket\n\n已收到 dingtalk 消息。\n\n---\n\n正在检查' } } })
  await cards.send(message({ id: 'result', kind: 'reply', text: '检查完成' }))
  expect(http.mock.calls[2]![1].method).toBe('PUT')
  expect(requestBody(2).outTrackId).toBe(receiptId(origin.id))
  expect(requestBody(2).cardData.cardParamMap).toMatchObject({
    flowStatus: '3', status: '完成', markdown: '#ticket\n\n已收到 dingtalk 消息。\n\n---\n\n正在检查\n\n---\n\n检查完成' })
})
it('completes a direct answer without creating a worker or leaving the card writing', async () => {
  await receipt()
  await expect(cards.send(message({ id: 'early-answer', kind: 'reply', ticketId: undefined })))
    .rejects.toThrow('Send the initial card confirmation')
  await cards.send(message({ ticketId: undefined }))
  await cards.send(message({ id: 'answer', kind: 'reply', ticketId: undefined, text: '直接回答' }))
  expect(requestBody(2)).toMatchObject({ outTrackId: receiptId(origin.id), cardData: { cardParamMap: {
    flowStatus: '3', status: '完成', markdown: '已收到 dingtalk 消息。\n\n---\n\n正在检查\n\n---\n\n直接回答',
  } } })
})
it('retains appended feedback across transport restarts and retries without duplicates or status regression', async () => {
  await receipt()
  await cards.send(message())
  cards = new DingTalkCards(context, 'template.schema', async () => 'access-token', http as typeof fetch)
  http.mockResolvedValueOnce({ ok: false, status: 503 })
  const result = message({ id: 'result', kind: 'reply', text: '检查完成' })
  await expect(cards.send(result)).rejects.toThrow('HTTP 503')
  await cards.send(result)
  await cards.send(message())
  for (const call of [2, 3, 4]) {
    expect(requestBody(call).outTrackId).toBe(receiptId(origin.id))
    expect(requestBody(call).cardData.cardParamMap).toMatchObject({ flowStatus: '3',
      markdown: '#ticket\n\n已收到 dingtalk 消息。\n\n---\n\n正在检查\n\n---\n\n检查完成' })
  }
})
it('uses a new event card for a quoted followup and preserves the original event on task handoff', async () => {
  await receipt()
  await cards.send(message())
  const followup = { ...origin, id: 'followup', channel: { ...origin.channel!, address: { ...origin.channel!.address, triggerId: 'followup' } } }
  context.receive(followup)
  cards.received(followup)
  const pending = notify.mock.calls.at(-1)![0] as OutboundMessage
  await cards.send(pending)
  // An idle worker starts a new round; confirm the new card before its final reply.
  cards.delivery('ticket', 'followup-delivery', 'followup')
  await cards.send(message({ id: 'followup-ack', channel: followup.channel, text: '继续检查' }))
  await cards.send(message({ id: 'followup-result', kind: 'reply', channel: followup.channel, text: '追问结果' }))
  expect(requestBody(4)).toMatchObject({ outTrackId: receiptId('followup'), cardData: { cardParamMap: {
    flowStatus: '3', markdown: '#ticket\n\n已收到 dingtalk 消息。\n\n---\n\n继续检查\n\n---\n\n追问结果' } } })
  await cards.send(message({ id: 'other-ack', ticketId: 'other' }))
  await cards.send(message({ id: 'other-ticket', kind: 'reply', ticketId: 'other', text: '其他任务' }))
  expect(requestBody(6).outTrackId).not.toBe(receiptId('followup'))
  expect(requestBody(6).outTrackId).toBe(receiptId(origin.id))
})

it('reuses the acceptance confirmation on first delivery even without an intake receipt', async () => {
  // Reproduces the former fallback-send path: acknowledgement precedes any receipt binding.
  await cards.send(message())
  const binding = cards.delivery('ticket', 'assignment:ticket', origin.id)
  expect(binding).toEqual({ card_id: receiptId(origin.id), ticket_id: 'ticket', trigger_id: origin.id })
  expect(acknowledgeCard(context, binding!.card_id, 'do not duplicate', 'ticket')).toBe('ack')
  await cards.send(message({ id: 'done', kind: 'reply', text: '完成', channel: resolveCardReply(context, binding!.card_id, 'ticket').channel }))
  expect(http.mock.calls.map(call => call[1].method)).toEqual(['POST', 'PUT'])
  expect(requestBody(1).outTrackId).toBe(requestBody(0).outTrackId)
})

it('keeps one event card across deliveries, task splits, restarts and retries', async () => {
  context.triggers.targets = () => ['ticket']
  await receipt()
  await cards.send(message())
  const first = cards.delivery('ticket', 'first', origin.id)!
  const next = cards.delivery('other', 'handoff', origin.id)!
  expect(next.card_id).toBe(first.card_id)
  expect(resolveCardReply(context, next.card_id, 'other').channel.address.cardId).toBe(first.card_id)
  expect(pendingCardReplies(context, 'other')).toHaveLength(1)
  cards = new DingTalkCards(context, 'template.schema', async () => 'access-token', http as typeof fetch)
  expect(cards.delivery('other', 'handoff', origin.id)).toEqual(next)
  replyToCard(context, next.card_id, '交接后完成', 'other')
  await cards.send(notify.mock.calls.at(-1)![0])
  expect(http.mock.calls.filter(call => call[1].method === 'POST')).toHaveLength(1)
  expect(requestBody(http.mock.calls.length - 1).cardData.cardParamMap.markdown).toContain('交接后完成')
})

it('routes interleaved inputs and late reports by their input binding instead of worker history', async () => {
  const first = cards.delivery('ticket', 'first', origin.id)!
  acknowledgeCard(context, first.card_id, '处理旧消息', 'ticket')
  await cards.send(notify.mock.calls.at(-1)![0])
  const followup = { ...origin, id: 'new-event', channel: { ...origin.channel!, address: { ...origin.channel!.address, triggerId: 'new-event' } } }
  context.receive(followup)
  const second = cards.delivery('ticket', 'second', followup.id)!
  expect(second.card_id).not.toBe(first.card_id)
  acknowledgeCard(context, second.card_id, '处理新消息', 'ticket')
  await cards.send(notify.mock.calls.at(-1)![0])
  replyToCard(context, first.card_id, '旧消息结果', 'ticket')
  await cards.send(notify.mock.calls.at(-1)![0])
  expect(requestBody(2).outTrackId).toBe(first.card_id)
  expect(requestBody(2).cardData.cardParamMap.markdown).not.toContain('新消息')
  replyToCard(context, second.card_id, '新消息结果', 'ticket')
  await cards.send(notify.mock.calls.at(-1)![0])
  expect(requestBody(3).outTrackId).toBe(second.card_id)
  expect(requestBody(3).cardData.cardParamMap.markdown).not.toContain('旧消息')
  expect(cards.delivery('ticket', 'first', origin.id)).toEqual(first)
  expect(pendingCardReplies(context, 'ticket')).toHaveLength(0)
})
it('puts the task reference in the native quote summary and body without unsupported client API actions', async () => {
  await receipt()
  expect(requestBody(0).cardData.cardParamMap.markdown).toBe('已收到 dingtalk 消息。')
  await cards.send(message())
  const data = requestBody(1).cardData.cardParamMap
  expect(data.title).toBe('#ticket Super agent')
  expect(data.markdown).toBe('#ticket\n\n已收到 dingtalk 消息。\n\n---\n\n正在检查')
  expect(data.replyHint).toBe('---\n\n引用此卡片以回复消息。')
  expect(requestBody(0).callbackType).toBeUndefined()
  expect(http.mock.calls.every(call => call[0].startsWith('https://api.dingtalk.com/v1.0/card/instances'))).toBe(true)
})
it('exports a complete AI template with sibling states and nonstreaming feedback bound to the transport fields', () => {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../cards/${name}`, import.meta.url), 'utf8'))
  const schema = read('dingtalk-superagent.editor.json')
  expect(JSON.parse(read('dingtalk-superagent.json').editorData)).toEqual(schema)
  expect(schema.extension).toMatchObject({ extendType: 'AI', aiStatusList: [2, 3] })
  const root = schema.schema.componentsTree[0]
  expect(root.props.summaryContent.variable).toBe('title')
  expect(root.props.enablePending).toBe(false)
  expect(root.children.map((node: any) => node.props.status)).toEqual([2, 3])
  const writing = root.children[0].children[0]
  expect(writing.componentName).toBe('AICardContent')
  expect(writing.children[0]).toMatchObject({ componentName: 'MarkdownBlock',
    props: { isStreaming: false, content: { type: 'variableValue', variable: 'markdown' } } })
  const feedback = root.children[1].children[0].children
  expect(feedback[0]).toMatchObject({ componentName: 'MarkdownBlock', props: { isStreaming: false, content: { variable: 'markdown' } } })
  expect(writing.children.find((node: any) => node.componentName === 'AIPending').props.pendingTip)
    .toEqual({ type: 'dynamicString', content: '处理中…', i18n: false })
  expect(feedback.some((node: any) => node.componentName === 'AIPending')).toBe(false)
  const visit = (node: any) => {
    expect(node.componentName).not.toBe('SingleButton')
    if (node !== root) expect(node.children?.some((child: any) => child.componentName === 'AICardStatusContainer') ?? false).toBe(false)
    node.children?.forEach(visit)
  }
  visit(root)
})
it('uses a stable card ID on retry and never lets a delayed placeholder overwrite feedback', async () => {
  const pending = await receipt()
  http.mockResolvedValueOnce({ ok: false, status: 503 })
  await expect(cards.send(message())).rejects.toThrow('HTTP 503')
  await cards.send(message())
  expect(requestBody(1).outTrackId).toBe(requestBody(2).outTrackId)
  const before = http.mock.calls.length
  await cards.send(pending)
  expect(http).toHaveBeenCalledTimes(before)
})
