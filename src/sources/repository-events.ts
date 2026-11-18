/** Provider-independent repository facts; adapters own remote protocol and resource discovery. */
import { z } from 'zod'
import type { ProjectEventDefinition } from './project-events.ts'

export const RepositoryFact = z.strictObject({ repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  url: z.url(), state: z.enum(['open', 'closed', 'merged']), updatedAt: z.iso.datetime(),
  head: z.string().optional(), base: z.string().optional(), mergeCommit: z.string().optional(),
  ticketId: z.string().optional(), deliveryVersion: z.number().int().nonnegative() })
export type RepositoryFact = z.output<typeof RepositoryFact>
export interface ProjectRepositoryTarget {
  projectId: string; taskId: string; repository: string; issueUrl: string | null; pullUrls: string[]; ticketId?: string; deliveryVersion: number
}
export const issueObserved: ProjectEventDefinition = { type: 'issue.observed', category: 'issues', schema: RepositoryFact,
  description: '记录关联 Issue 的真实远端状态；不代替项目验收。', defaults: { enabled: true }, documentation: 'docs/events/repository.zh-CN.md' }
export const changeObserved: ProjectEventDefinition = { type: 'code.change.observed', category: 'pull_requests', schema: RepositoryFact,
  description: '记录当前代码交付的开放、关闭或合并事实，核对代码版本后检查是否可请求验收。',
  defaults: { enabled: true }, documentation: 'docs/events/repository.zh-CN.md' }
