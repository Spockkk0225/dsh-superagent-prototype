/** Compatibility for project requests already persisted by the previous message router. */
import type { ChannelRef } from '../core/index.ts'
import type { ProjectMeetingReply } from './projects.ts'
import type { ProjectAgent } from './project-agent.ts'
import type { Effects } from './effects.ts'

export type ProjectActionMessage = { projectId: string; actorId: string; messageId: string; channel: ChannelRef; text: string; quoted: string;
  feedback?: { meetingId: string; reply: ProjectMeetingReply } }
export type ProjectActionSelection = { action: 'create' | 'start_task' | 'kickoff_and_start'; repository?: string }

export function resumeProjectActions(effects: Effects, agent: ProjectAgent): void {
  const resume = async ({ projectId, actorId, messageId, channel, text, quoted }: ProjectActionMessage) => {
    agent.submit({ projectId, actorId, messageId, channel, text, quoted })
  }
  effects.handle('project-action', resume)
  effects.handle('project-issue-intent', resume)
}
