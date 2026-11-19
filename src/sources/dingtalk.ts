/** dingtalk data source: configuration, normalization, context, transport and lifecycle. */
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import { type SourceContext } from './host.ts'
import { type ProjectPlanning } from '../app/project-planning.ts'
import { type ProjectAgent } from '../app/project-agent.ts'
import type { Projects } from '../app/projects.ts'
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream'
import { z } from 'zod'
import { type SourceKind } from './kind.ts'
import { projectMessageReceived } from './project-message.ts'
import { DingTalkCards } from './dingtalk-cards.ts'

// dingtalk-projects: provider implementation
function sender(trigger: Trigger) {
  const corpId = trigger.meta.senderCorpId
  const name = typeof trigger.meta.senderNick === 'string' ? trigger.meta.senderNick : `钉钉成员 ${trigger.actor.id.slice(-6)}`
  return { corpId: typeof corpId === 'string' && corpId.length <= 128 && trigger.actor.id.length <= 128 ? corpId : undefined, name }
}
/** Only a designated intake group may open a project before it has a saved binding. */
export function dingTalkProjectIntake(projects: Projects, planning?: ProjectPlanning, intakeGroup?: string, agent?: ProjectAgent): DingTalkIntake {
  return { conversationId: intakeGroup, forConversation: group => {
    if (!planning) return
    const project = projects.forDingTalkGroup(group)
    if (project) return { ...dingTalkProjects(group, project.id, projects, planning, agent), project }
    if (group !== intakeGroup) return
    return {
      discussion: () => () => '这个群还没有项目。团队讨论确认后，可以提交首次项目纪要。',
      onSender: (trigger: Trigger) => {
        const { corpId, name } = sender(trigger)
        if (!corpId) return
        const { added } = projects.registerDingTalkSender(corpId, trigger.actor.id, name)
        return added ? '已登记你的成员账号。团队讨论后可以提交首次项目纪要。' : '你的成员账号已登记。'
      },
      onMeeting: (trigger: Trigger) => {
        if (trigger.text.length > 26_000) return '会议纪要超过 26,000 字，请缩短后重发。'
        const { corpId, name } = sender(trigger)
        const member = corpId && projects.directoryMemberForAccount('dingtalk', corpId, trigger.actor.id)
        if (!member) return '请先 @ 我发「登记项目成员」，再提交会议纪要。'
        const names = [...trigger.text.matchAll(/^项目名称[：:][ \t]*(.*)$/gm)]
        const projectName = names[0]?.[1]?.trim()
        if (names.length !== 1 || !projectName || projectName.length > 200) return '团队确认项目名称后，请在纪要里保留一行「项目名称：…」。'
        const repositories = [...trigger.text.matchAll(/^GitHub 仓库[：:][ \t]*(.*)$/gim)]
        const raw = repositories[0]?.[1]?.trim()
        if (repositories.length > 1) return '如果会议已确定 GitHub 仓库，请在同一行填写一个 owner/repo 或 GitHub 仓库链接。'
        try { planning.submitFirstMinutes({ name: projectName, repository: raw && raw !== '无' ? raw : null, dingTalkGroup: group }, {
          ...meetingEvidence(trigger, name, member.id), text: trigger.text, channel: trigger.channel,
          clarificationHint: '补充时请 @ 我发「会议反馈：…」。',
        }) } catch (error) {
          if (error instanceof z.ZodError) return '如果会议已确定 GitHub 仓库，请在同一行填写一个 owner/repo 或 GitHub 仓库链接。'
          throw error
        }
        return `已建立「${projectName}」，当前待开工。正在整理本次会议的分工。`
      },
    }
  } }
}
function meetingEvidence(trigger: Trigger, name: string, memberId?: string) {
  return { triggerId: trigger.id, source: trigger.source, name, at: trigger.at, memberId,
    messageId: typeof trigger.meta.messageId === 'string' ? trigger.meta.messageId : undefined }
}
export function dingTalkProjects(conversationId: string, projectId: string, projects: Projects, planning: ProjectPlanning, agent?: ProjectAgent): DingTalkIntake {
  const enrollFirst = '请先在项目群里 @ 我发送「登记项目成员」。'
  const evidence = (trigger: Trigger) => {
    const { corpId, name } = sender(trigger)
    const member = corpId ? projects.memberForAccount(projectId, 'dingtalk', corpId, trigger.actor.id) : undefined
    return meetingEvidence(trigger, name, member?.id)
  }
  const meetingMessage = (trigger: Trigger, text = trigger.text) => ({ ...evidence(trigger), projectId, text,
    channel: trigger.channel, clarificationHint: '补充时请 @ 我发「会议反馈：…」。' })
  const manage = (trigger: Trigger) => {
    const { memberId } = evidence(trigger)
    if (!memberId) return enrollFirst
    if (!trigger.channel || !agent) return '项目消息通道尚未就绪。'
    const result = agent.submit({ projectId, actorId: memberId, messageId: trigger.id, channel: trigger.channel,
      text: trigger.text, quoted: typeof trigger.meta.replyToBotText === 'string' ? trigger.meta.replyToBotText : '' })
    return result.status === 'disabled' ? '项目消息处理已关闭，可在事件配置中开启。' : '已收到，正在结合项目现状处理。'
  }
  return {
    conversationId,
    onSender: trigger => {
      const { corpId, name } = sender(trigger)
      if (!corpId) return
      const { projectName, added } = projects.addDingTalkSender(projectId, corpId, trigger.actor.id, name)
      return added ? `已加入「${projectName}」项目。` : `你已是「${projectName}」的项目成员。`
    },
    onMeeting: trigger => {
      if (agent) return manage(trigger)
      if (trigger.text.length > 26_000) return '会议纪要超过 26,000 字，请缩短后重发。'
      const meeting = planning.submitMinutes(meetingMessage(trigger))
      return meeting ? `已收到「${meeting.name}」会议纪要，正在把已确认的行动整理到看板。` : enrollFirst
    },
    discussion: trigger => {
      if (agent) return () => manage(trigger)
      const { name, status, meeting } = projects.meetingStatus(projectId)
      const explicit = /^会议反馈[：:]/u.test(trigger.text)
      const quote = typeof trigger.meta.replyToMessageId === 'string' && projects.detail(projectId).decisions
        .find(item => item.meetingSource?.messageId === trigger.meta.replyToMessageId)
      if (!meeting || !(explicit || quote || status === 'planning')) return
      return () => {
        const text = trigger.text.replace(/^会议反馈[：:]\s*/u, '').trim()
        if (!text) return '请在「会议反馈」后附上具体意见。'
        const result = planning.recordFeedback(meetingMessage(trigger, text.slice(0, 8000)), (quote || meeting).id, explicit || !!quote)
        if (result === 'membership-required') return enrollFirst
        if (result === 'queued') return `已收到补充，正在继续整理「${name}」的行动项。`
        return `已记入「${name}」的会议讨论。`
      }
    },
  }
}

