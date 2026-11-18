import type { Project, ProjectTask } from './projects.ts'

export const taskReference = (id: string) => `〔任务 ${id.slice(0, 8)}〕`

export function taskContext(project: Pick<Project, 'id' | 'name'>, task: ProjectTask, acceptanceLabel: string): string {
  return [`# ${project.name} / ${task.title}`, `Super Agent task: ${project.id}/${task.id}`, task.description,
    task.acceptance && `## ${acceptanceLabel}\n\n${task.acceptance}`].filter(Boolean).join('\n\n')
}
