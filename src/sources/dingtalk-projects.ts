import type { Trigger } from '../core/index.ts'
import type { ProjectPlanning } from '../app/project-planning.ts'
import type { ProjectAgent } from '../app/project-agent.ts'
import { ProjectRepository, type Projects } from '../app/projects.ts'
import type { DingTalkIntake } from './dingtalk.ts'

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
        const repository = ProjectRepository.nullable().safeParse(raw && raw !== '无' ? raw : null)
        if (repositories.length > 1 || !repository.success) return '如果会议已确定 GitHub 仓库，请在同一行填写一个 owner/repo 或 GitHub 仓库链接。'
        planning.submitFirstMinutes({ name: projectName, repository: repository.data, dingTalkGroup: group }, {
          ...meetingEvidence(trigger, name, member.id), text: trigger.text, channel: trigger.channel,
          clarificationHint: '补充时请 @ 我发「会议反馈：…」。',
        })
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