// dingtalk: provider implementation
export const dingTalkRoute = family<Route, [string]>('dingtalk-route:')
const tickets = family<string, [string, string]>('dingtalk-ticket:')
const bodies = family<{ messageType: string; content: unknown }, [string]>('dingtalk-body:')
const deliveries = family<{ messageId: string; format: string; transport: string; messageType: string; at: string }, [string]>('dingtalk-last-delivery:')
const Message = z.object({ msgId: z.string().min(1), conversationId: z.string().min(1),
  conversationType: z.string(), isInAtList: z.boolean().optional(), senderStaffId: z.string().min(1),
  senderCorpId: z.string().min(1), senderNick: z.string().optional(), chatbotUserId: z.string().optional(), senderId: z.string().optional(),
  robotCode: z.string().min(1), msgtype: z.string(), text: z.object({ content: z.string().optional() }).nullish(),
  content: z.unknown().optional(),
  createAt: z.number().optional(), sessionWebhook: z.string().url(), sessionWebhookExpiredTime: z.number() })
export interface Route { webhook: string; expires: number; robotCode: string; conversationId: string; corpId?: string }
export const ticketReference = (text: string): string | undefined => /(?:^|\s)#([a-f0-9]{12,32})(?=\s|$|[，。,:：])/i.exec(text)?.[1]?.toLowerCase()
export const label = (id: string): string => `#${id.slice(0, 12)}`
/** Projects the platform's body into text without treating a wire-format type as an admission rule. */
function contentText(value: unknown): string {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? contentText(parsed) : value
    } catch { return value }
  }
  if (Array.isArray(value)) return value.map(contentText).join('')
  if (!value || typeof value !== 'object') return ''
  const body = value as Record<string, unknown>
  if (Array.isArray(body.richText)) return contentText(body.richText)
  if (typeof body.text === 'string') return body.text
  if (body.text && typeof body.text === 'object') return contentText(body.text)
  if (typeof body.content === 'string') return body.content
  if (typeof body.recognition === 'string') return body.recognition
  if (typeof body.unknownMsgType === 'string') return body.unknownMsgType
  if (body.type === 'br') return '\n'
  if (body.type === 'picture' || body.pictureDownloadCode) return '\n[图片附件，内容尚未下载或解析]\n'
  if (typeof body.fileName === 'string') return `[文件附件：${body.fileName}，内容尚未下载或解析]`
  return ''
}
const QuotedMessage = z.object({ msgId: z.string().optional(), senderId: z.string().optional(),
  msgType: z.string().optional(), content: z.unknown().optional() })
