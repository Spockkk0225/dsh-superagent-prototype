/** Status and priority views over the same project tasks. Both use the existing task change API. */
import { useState, type DragEvent } from 'react'
import type { ProjectDetail, ProjectPriority, ProjectTask } from '../app/projects.ts'
import { Icon, Tag } from './controls.tsx'
import type { T } from './text.ts'

const LANES = ['todo', 'in-progress', 'in-review', 'done'] as const
export const PROJECT_PRIORITIES = ['do', 'schedule', 'delegate', 'eliminate'] as const satisfies readonly ProjectPriority[]
const TASK_DRAG = 'application/x-superagent-task'
const stopped = (task: ProjectTask) => task.status === 'done' || task.status === 'cancelled'
const priorityOf = (task: ProjectTask) => task.priority ?? 'eliminate'

interface Column<Id extends string> {
  id: Id
  label: string
  context?: string
}

export function ProjectBoard({ t, view, project, tasks, pending, select, moveStatus, movePriority }: {
  t: T; view: 'kanban' | 'priority'; project: ProjectDetail; tasks: ProjectTask[]; pending: boolean;
  select: (task: ProjectTask) => void; moveStatus: (task: ProjectTask, status: ProjectTask['status']) => void;
  movePriority: (task: ProjectTask, priority: ProjectPriority) => void
}) {
  if (view === 'priority') return <Columns key="priority" t={t} view={view} project={project} tasks={tasks.filter(task => !stopped(task))}
    columns={PROJECT_PRIORITIES.map(id => ({ id, label: t(`project.priority.${id}`), context: t(`project.priorityContext.${id}`) }))}
    pending={pending} select={select} group={priorityOf} move={movePriority} />
  return <Columns key="kanban" t={t} view={view} project={project} tasks={tasks.filter(task => task.status !== 'cancelled')}
    columns={LANES.map(id => ({ id, label: t(`project.state.${id}`) }))}
    pending={pending} select={select} group={task => task.status} move={moveStatus} />
}

function Columns<Id extends string>({ t, view, project, columns, tasks, pending, select, group, move }: {
  t: T; view: 'kanban' | 'priority'; project: ProjectDetail; columns: Column<Id>[]; tasks: ProjectTask[];
  pending: boolean; select: (task: ProjectTask) => void; group: (task: ProjectTask) => Id; move: (task: ProjectTask, id: Id) => void
}) {
  const [source, setSource] = useState<string>()
  const [over, setOver] = useState<Id>()
  const owners = new Map(project.members.map(member => [member.id, member.name]))
  const completed = new Set(project.tasks.filter(task => task.status === 'done').map(task => task.id))
  const undecided = new Set(project.decisions.filter(decision => !decision.answeredAt).map(decision => decision.taskId))
  const tickets = new Map(project.tickets.map(ticket => [ticket.id, ticket]))
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const clear = () => { setSource(undefined); setOver(undefined) }
  const admit = (event: DragEvent<HTMLElement>, column: Id) => {
    if (!source || pending || !event.dataTransfer.types.includes(TASK_DRAG)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setOver(column)
  }
  const drop = (event: DragEvent<HTMLElement>, column: Id) => {
    if (!source || pending) return
    event.preventDefault()
    const task = tasks.find(task => task.id === event.dataTransfer.getData(TASK_DRAG) && task.id === source)
    clear()
    if (task && group(task) !== column) move(task, column)
  }
  return <div className="dt-kanban" data-view={view}>
    {columns.map(column => {
      const matching = tasks.filter(task => group(task) === column.id)
      return <section className="dt-kanban-column" key={column.id} data-column={column.id} data-over={over === column.id}
        aria-label={column.label} onDragOver={event => admit(event, column.id)} onDrop={event => drop(event, column.id)}>
        <header><span className="dt-kanban-dot" />
          <div><h4>{column.label}</h4>{column.context && <small>{column.context}</small>}</div><span className="dt-kanban-count">{matching.length}</span></header>
        {matching.length === 0 ? <p className="dt-kanban-empty">{t('project.emptyColumn')}</p> : <ul>
          {matching.map(task => {
            const blocked = !stopped(task) && task.blockedBy.some(dep => !completed.has(dep))
            const waiting = !stopped(task) && undecided.has(task.id)
            const overdue = !stopped(task) && task.dueDate && new Date(`${task.dueDate}T00:00:00`) < today
            const ticket = task.ticketId ? tickets.get(task.ticketId) : undefined
            const issue = task.issueUrl?.replace(/^https:\/\/github\.com\//, '').replace('/issues/', '#')
            return <li key={task.id}><button className="dt-kanban-task" type="button" draggable={!pending} data-dragging={source === task.id}
              onClick={() => select(task)}
              onDragStart={event => {
                event.dataTransfer.setData(TASK_DRAG, task.id)
                event.dataTransfer.effectAllowed = 'move'
                setSource(task.id)
              }} onDragEnd={clear}>
              {issue && <span className="dt-kanban-issue"><Icon name="hash" size={12} />{issue}</span>}
              <strong>{task.title}</strong>
              {task.description && <span className="dt-kanban-description">{task.description}</span>}
              <span className="dt-kanban-metadata">
                <span><Icon name="user" size={12} />{task.ownerId ? owners.get(task.ownerId) ?? t('project.formerMember') : t('project.unassigned')}</span>
                {task.dueDate && <time dateTime={task.dueDate} data-overdue={!!overdue}><Icon name="clock" size={12} />{task.dueDate}</time>}
              </span>
              {(blocked || waiting || ticket) && <span className="dt-kanban-tags">
                {blocked && <Tag tone="warning">{t('project.blocked')}</Tag>}
                {waiting && <Tag tone="warning">{t('project.pending')}</Tag>}
                {ticket && <Tag tone={ticket.stage === 'working' ? 'info' : 'outline'}>
                  {ticket.stage === 'working' ? t('stage.working') : t('project.hasTicket')}</Tag>}
              </span>}
            </button></li>
          })}
        </ul>}
      </section>
    })}
  </div>
}
