/** Provider-independent repository facts; adapters own remote protocol and resource discovery. */
import { z } from 'zod'
import type { ProjectEventDefinition } from './project-events.ts'

export const RepositoryChannel = z.strictObject({ source: z.string().min(1), thread: z.string().min(1), address: z.record(z.string(), z.string()) })
export const RepositoryFeedback = z.strictObject({ repository: z.string().min(1), resourceUrl: z.url(), url: z.url(),
  id: z.string().min(1), kind: z.enum(['comment', 'inline', 'review']), body: z.string().max(60000),
  actor: z.strictObject({ id: z.string().min(1), human: z.boolean() }), updatedAt: z.iso.datetime(),
  head: z.string().optional(), commit: z.string().optional(), path: z.string().optional(), line: z.number().int().nullable().optional(),
  diff: z.string().max(60000).optional(),
  threadId: z.string().optional(), state: z.string().optional(), channel: RepositoryChannel,
  ticketId: z.string().optional(), deliveryVersion: z.number().int().nonnegative() })
export type RepositoryFeedback = z.output<typeof RepositoryFeedback>
export const feedbackReceived: ProjectEventDefinition = { type: 'code.feedback.received', category: 'comments', schema: RepositoryFeedback,
  description: '接收关联代码交付的评论、行讨论或评审，由 Agent 判断如何回答或跟进原工单，并保留原讨论回执。',
  defaults: { enabled: true, instruction: '核对反馈的真实作者、代码版本与当前任务。结合上下文回答问题、澄清建议，或通过 task.follow_up 把明确且属于本任务范围的修改交给原执行工单。不要按关键词直接开工，不更改任务范围或代替人验收。回复原讨论；转交执行后结果仍由原工单回到原讨论，不把转交说成已修复。' },
  documentation: 'docs/events/repository.zh-CN.md' }

export const RepositoryFact = z.strictObject({ repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  url: z.url(), state: z.enum(['open', 'closed', 'merged']), updatedAt: z.iso.datetime(),
  head: z.string().optional(), base: z.string().optional(), mergeCommit: z.string().optional(),
  ticketId: z.string().optional(), deliveryVersion: z.number().int().nonnegative() })
export type RepositoryFact = z.output<typeof RepositoryFact>
export interface ProjectRepositoryTarget {
  projectId: string; taskId: string; repository: string; issueUrl: string | null; pullUrls: string[]; ticketId?: string; deliveryVersion: number; since?: string
}
export const issueObserved: ProjectEventDefinition = { type: 'issue.observed', category: 'issues', schema: RepositoryFact,
  description: '记录关联 Issue 的真实远端状态；不代替项目验收。', defaults: { enabled: true }, documentation: 'docs/events/repository.zh-CN.md' }
export const changeObserved: ProjectEventDefinition = { type: 'code.change.observed', category: 'pull_requests', schema: RepositoryFact,
  description: '记录当前代码交付的开放、关闭或合并事实，核对代码版本后检查是否可请求验收。',
  defaults: { enabled: true }, documentation: 'docs/events/repository.zh-CN.md' }
