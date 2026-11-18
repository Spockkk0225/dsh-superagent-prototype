/** Queries verified remote facts without coupling project delivery decisions to a provider's API payload. */
import { KV } from '../kv.ts'
import { key } from '../core/index.ts'
import type { RepositoryFact, ProjectRepositoryTarget } from '../sources/repository-events.ts'
import { Projects, type Project, type ProjectTask } from './projects.ts'
import type { Store } from './store.ts'

export const repositoryFactKey = (projectId: string, taskId: string, version: number, url: string) =>
  KV.projects.remoteFact(key(projectId, taskId, String(version), url))

export function projectResources(store: Store): ProjectRepositoryTarget[] {
  const projects = new Projects(store)
  return projects.list().filter(project => project.status !== 'archived' && project.repository).flatMap(project => {
    const detail = projects.detail(project.id)
    return detail.tasks.filter(task => task.status !== 'cancelled').map(task => ({ projectId: project.id, taskId: task.id,
      repository: project.repository!, issueUrl: task.issueUrl, ticketId: task.ticketId ?? undefined, deliveryVersion: task.deliveryVersion ?? 0,
      pullUrls: [...new Set([...(task.pullRequestUrl ? [task.pullRequestUrl] : []),
        ...detail.tickets.filter(ticket => ticket.id === task.ticketId).flatMap(ticket => ticket.pullUrls)])] }))
  })
}

export function taskRemoteFacts(store: Store, project: Project, task: ProjectTask): RepositoryFact[] {
  return store.keys(KV.projects.remoteFact).map(entry => store.get(entry)!)
    .filter(fact => fact.projectId === project.id && fact.taskId === task.id && fact.deliveryVersion === (task.deliveryVersion ?? 0))
    .map(({ projectId: _project, taskId: _task, ...fact }) => fact)
}

export function mergedDelivery(store: Store, project: Project, task: ProjectTask): RepositoryFact | undefined {
  return taskRemoteFacts(store, project, task).find(fact => fact.url.includes('/pull/') && fact.state === 'merged' && fact.head && fact.mergeCommit
    && fact.repository === project.repository && (!task.ticketId || fact.ticketId === task.ticketId)
    && (!task.pullRequestUrl || task.pullRequestUrl === fact.url) && (!task.targetBranch || task.targetBranch === fact.base))
}
