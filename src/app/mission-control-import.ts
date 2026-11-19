/** One-time import of the planning records from a Mission Control data directory. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { key } from '../core/ids.ts'
import { KV } from '../kv.ts'
import { githubIssueUrl, validateDependencies, type Project, type ProjectTask } from './projects.ts'
import type { Store } from './store.ts'

const ref = z.string().min(1)
const optionalRef = ref.nullish()
const text = z.string().nullish()
const projectSchema = z.object({
  id: ref, name: ref, description: text, createdAt: text, deletedAt: text,
  status: z.enum(['active', 'paused', 'completed', 'archived']).default('active'),
})
const taskSchema = z.object({
  id: ref, title: ref, projectId: optionalRef, milestoneId: optionalRef, description: text, notes: text,
  kanban: z.enum(['not-started', 'in-progress', 'done']).default('not-started'), assignedTo: text,
  importance: z.enum(['important', 'not-important']).optional(),
  urgency: z.enum(['urgent', 'not-urgent']).optional(),
  blockedBy: z.array(ref).default([]), acceptanceCriteria: z.array(z.string()).default([]),
  dueDate: text, createdAt: text, updatedAt: text, completedAt: text, deletedAt: text,
})
const goalSchema = z.object({
  id: ref, title: ref, projectId: optionalRef, parentGoalId: optionalRef, timeframe: text, deletedAt: text,
  status: z.enum(['not-started', 'in-progress', 'completed']).default('not-started'),
})
const decisionSchema = z.object({
  id: ref, question: ref, taskId: optionalRef, answer: text, answeredAt: text, context: text, options: z.array(z.string()).default([]),
})

type LegacyTask = z.infer<typeof taskSchema>
type LegacyGoal = z.infer<typeof goalSchema>
const importedId = (kind: string, oldId: string) => key('mission-control', kind, oldId)
const stateMap = { 'not-started': 'todo', 'in-progress': 'in-progress', done: 'done' } as const
const inboxId = importedId('inbox', '')
const groupText = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join('\n\n')
const date = (value?: string | null) => {
  const result = z.iso.date().safeParse(value?.slice(0, 10))
  return result.success ? result.data : null
}
const issueLink = (value?: string | null) => {
  for (const url of value?.match(/https:\/\/github\.com\/[\w-]+\/[\w.-]+\/issues\/[1-9]\d*/gi) ?? []) {
    const normalized = githubIssueUrl(url)
    if (normalized) return normalized
  }
  return null
}

