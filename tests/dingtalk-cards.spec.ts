import { beforeEach, expect, it, vi, type Mock } from 'vitest'
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream'
import { DingTalk, dingTalkKind, dingTalkRoute, dingTalkTrigger } from '../src/sources/dingtalk.ts'
import { DingTalkCards, receiptId } from '../src/sources/dingtalk.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { OutboundMessage, Trigger } from '../src/core/index.ts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Projects } from '../src/app/projects.ts'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { ProjectPlanning } from '../src/app/project-planning.ts'
import { dingTalkProjectIntake, dingTalkProjects } from '../src/sources/dingtalk.ts'

let context: SourceContext, origin: Trigger, cards: DingTalkCards
let http: ReturnType<typeof vi.fn>, notify: Mock<(message: OutboundMessage) => void>
const raw = { msgId: 'incoming', conversationId: 'group', conversationType: '2', isInAtList: true,
  senderStaffId: 'author', senderCorpId: 'corp', robotCode: 'robot', chatbotUserId: 'bot-dingtalk-id', msgtype: 'text', text: { content: '检查 PR' },
  sessionWebhook: 'https://oapi.dingtalk.com/robot/send?example', sessionWebhookExpiredTime: Date.now() + 60000 }
beforeEach(() => {
  const state = new Map(), triggers = new Map<string, Trigger>()
  notify = vi.fn()
  context = { state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => { state.set(key, value) } },
    triggers: { get: (id: string) => triggers.get(id) }, tickets: { get: (id: string) => id === 'ticket' ? { id, origin: { triggerId: origin.id } } : undefined, open: () => [] },
    receive: vi.fn((trigger: Trigger) => {
      if (triggers.has(trigger.id)) return 'duplicate'
      triggers.set(trigger.id, trigger)
      return trigger.meta.projectEnrollment || trigger.meta.projectMeeting || trigger.meta.projectDiscussion ? 'filtered' : 'stored'
    }), config: () => ({}), notify, atomic: (work: () => unknown) => work(),
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
it('delivers an unthreaded project notice to the group when cards are enabled', async () => {
  const request = vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith('/accessToken') ? { accessToken: 'token' } : { processQueryKey: 'sent' },
  )))
  const bot = new DingTalk(context, { clientId: 'client', clientSecret: 'secret' }, () => {}, request as typeof fetch, 'template.schema')
  await bot.send({ id: 'review', kind: 'notice', text: '任务待验收',
    channel: { source: 'dingtalk', thread: 'dingtalk:group', address: { conversationId: 'group' } },
  })
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    'https://api.dingtalk.com/v1.0/oauth2/accessToken',
    'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
  ])
})
it.each([true, false])('mentions the reviewer through a group route with a live webhook: %s', async active => {
  const route = dingTalkTrigger(raw, context)!.route
  context.state.set(dingTalkRoute(route.conversationId), { ...route, expires: active ? Date.now() + 60_000 : 0 })
  const request = vi.fn(async (url: string | URL, _options: RequestInit) => new Response(JSON.stringify(
    String(url).endsWith('/accessToken') ? { accessToken: 'token' } : active ? { errcode: 0 } : { processQueryKey: 'sent' },
  )))
  const bot = new DingTalk(context, { clientId: 'client', clientSecret: 'secret' }, () => {}, request as typeof fetch, 'template.schema')
  await bot.send({ id: 'review', kind: 'notice', text: '任务待验收',
    channel: { source: 'dingtalk', thread: 'dingtalk:group', address: { conversationId: 'group', mentionUserId: 'reviewer' } },
  })
  const [url, options] = request.mock.calls[1]!
  expect(String(url)).toBe(active ? route.webhook : 'https://api.dingtalk.com/v1.0/robot/groupMessages/send')
  const body = JSON.parse(String(options.body))
  if (active) expect(body).toEqual({ msgtype: 'text', text: { content: '@reviewer 任务待验收' }, at: { atUserIds: ['reviewer'] } })
  else expect(body).toMatchObject({ openConversationId: 'group', atUserIds: ['reviewer'], msgParam: JSON.stringify({ content: '@reviewer 任务待验收' }) })
})
it.each([true, false])('sends actual Markdown through both DingTalk transports while retaining mention metadata: %s', async active => {
  const route = dingTalkTrigger(raw, context)!.route
  context.state.set(dingTalkRoute(route.conversationId), { ...route, expires: active ? Date.now() + 60_000 : 0 })
  const request = vi.fn(async (_url: unknown, _options?: RequestInit) => Response.json(
    _options?.body?.toString().includes('appSecret') ? { accessToken: 'token', expireIn: 7200 } : active ? { errcode: 0 } : { processQueryKey: 'sent' }
  ))
  const bot = new DingTalk(context, { clientId: 'client', clientSecret: 'secret' }, () => {}, request as typeof fetch)
  await bot.send({ id: 'markdown', kind: 'notice', format: 'markdown', title: '执行受阻', text: '**需要处理**：核对环境',
    channel: { source: 'dingtalk', thread: 'dingtalk:group', address: { conversationId: 'group', mentionUserId: 'reviewer' } } })
  const body = JSON.parse(String(request.mock.calls[1]![1]!.body))
  if (active) expect(body).toEqual({ msgtype: 'markdown', markdown: { title: '执行受阻', text: '@reviewer **需要处理**：核对环境' }, at: { atUserIds: ['reviewer'] } })
  else expect(body).toMatchObject({ msgKey: 'sampleMarkdown', atUserIds: ['reviewer'], msgParam: JSON.stringify({ title: '执行受阻', text: '@reviewer **需要处理**：核对环境' }) })
  expect(dingTalkKind(async () => {}).channel!.deliveryInfo?.(context, { source: 'dingtalk', thread: 'dingtalk:group', address: { conversationId: 'group' } }))
    .toMatchObject({ format: 'markdown', transport: active ? 'session-webhook' : 'application-group-api', messageType: active ? 'markdown' : 'sampleMarkdown' })
})
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
it('plans directly from a member’s minutes and resumes from a clarification through the durable intake', async () => {
  let receive: ((frame: { data: string; headers: { messageId: string } }) => Promise<void>) | undefined
  const register = vi.spyOn(DWClient.prototype, 'registerCallbackListener').mockImplementation(function (this: DWClient, _topic, listener) {
    receive = listener as typeof receive; return this
  })
  const ack = vi.spyOn(DWClient.prototype, 'socketCallBackResponse').mockImplementation(() => {})
  const directory = mkdtempSync(join(tmpdir(), 'dingtalk-project-enrollment-'))
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const projects = new Projects(store)
  const effects = new Effects(store, new HealthBoard())
  const propose = vi.fn()
  const planning = new ProjectPlanning(store, effects, { name: 'Test planner', propose }, message => { notify(message) },
    new AbortController().signal)
  try {
    const { id } = projects.create({ name: 'Pilot', objective: '', description: '', status: 'planning' })
    new DingTalk(context, { clientId: 'client', clientSecret: 'secret' }, () => {}, http as typeof fetch, undefined, undefined,
      dingTalkProjects('group', id, projects, planning))
    const message = { ...raw, msgId: 'onboarding', senderNick: '林同学' }
    const deliver = (data: typeof message) => receive!({ data: JSON.stringify(data), headers: { messageId: data.msgId } })
    await deliver({ ...message, conversationId: 'another-group' })
    expect(projects.detail(id).members).toEqual([])
    await deliver(message)
    await deliver(message)
    await deliver({ ...message, msgId: 'second-mention' })
    expect(projects.detail(id).members).toEqual([expect.objectContaining({ name: '林同学',
      accounts: [{ provider: 'dingtalk', scope: 'corp', accountId: 'author' }] })])
    expect(projects.detail(id).revision).toBe(1)
    const enrollment = { ...message, msgId: 'enrollment-command', text: { content: '登记项目成员' } }
    await deliver(enrollment)
    await deliver(enrollment)
    expect(notify).toHaveBeenCalledTimes(3)
    expect(notify.mock.calls[0]![0]).toMatchObject({ kind: 'notice', text: '已收到这条请求，正在判断如何处理。' })
    expect(notify.mock.calls[2]![0]).toMatchObject({ kind: 'notice', text: '你已是「Pilot」的项目成员。' })
    const meeting = { ...message, msgId: 'meeting', text: { content: '项目会议纪要\nAgent 实现原型，交付试玩链接，由林同学验收。通过后需要整理测试用例，待确认谁来执行。' } }
    await deliver({ ...meeting, msgId: 'unauthorized-meeting', senderStaffId: 'unknown' })
    expect(effects.pending('project-plan')).toBe(false)
    expect(projects.detail(id).decisions).toEqual([])
    const reviewer = projects.detail(id).members[0]!.id
    const question = '测试用例由谁执行？'
    propose.mockImplementationOnce(async (prompt: string) => {
      expect(prompt).toContain('交付试玩链接')
      return { objective: '', question, tasks: [{ ref: 'new:prototype', title: '实现原型', description: '交付可玩的原型',
        acceptance: '给出试玩链接', assignee: 'agent', memberId: reviewer, dependsOn: null, cancel: false }] }
    })
    await deliver(meeting)
    await deliver(meeting)
    expect(projects.detail(id)).toMatchObject({ tasks: [], tickets: [], decisions: [{ context: meeting.text.content, answeredAt: null }] })
    expect(notify).toHaveBeenCalledTimes(5)
    expect(notify.mock.lastCall?.[0]).toMatchObject({ kind: 'notice', text: '已收到「Pilot」会议纪要，正在把已确认的行动整理到看板。' })
    expect(effects.pending('project-plan')).toBe(true)
    expect(propose).not.toHaveBeenCalled()
    effects.start()
    await effects.idle('project-plan')
    expect(propose).toHaveBeenCalledOnce()
    expect(notify.mock.lastCall?.[0]).toMatchObject({ kind: 'notice', text: expect.stringContaining('新增 实现原型') })
    expect(notify.mock.lastCall?.[0].text).toContain(question)
    const before = projects.detail(id)
    expect(before).toMatchObject({ status: 'planning', tasks: [{ title: '实现原型', ownerId: reviewer, executionMode: 'agent', ticketId: null }], tickets: [] })
    const prototype = before.tasks[0]!

    const reply = { ...message, msgId: 'review-reply', text: { content: '会议反馈：测试用例由 Agent 执行，由林同学验收，至少包含失败场景。' } }
    await deliver({ ...reply, msgId: 'unauthorized-reply', senderStaffId: 'unknown' })
    expect(projects.meetingStatus(id).meeting?.meetingReplies).toEqual([])
    expect(propose).toHaveBeenCalledOnce()
    propose.mockImplementationOnce(async (prompt: string) => {
      expect(prompt).toContain(question)
      expect(prompt).toContain('至少包含失败场景')
      expect(prompt).toContain(prototype.id)
      return { objective: '', question: '', tasks: [{ ref: 'new:cases', title: '整理测试用例', description: '提交用例列表',
        acceptance: '至少包含失败场景', assignee: 'agent', memberId: reviewer, dependsOn: [prototype.id], cancel: false }] }
    })
    await deliver(reply)
    await deliver(reply)
    await effects.idle('project-plan')
    expect(propose).toHaveBeenCalledTimes(2)
    expect(projects.meetingStatus(id).meeting?.meetingReplies).toEqual([expect.objectContaining({ name: '林同学', text: '测试用例由 Agent 执行，由林同学验收，至少包含失败场景。' })])
    expect(notify.mock.lastCall?.[0]).toMatchObject({ kind: 'notice', text: expect.stringContaining('新增 整理测试用例') })
    expect(notify.mock.lastCall?.[0].text).not.toContain(question)
    expect(projects.detail(id)).toMatchObject({ status: 'planning', tasks: [prototype, { title: '整理测试用例',
      executionMode: 'agent', ownerId: reviewer, blockedBy: [prototype.id], status: 'todo', ticketId: null }], tickets: [] })

    await deliver({ ...reply, msgId: 'additional-feedback' })
    await effects.idle('project-plan')
    expect(propose).toHaveBeenCalledTimes(2)
  } finally { await effects.drain(); store.close(); rmSync(directory, { recursive: true, force: true }); register.mockRestore(); ack.mockRestore() }
})
it.each([
  { line: '', repository: null },
  { line: '\nGitHub 仓库：https://github.com/Example/Existing', repository: 'example/existing' },
])('opens a project from its first meeting with optional repository $repository', async ({ line, repository }) => {
  const directory = mkdtempSync(join(tmpdir(), 'project-first-minutes-'))
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const projects = new Projects(store)
  const effects = new Effects(store, new HealthBoard())
  const author = projects.registerDingTalkSender('corp', 'author', '提交人').member
  const reviewer = projects.registerDingTalkSender('corp', 'reviewer', '验收人').member
  projects.registerDingTalkSender('corp', 'other', '未参与')
  const propose = vi.fn(async (prompt: string) => {
    expect(prompt).toContain(reviewer.id)
    return { objective: '提交首版边界', question: '', tasks: [{ ref: 'new:scope', title: '整理首版边界', description: '提交清单',
      acceptance: '列出本期范围', assignee: 'agent', memberId: reviewer.id, dependsOn: null, cancel: false }] }
  })
  const planning = new ProjectPlanning(store, effects, { name: 'Test planner', propose }, notify, new AbortController().signal)
  const intake = dingTalkProjectIntake(projects, planning, 'group')
  const trigger = (id: string, text: string, senderStaffId = 'author') => dingTalkTrigger({ ...raw, msgId: id, senderStaffId,
    text: { content: text } }, context)!.trigger
  try {
    expect(intake.forConversation!('other-group')).toBeUndefined()
    const first = intake.forConversation!('group')!
    const minutes = trigger('first', `项目会议纪要\n项目名称：样例项目${line}\nAgent 提交范围清单，由验收人验收。`)
    first.onMeeting!(trigger('missing', '项目会议纪要\n还在讨论方向'))
    first.onMeeting!(trigger('unknown', minutes.text, 'unknown'))
    expect(projects.list()).toEqual([])
    expect(first.onMeeting!(minutes)).toContain('当前待开工')
    expect(projects.list()).toHaveLength(1)
    intake.forConversation!('group')!.onMeeting!(minutes)
    expect(projects.list()).toHaveLength(1)
    effects.start()
    await effects.idle('project-plan')
    expect(propose).toHaveBeenCalledOnce()
    const [project] = projects.list()
    const detail = projects.detail(project!.id)
    expect(detail).toMatchObject({ name: '样例项目', repository, status: 'planning', autoAdvance: false,
      dingTalkGroup: 'group', tickets: [], decisions: [{ initialMeeting: true }],
      tasks: [{ title: '整理首版边界', executionMode: 'agent', ownerId: reviewer.id, ticketId: null, issueUrl: null }] })
    expect(new Set(detail.memberIds)).toEqual(new Set([author.id, reviewer.id]))
  } finally { await effects.drain(); store.close(); rmSync(directory, { recursive: true, force: true }) }
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
it('uses a new card for a quoted followup and keeps unrelated tickets separate', async () => {
  await receipt()
  await cards.send(message())
  const followup = { ...origin, id: 'followup', channel: { ...origin.channel!, address: { ...origin.channel!.address, triggerId: 'followup' } } }
  context.receive(followup)
  cards.received(followup)
  const pending = notify.mock.calls.at(-1)![0] as OutboundMessage
  await cards.send(pending)
  // An idle worker starts a new round; confirm the new card before its final reply.
  cards.delivery('ticket', 'followup-delivery', 'followup', false)
  await cards.send(message({ id: 'followup-ack', channel: followup.channel, text: '继续检查' }))
  await cards.send(message({ id: 'followup-result', kind: 'reply', channel: followup.channel, text: '追问结果' }))
  expect(requestBody(4)).toMatchObject({ outTrackId: receiptId('followup'), cardData: { cardParamMap: {
    flowStatus: '3', markdown: '#ticket\n\n已收到 dingtalk 消息。\n\n---\n\n继续检查\n\n---\n\n追问结果' } } })
  await cards.send(message({ id: 'other-ack', ticketId: 'other' }))
  await cards.send(message({ id: 'other-ticket', kind: 'reply', ticketId: 'other', text: '其他任务' }))
  expect(requestBody(6).outTrackId).not.toBe(receiptId('followup'))
  expect(requestBody(6).outTrackId).not.toBe(receiptId(origin.id))
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
