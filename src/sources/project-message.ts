import { z } from 'zod'
import type { ProjectEventDefinition } from './project-events.ts'

const id = z.string().min(1).max(300)
export const ProjectMessage = z.strictObject({
  projectId: id, messageId: id, actorId: id.nullable(), text: z.string().trim().min(1).max(26000),
  quoted: z.string().max(16000).default(''),
  reviewId: id.optional(),
  channel: z.strictObject({ source: id, thread: id, address: z.record(z.string(), z.string()) }),
})
export type ProjectMessage = z.output<typeof ProjectMessage>
export const projectMessageReceived: ProjectEventDefinition = {
  type: 'project.message.received', category: 'messages', schema: ProjectMessage,
  description: '项目消息唤起 Agent，结合原文、引用、当前任务及成员信息选择项目工具并回告结果。',
  defaults: { enabled: true, instruction: '理解成员这次请求及其引用，结合当前项目和已有分工选择工具。明确的修改直接处理，验收条件可根据已有目标拟定。需要补充的信息只问一个具体问题。以实际工具结果说明变化，按用户意图决定是否执行任务。' },
  documentation: 'docs/events/project-message.zh-CN.md',
}