function read<T>(directory: string, file: string, schema: z.ZodType<T>, optional = false): T | undefined {
  try { return schema.parse(JSON.parse(readFileSync(join(directory, file), 'utf8'))) }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
    throw new Error(`Cannot import ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

function entries<T extends { id: string }>(values: T[], label: string): Map<string, T> {
  const indexed = new Map(values.map(value => [value.id, value]))
  if (indexed.size !== values.length) throw new Error(`Duplicate Mission Control ${label} IDs`)
  return indexed
}

/** Reads and validates the snapshot before applying new projects in one SQLite transaction. */
export function importMissionControl(store: Store, directory: string) {
  const original = entries(read(directory, 'projects.json', z.object({ projects: z.array(projectSchema) }))!.projects, 'project')
  const live = entries(read(directory, 'tasks.json', z.object({ tasks: z.array(taskSchema) }))!.tasks, 'task')
  const archive = entries(read(directory, 'tasks-archive.json', z.object({ tasks: z.array(taskSchema) }), true)?.tasks ?? [], 'archived task')
  const goals = entries(read(directory, 'goals.json', z.object({ goals: z.array(goalSchema) }))!.goals, 'goal')
  const decisions = entries(read(directory, 'decisions.json', z.object({ decisions: z.array(decisionSchema) }))!.decisions, 'decision')
  const tasks = new Map([...archive, ...live])
  const at = new Date().toISOString()
  const projects = new Map<string, Project>()
  for (const item of original.values()) {
    const id = importedId('project', item.id)
    projects.set(id, { id, name: item.name, description: item.description ?? '', objective: '', issueUrl: issueLink(item.description),
      status: item.deletedAt ? 'archived' : item.status, revision: 0, createdAt: item.createdAt ?? at, updatedAt: at,
      memberIds: [], tasks: [], milestones: [], decisions: [] })
  }
  const group = (legacyId?: string | null) => legacyId && original.has(legacyId) ? importedId('project', legacyId) : inboxId
  const destination = (id: string) => {
    let project = projects.get(id)
    if (!project) {
      project = { id, name: 'Mission Control Inbox', description: '', objective: '', issueUrl: null,
        status: 'active', revision: 0, createdAt: at, updatedAt: at, memberIds: [], tasks: [], milestones: [], decisions: [] }
      projects.set(id, project)
    }
    return project
  }
  const goalProject = (goal?: LegacyGoal) => {
    const traversed = new Set<string>()
    while (goal) {
      if (goal.projectId) return group(goal.projectId)
      if (traversed.has(goal.id)) throw new Error(`Mission Control goal cycle at ${goal.id}`)
      traversed.add(goal.id)
      goal = goal.parentGoalId ? goals.get(goal.parentGoalId) : undefined
    }
    return inboxId
  }
  const taskProject = (task?: LegacyTask) => task?.projectId ? group(task.projectId)
    : goalProject(task?.milestoneId ? goals.get(task.milestoneId) : undefined)

  for (const goal of goals.values()) {
    const project = destination(goalProject(goal))
    if (!goal.parentGoalId && !goal.deletedAt && !project.objective) project.objective = goal.title
    project.milestones.push({ id: importedId('goal', goal.id), title: goal.title, dueDate: date(goal.timeframe),
      status: goal.deletedAt ? 'cancelled' : goal.status === 'completed' ? 'done' : 'open' })
  }
  for (const task of tasks.values()) {
    const project = destination(taskProject(task))
    const status = !live.has(task.id) || task.deletedAt ? task.kanban === 'done' ? 'done' : 'cancelled' : stateMap[task.kanban]
    const milestoneId = task.milestoneId ? importedId('goal', task.milestoneId) : null
    const urgent = task.urgency === 'urgent'
    const priority = task.importance === 'important' ? (urgent ? 'do' : 'schedule') : (urgent ? 'delegate' : 'eliminate')
    const imported: ProjectTask = { id: importedId('task', task.id), title: task.title,
      description: groupText(task.description, task.notes, task.assignedTo ? `Mission Control assignee: ${task.assignedTo}` : ''),
      status, priority, ownerId: null, milestoneId: project.milestones.some(goal => goal.id === milestoneId) ? milestoneId : null,
      issueUrl: issueLink(task.description) ?? issueLink(task.notes), ticketId: null,
      blockedBy: [...new Set(task.blockedBy.map(blocker => {
        const dependency = tasks.get(blocker)
        if (!dependency || taskProject(dependency) !== project.id)
          throw new Error(`Cannot import dependency ${task.id} → ${blocker}: both tasks must be in the same project`)
        return importedId('task', blocker)
      }))], acceptance: task.acceptanceCriteria.join('\n'), dueDate: date(task.dueDate),
      createdAt: task.createdAt ?? at, updatedAt: task.updatedAt ?? at,
      completedAt: status === 'done' ? task.completedAt ?? task.updatedAt ?? at : null,
    }
    project.tasks.push(imported)
  }
  for (const decision of decisions.values()) {
    const task = decision.taskId ? tasks.get(decision.taskId) : undefined
    destination(taskProject(task)).decisions.push({ id: importedId('decision', decision.id), question: decision.question,
      taskId: task ? importedId('task', task.id) : null, answer: decision.answer ?? '',
      answeredAt: decision.answer ? decision.answeredAt ?? at : null, context: groupText(decision.context, decision.options.join('\n')) })
  }
  return store.atomic(() => {
    const result = { projects: 0, tasks: 0, milestones: 0, decisions: 0, skippedProjects: 0 }
    for (const project of projects.values()) {
      if (store.get(KV.projects.project(project.id))) { result.skippedProjects++; continue }
      for (const task of project.tasks) validateDependencies(project.tasks, task)
      store.set(KV.projects.project(project.id), project)
      result.projects++; result.tasks += project.tasks.length
      result.milestones += project.milestones.length; result.decisions += project.decisions.length
    }
    return result
  })
}