function quotedMessage(head: Record<string, unknown>) {
  for (let container of [head.text, head.content]) {
    if (typeof container === 'string') {
      try { container = JSON.parse(container) } catch { continue }
    }
    if (!container || typeof container !== 'object') continue
    const body = container as Record<string, unknown>
    if (body.isReplyMsg !== true) continue
    const quote = QuotedMessage.safeParse(body.repliedMsg)
    if (quote.success) return quote.data
  }
}
/** Only card TEXT nodes are readable quote content; opaque/encrypted content is never guessed. */
function quotedText(value: unknown, depth = 0): string {
  if (depth > 8) return ''
  if (typeof value === 'string') {
    try { return quotedText(JSON.parse(value), depth + 1) } catch { return value }
  }
  if (Array.isArray(value)) return value.map(item => quotedText(item, depth + 1)).join('\n')
  if (!value || typeof value !== 'object') return ''
  const body = value as Record<string, unknown>
  if (body.elementType === 'TEXT' && typeof body.value === 'string') return body.value
  if (Array.isArray(body.cardContent)) return quotedText(body.cardContent, depth + 1)
  if (Array.isArray(body.children)) return quotedText(body.children, depth + 1)
  return contentText(value)
}
export function dingTalkTrigger(raw: unknown, context: SourceContext): { trigger: Trigger; route: Route; body?: { messageType: string; content: unknown } } | undefined {
  // The agreed receiving scope is group mentions; content type is not an additional filter.
  if (!raw || typeof raw !== 'object') return
  const head = raw as Record<string, unknown>
  if (head.conversationType !== '2' || head.isInAtList !== true) return
  const message = Message.parse(raw)
  if (message.senderId && message.senderId === message.chatbotUserId) return
  const text = [message.text?.content, contentText(message.content)].filter(value => value?.trim()).join('\n').trim()
    || `[钉钉 ${message.msgtype} 消息，未提供可解析文本；附件内容尚未下载或解析]`
  const id = key('dingtalk', message.robotCode, message.conversationId, message.msgId)
  const quote = quotedMessage(head)
  const replyToBot = !!quote?.senderId && !!message.chatbotUserId && quote.senderId === message.chatbotUserId
  const botQuote = replyToBot ? quotedText(quote?.content) : ''
  const directReference = ticketReference(text)
  const reference = directReference ?? ticketReference(botQuote)
  const saved = reference ? context.state.get(tickets(message.conversationId, reference)) : undefined
  const matches = reference ? (saved ? [context.tickets.get(saved)].filter(ticket => !!ticket)
    : context.tickets.open().filter(ticket => ticket.id.startsWith(reference)))
    .filter(ticket => context.triggers.get(ticket!.origin.triggerId)?.channel?.address.conversationId === message.conversationId) : []
  // Unknown/ambiguous references get their own evaluation, never fan out to another group's ticket.
  const origin = matches.length === 1 ? context.triggers.get(matches[0]!.origin.triggerId) : undefined
  const threads = origin?.threads ?? [{ source: 'dingtalk', id }]
  const conversation = message.conversationId
  return {
    trigger: { id, source: 'dingtalk', threads, actor: { source: 'dingtalk', id: message.senderStaffId }, human: true,
      addressed: 'mention', at: new Date(message.createAt ?? Date.now()).toISOString(), text,
      channel: { source: 'dingtalk', thread: `dingtalk:${conversation}`, address: { conversationId: conversation, triggerId: id } },
      meta: { conversationId: conversation, conversationType: '2', senderCorpId: message.senderCorpId, robotCode: message.robotCode,
        messageId: message.msgId, messageType: message.msgtype, chatbotUserId: message.chatbotUserId,
        ...(message.senderNick?.trim() ? { senderNick: message.senderNick.trim().slice(0, 200) } : {}),
        ...(quote ? { replyToMessageId: quote.msgId, replyToMessageType: quote.msgType, replyToBot } : {}),
        ...(botQuote ? { replyToBotText: botQuote.slice(0, 8000) } : {}),
        ...(reference ? { referenceSource: directReference ? 'text' : 'quote' } : {}),
        ...(reference ? { ticketReference: reference, referenceResolved: matches.length === 1 } : {}) } },
    route: { webhook: message.sessionWebhook, expires: message.sessionWebhookExpiredTime, robotCode: message.robotCode,
      conversationId: conversation, corpId: message.senderCorpId },
    ...(message.content !== undefined || quote ? { body: { messageType: message.msgtype,
      content: quote ? { content: message.content, quote } : message.content } } : {}),
  }
}
export interface DingTalkIntake {
  conversationId?: string
  forConversation?: (conversationId: string) => DingTalkIntake | undefined
  project?: { id: string; repository: string | null }
  onSender?: (trigger: Trigger) => string | undefined
  onMeeting?: (trigger: Trigger) => string
  discussion?: (trigger: Trigger) => (() => string) | undefined
}
/** Translates DingTalk Stream callbacks and group sends through the original SourceContext boundary. */
export class DingTalk {
  private readonly client: DWClient
  private readonly cards?: DingTalkCards
  private token?: { value: string; until: number }
  private streamStatus?: ReturnType<typeof setInterval>
  constructor(private readonly context: SourceContext, private readonly credentials: { clientId: string; clientSecret: string },
    private readonly log: (event: string) => void,
    private readonly http: typeof fetch = fetch, cardTemplateId?: string, robotName = 'Super agent',
    intake?: DingTalkIntake) {
    this.client = new DWClient({ ...credentials, debug: false, keepAlive: true })
    if (cardTemplateId) {
      this.cards = new DingTalkCards(context, cardTemplateId, () => this.accessToken(), http, credentials.clientId, robotName)
    }
    this.client.registerCallbackListener(TOPIC_ROBOT, async frame => {
      try {
        const parsed = dingTalkTrigger(JSON.parse(frame.data), context)
        if (parsed && (!intake?.conversationId || intake.conversationId === parsed.route.conversationId)) await context.atomic(() => {
          const { trigger } = parsed
          const handlers = intake?.forConversation ? intake.forConversation(parsed.route.conversationId) : intake
          if (handlers?.project) {
            trigger.meta.projectId = handlers.project.id
            trigger.meta.projectRepository = handlers.project.repository
          }
          const textCommand = (trigger.meta.messageType === 'text' || trigger.meta.messageType === 'richText')
            && context.config('dingtalk') !== undefined
          const enrollment = textCommand && handlers?.onSender && /^登记项目成员[。！!]?$/u.test(trigger.text)
          const meeting = textCommand && handlers?.onMeeting && /^项目会议纪要(?:[：:]|\r?\n)/u.test(trigger.text)
          const handle = enrollment ? handlers?.onSender : meeting ? handlers?.onMeeting : undefined
          const discussion = context.config('dingtalk') !== undefined && !handle ? handlers?.discussion?.(trigger) : undefined
          if (enrollment) trigger.meta.projectEnrollment = true
          if (meeting) trigger.meta.projectMeeting = true
          if (discussion) trigger.meta.projectDiscussion = true
          context.state.set(dingTalkRoute(parsed.route.conversationId), parsed.route)
          // Preserve native content/attachment references in the original Source KV, separate from model text.
          if (parsed.body) context.state.set(bodies(parsed.trigger.id), parsed.body)
          const result = context.receive(trigger)
          if (result instanceof Promise) throw new Error('DingTalk intake must commit synchronously')
          if ((handle || discussion) && result === 'filtered' && trigger.channel) {
            const text = discussion ? discussion() : handle?.(trigger)
            if (text) context.notify({ id: key('dingtalk-project-receipt', trigger.id), channel: trigger.channel, kind: 'notice', text })
          } else if (result === 'stored') {
            handlers?.onSender?.(trigger)
            this.received(trigger)
          }
          return result
        })
        // Acknowledge only after the event and pending work have committed.
        this.client.socketCallBackResponse(frame.headers.messageId, null)
      } catch { this.log('dingtalk_receive_failed') /* No ACK: DingTalk can redeliver. Never log credentials or payloads. */ }
    })
    const getEndpoint = this.client.getEndpoint.bind(this.client)
    this.client.getEndpoint = async () => {
      try { return await getEndpoint() }
      catch { this.log('dingtalk_connection_failed'); throw new Error('DingTalk Stream authentication or connection failed') }
    }
  }
  /** Use the same receipt card for native messages and externally bound event requests. */
  received(trigger: Trigger): void {
    if (this.cards) { this.cards.received(trigger); return }
    if (trigger.source === 'dingtalk' && trigger.human && trigger.addressed && trigger.channel?.source === 'dingtalk')
      this.context.notify({ id: key('dingtalk-intake-receipt', trigger.id), channel: trigger.channel, kind: 'notice',
        text: '已收到这条请求，正在判断如何处理。' })
  }
  bindWorkerDelivery(ticketId: string, deliveryId: string, triggerId: string) {
    return this.cards?.delivery(ticketId, deliveryId, triggerId)
  }
  async start(): Promise<void> {
    await this.client.connect()
    if (!this.client.connected) { this.client.disconnect(); throw new Error('DingTalk Stream did not connect') }
    this.context.report('dingtalk', { state: 'ready', detail: 'Stream connected' })
    let connected = true
    this.streamStatus = setInterval(() => {
      if (connected === this.client.connected) return
      connected = this.client.connected
      this.context.report('dingtalk', connected ? { state: 'ready', detail: 'Stream connected' }
        : { state: 'error', detail: 'Stream disconnected; waiting to reconnect' })
    }, 5000)
    this.streamStatus.unref()
    this.log('dingtalk_connected')
  }
  stop(): void { clearInterval(this.streamStatus); this.client.disconnect() }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value
    const result = await this.http('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ appKey: this.credentials.clientId, appSecret: this.credentials.clientSecret }),
    })
    const data = await result.json() as { accessToken?: string; expireIn?: number }
    if (!result.ok || !data.accessToken) throw new Error('DingTalk token request failed')
    this.token = { value: data.accessToken, until: Date.now() + Math.max(0, (data.expireIn ?? 7200) - 60) * 1000 }
    return this.token.value
  }
  async send(message: OutboundMessage): Promise<void> {
    const conversation = message.channel.address.conversationId!
    const route = this.context.state.get(dingTalkRoute(conversation))
    if (message.ticketId) this.context.state.set(tickets(conversation, message.ticketId.slice(0, 12)), message.ticketId)
    const eventLabel = message.channel.address.eventLabel
    const heading = [message.ticketId ? label(message.ticketId) : '', eventLabel ?? ''].filter(Boolean).join(' · ')
    const mention = message.channel.address.mentionUserId
    const body = heading ? `${heading}${eventLabel ? '\n' : ' '}${message.text}` : message.text
    const text = mention ? `@${mention} ${body}` : body
    const markdown = message.format === 'markdown'
    const title = message.title ?? '项目更新'
    if (text.length > 4000) throw new Error('DingTalk result exceeds 4000 characters; provide a brief result and a link')
    // Project lifecycle notices are sent to the group without threading them under an old request card.
    if (this.cards && (message.kind !== 'notice' || message.channel.address.triggerId || message.channel.address.cardId || message.ticketId)) {
      await this.cards.send(message)
      this.context.state.set(deliveries(conversation), { messageId: message.id, format: 'markdown', transport: 'ai-card', messageType: 'card', at: new Date().toISOString() })
      return
    }
    const url = route ? new URL(route.webhook) : undefined
    if (url && (url.protocol !== 'https:' || url.hostname !== 'oapi.dingtalk.com')) throw new Error('Invalid DingTalk session webhook')
    const token = await this.accessToken()
    // A long coding task can outlive the session webhook. Use the application group-send API after expiry.
    const active = !!route && route.expires > Date.now() + 5000
    const response = await this.http(active ? url! : 'https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      signal: AbortSignal.timeout(15000), body: JSON.stringify(active
        ? { ...(markdown ? { msgtype: 'markdown', markdown: { title, text } } : { msgtype: 'text', text: { content: text } }), ...(mention && { at: { atUserIds: [mention] } }) }
        : { robotCode: route?.robotCode ?? this.credentials.clientId, openConversationId: conversation,
          msgKey: markdown ? 'sampleMarkdown' : 'sampleText', msgParam: JSON.stringify(markdown ? { title, text } : { content: text }), ...(mention && { atUserIds: [mention] }) }),
    })
    const data = await response.json() as { errcode?: number; code?: string; processQueryKey?: string }
    if (!response.ok || (active ? data.errcode !== 0 : !!data.code || !data.processQueryKey)) {
      throw new Error(`DingTalk message send failed (HTTP ${response.status}); check robot permissions and group membership`)
    }
    this.context.state.set(deliveries(conversation), { messageId: message.id, format: markdown ? 'markdown' : 'text',
      transport: active ? 'session-webhook' : 'application-group-api', messageType: active ? markdown ? 'markdown' : 'text' : markdown ? 'sampleMarkdown' : 'sampleText', at: new Date().toISOString() })
  }
}
/** The original SourceRegistry and Outbox own admission and delivery; this kind only translates DingTalk messages. */
export function dingTalkKind(send: (message: OutboundMessage) => Promise<void>): SourceKind {
  return {
    kind: 'dingtalk', title: { zh: '钉钉', en: 'DingTalk' },
    description: { zh: 'Stream 群内 @ 消息（所有消息类型）', en: 'Stream group mentions (all message types)' },
    schema: z.object({}).strict(), fields: [], health: ['dingtalk'],
    projectEvents: [projectMessageReceived],
    scope: ({ meta }) => {
      if (meta.projectEnrollment === true) return { listened: false, reason: 'DingTalk project membership command' }
      if (meta.projectMeeting === true) return { listened: false, reason: 'DingTalk meeting minutes for project review' }
      if (meta.projectDiscussion === true) return { listened: false, reason: 'DingTalk project meeting discussion' }
      return meta.conversationType === '2' ? { listened: true, observed: false, row: 'group' }
        : { listened: false, reason: 'Only group messages are supported' }
    },
    channel: {
      formats: ['text', 'markdown'],
      transports: ['session-webhook (text/markdown)', 'application-group-api (sampleText/sampleMarkdown)'],
      documentation: ['https://open.dingtalk.com/document/orgapp/types-of-messages-sent-by-robots', 'https://open.dingtalk.com/document/robots/custom-robot-access'],
      deliveryInfo: (host, channel) => channel.address.conversationId ? host.state.get(deliveries(channel.address.conversationId)) : undefined,
      send: async (_host, message) => { await send(message); return 'sent' },
      link: () => ({ url: '', label: { zh: '钉钉群', en: 'DingTalk group' } }),
    },
  }
}
