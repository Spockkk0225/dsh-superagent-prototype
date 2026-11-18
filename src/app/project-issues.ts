import { z } from 'zod'
import { key, type ChannelRef, type OutboundMessage } from '../core/index.ts'
import { CliError, type Commands } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import type { Effects } from './effects.ts'
import { githubIssueUrl, Projects } from './projects.ts'
import { taskContext, taskReference } from './project-task-context.ts'
import type { Store } from './store.ts'

export type ProjectIssueRequest = { projectId: string; taskId: string; actorId: string | null; repository: string; messageId: string; channel: ChannelRef }
export type ProjectIssueAttempt = { since: string; url?: string }
const issueSchema = z.object({ html_url: z.string() })
const recoveryIssue = issueSchema.extend({ body: z.string().nullish(), pull_request: z.unknown().optional(), user: z.object({ login: z.string() }) })
/** Publishes and links approved task Issues with recovery for uncertain GitHub responses. */
export class ProjectIssues {
  private readonly projects: Projects
  constructor(private readonly store: Store, private readonly effects: Effects, private readonly commands: Pick<Commands, 'forRepository'>,
    private readonly notify: (message: OutboundMessage) => void, private readonly connected: () => boolean) {
    this.projects = new Projects(store)
    effects.handle('project-issue', (request, id) => this.create(id, request))
  }

  request(request: Omit<ProjectIssueRequest, 'repository'>): string | undefined {
    return this.store.atomic(() => {
      const { projectId, actorId, taskId } = request
      const project = this.projects.detail(projectId)
      if (actorId === null ? request.channel.source !== 'request' : !project.memberIds.includes(actorId)) return '请先登记为这个项目的成员。'
      const task = project.tasks.find(item => item.id === taskId && item.status !== 'cancelled')
      if (!task) return '任务已变更，请在看板查看。'
      if (task.issueUrl) return `${taskReference(task.id)}「${task.title}」已关联 ${task.issueUrl}`
      if (!project.repository) return '这个项目还没有关联 GitHub 仓库。可以在看板的「编辑项目」中关联，再回复请求。'
      if (!this.connected()) return 'GitHub 账号尚未就绪，暂时无法开 Issue。'
      const operation = key(projectId, task.id, project.repository)
      if (this.effects.pending('project-issue', operation)) return `正在处理「${task.title}」的 Issue 请求。`
      this.effects.enqueue('project-issue', operation, { ...request, repository: project.repository })
    })
  }

  private async create(id: string, request: ProjectIssueRequest): Promise<void> {
    const { projectId, taskId, actorId, repository, channel, messageId } = request
    const send = (text: string) => this.notify({ id: key('project-issue-result', messageId), kind: 'notice', channel, text })
    const project = this.projects.detail(projectId)
    const task = project.tasks.find(item => item.id === taskId)
    if (!task || task.status === 'cancelled' || (actorId === null ? channel.source !== 'request' : !project.memberIds.includes(actorId)) || project.repository !== repository) {
      send('项目仓库、成员或任务已变更，请查看看板后再申请开 Issue。'); return
    }
    if (task.issueUrl) { send(`${taskReference(taskId)}「${task.title}」已关联 ${task.issueUrl}`); return }
    const commands = this.commands.forRepository(repository)
    const attemptKey = KV.projects.issueAttempt(id)
    const previous = this.store.get(attemptKey)
    const marker = `<!-- super-agent-task: ${projectId}/${taskId} -->`
    const since = previous?.since ?? new Date(Date.now() - 5000).toISOString()
    let url = previous?.url
    try {
      if (!url && previous) {
        // A process may have stopped after GitHub accepted the POST. Only look for that Issue on retries.
        const list = await commands.pages(recoveryIssue, `issues?state=all&per_page=100&since=${encodeURIComponent(since)}`)
        url = list.find(issue => !issue.pull_request && issue.user.login.toLowerCase() === commands.deployment.github.login.toLowerCase()
          && issue.body?.includes(marker))?.html_url
      } else if (!previous) {
        this.store.set(attemptKey, { since })
        const body = `${taskContext(project, task, '验收条件')}\n\n${marker}`
        url = (await commands.api(issueSchema, 'issues', '--method', 'POST', '-f', `title=${task.title}`, '-f', `body=${body}`)).html_url
      }
    } catch (error) {
      if (!previous && error instanceof CliError && [401, 403, 404, 410, 422].includes(error.code ?? 0)) {
        this.store.atomic(() => { this.store.delete(attemptKey); send(`GitHub 未接受「${task.title}」的开 Issue 请求。请检查仓库的 Issues 设置及账号权限。`) })
        return
      }
    }
    const issue = url && githubIssueUrl(url)
    if (!issue?.startsWith(`https://github.com/${repository}/issues/`)) {
      send(`暂时无法确认「${task.title}」的 Issue 是否已创建。再次回复「开 Issue ${task.id.slice(0, 8)}」可重新核对。`); return
    }
    this.store.atomic(() => {
      this.store.set(attemptKey, { since, url: issue })
      const linked = this.projects.linkIssue(projectId, taskId, repository, issue, 'resolve')
      send(linked ? `${taskReference(taskId)}「${task.title}」已建立并关联 Issue ${issue}`
        : `Issue 已建立 ${issue}。项目仓库或关联有变更，请在看板核对。`)
    })
  }
}
