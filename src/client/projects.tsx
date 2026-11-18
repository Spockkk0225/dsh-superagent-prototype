import { useState, type FormEvent, type ReactNode } from 'react'
import type { Member, MemberInput, Project, ProjectChange, ProjectDecision, ProjectDetail, ProjectExecution, ProjectMilestone, ProjectPriority, ProjectTask, ProjectTicket } from '../app/projects.ts'
import { taskContext } from '../app/project-task-context.ts'
import { currentReview } from '../app/project-deliveries.ts'
import { usePoll, type Call } from './api.ts'
import { ProjectHistory } from './project-history.tsx'
import { AgentStatus } from './agent-status.tsx'
import { Button, Icon, Input, Modal, Tag } from './controls.tsx'
import { errorText, type T } from './text.ts'
import { MarkdownContent } from './widgets.tsx'
import { ProjectBoard, PROJECT_PRIORITIES } from './project-board.tsx'
import { Issue, ProjectDecisions, ProjectMembers, ProjectMilestones, ProjectTickets, ticketLabel } from './project-sections.tsx'

const TASK_STATES = ['todo', 'in-progress', 'in-review', 'done', 'cancelled'] as const
const PROJECT_STATES = ['planning', 'active', 'paused', 'completed', 'archived'] as const
const MILESTONE_STATES = ['open', 'done', 'cancelled'] as const
const TASK_VIEWS = ['kanban', 'priority', 'list'] as const
type TaskView = typeof TASK_VIEWS[number]
const ISSUE_REFERENCE = /^(?:https?:\/\/github\.com\/)?([\w-]+\/[\w.-]+)(?:\/issues\/|#)([1-9]\d*)\/?(?:[?#].*)?$/
const ISSUE_NUMBER = /^#([1-9]\d*)$/
const SECTIONS = ['tasks', 'members', 'milestones', 'decisions', 'tickets', 'history'] as const
type ProjectSection = typeof SECTIONS[number]
const SECTION_ICONS = { tasks: 'queue', members: 'user', milestones: 'clock', decisions: 'decision', tickets: 'history', history: 'history' } as const
const field = (data: FormData, name: string) => String(data.get(name) ?? '').trim()
const optional = (data: FormData, name: string) => field(data, name) || null
type Change = ProjectChange['change']
type Basic = { t: T }

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="dt-field"><span>{label}</span>{children}</label>
}

function Status<V extends string>({ label, value, choices, translated, name = 'status' }: {
  label: string; value: V; choices: readonly V[]; translated: (value: V) => string; name?: string
}) {
  return <Field label={label}><select className="dt-select" name={name} defaultValue={value}>
    {choices.map(status => <option key={status} value={status}>{translated(status)}</option>)}
  </select></Field>
}

function Editor({ t, title, close, save, children, submitLabel }: Basic & {
  title: string; close: () => void; save: (data: FormData) => Promise<unknown>; children: ReactNode; submitLabel?: string
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [requestId] = useState(() => crypto.randomUUID())
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending) return
    const data = new FormData(event.currentTarget)
    setPending(true)
    setError('')
    try { await save(data); close() }
    catch (failure) { setError(errorText(failure)); setPending(false) }
  }
  return <Modal open onClose={() => { if (!pending) close() }} title={title} closeLabel={t('close')}>
    <form className="dt-project-form" onSubmit={event => { void submit(event) }}>
      <fieldset className="dt-fieldset" disabled={pending}>
        <input type="hidden" name="messageId" value={requestId} />
        {children}
        {error && <p className="dt-error" role="alert">{error}</p>}
        <div className="dt-project-actions">
          <Button variant="outline" onClick={close}>{t('cancel')}</Button>
          <Button variant="primary" type="submit">{submitLabel ?? t('project.save')}</Button>
        </div>
      </fieldset>
    </form>
  </Modal>
}

function IssueField({ t, url }: Basic & { url?: string | null }) {
  return <div className="dt-project-field-help"><Field label={t('project.issueOptional')}>
    <Input name="issueUrl" type="url" aria-describedby="dt-task-issue-help" defaultValue={url ?? ''} placeholder="https://github.com/owner/repo/issues/42" />
  </Field><p id="dt-task-issue-help" className="dt-hint">{t('project.issueOptionalHelp')}</p></div>
}
function ProjectFields({ t, project }: Basic & { project?: Project }) {
  return <>
    <Field label={t('project.name')}><Input name="name" defaultValue={project?.name} required maxLength={200} /></Field>
    <Field label={t('project.objective')}><textarea className="dt-textarea" rows={2} name="objective"
      defaultValue={project?.objective} maxLength={8000} /></Field>
    <Field label={t('project.description')}><textarea className="dt-textarea" rows={4} name="description"
      defaultValue={project?.description} maxLength={8000} /></Field>
    <Field label={t('project.repository')}><Input name="repository" defaultValue={project?.repository ?? ''} placeholder="owner/name" maxLength={200} /></Field>
    <Field label={t('project.dingTalkGroup')}><Input name="dingTalkGroup" defaultValue={project?.dingTalkGroup ?? ''} maxLength={300} /></Field>
    {project && <Status label={t('project.status')} value={project.status} choices={PROJECT_STATES} translated={value => t(`project.state.${value}`)} />}
    <label className="dt-work-status">
      <input type="checkbox" name="autoAdvance" defaultChecked={project?.autoAdvance ?? false} />
      <span>{t('project.autoAdvance')}</span>
    </label>
    <p className="dt-hint">{t('project.autoAdvanceHelp')}</p>
  </>
}
const projectValue = (data: FormData) => ({
  name: field(data, 'name'), objective: field(data, 'objective'), description: field(data, 'description'),
  repository: optional(data, 'repository'), dingTalkGroup: optional(data, 'dingTalkGroup'),
  autoAdvance: data.has('autoAdvance'),
  status: (field(data, 'status') || 'active') as Project['status'],
})

function MemberFields({ t, member }: Basic & { member?: Member }) {
  const [count, setCount] = useState(member?.accounts.length || 1)
  return <>
    <Field label={t('project.memberName')}><Input name="name" defaultValue={member?.name} required maxLength={200} /></Field>
    <div className="dt-project-accounts">
      <strong>{t('project.accounts')}</strong>
      <p className="dt-hint">{t('project.accountsHelp')}</p>
      {Array.from({ length: count }, (_, index) => {
        const saved = member?.accounts[index]
        return <div key={index} className="dt-project-grid">
          <Field label={t('project.provider')}><Input name={`provider-${index}`} maxLength={32} defaultValue={saved?.provider} placeholder="github / dingtalk" /></Field>
          <Field label={t('project.accountScope')}><Input name={`scope-${index}`} maxLength={128} defaultValue={saved?.scope} /></Field>
          <Field label={t('project.accountId')}><Input name={`account-${index}`} maxLength={128} defaultValue={saved?.accountId} /></Field>
        </div>
      })}
      {count < 10 && <Button variant="outline" onClick={() => setCount(count + 1)}>{t('project.addAccount')}</Button>}
    </div>
  </>
}
function memberValue(data: FormData): MemberInput {
  const accounts = Array.from({ length: 10 }, (_, index) => ({
    provider: field(data, `provider-${index}`), scope: field(data, `scope-${index}`), accountId: field(data, `account-${index}`),
  })).filter(account => account.provider || account.scope || account.accountId)
  return { name: field(data, 'name'), accounts }
}

type ProjectEditor = { revision: number } & ({ type: 'project' | 'member' | 'new-member' | 'issue' } | { type: 'task'; task?: ProjectTask }
  | { type: 'edit-member' | 'remove-member'; member: Member }
  | { type: 'review'; task: ProjectTask; outcome: 'accepted' | 'rejected' } | { type: 'delivery'; task: ProjectTask }
  | { type: 'link' | 'run'; task: ProjectTask } | { type: 'follow-up' | 'stop'; task: ProjectTask; ticket: ProjectTicket }
  | { type: 'milestone'; milestone?: ProjectMilestone } | { type: 'decision'; decision?: ProjectDecision })

function TaskFields({ t, task, project }: Basic & { task?: ProjectTask; project: ProjectDetail }) {
  return <>
    <Field label={t('project.taskTitle')}><Input name="title" required maxLength={200} defaultValue={task?.title} /></Field>
    <Field label={t('project.description')}><textarea className="dt-textarea" rows={3} name="description"
      defaultValue={task?.description} maxLength={26000} /></Field>
    <div className="dt-project-grid">
      <Status label={t('project.status')} value={task?.status ?? 'todo'} choices={TASK_STATES} translated={value => t(`project.state.${value}`)} />
      <Status label={t('project.priority')} name="priority" value={task?.priority ?? 'eliminate'} choices={PROJECT_PRIORITIES}
        translated={value => t(`project.priority.${value}`)} />
      <Field label={t('project.owner')}><select className="dt-select" name="ownerId" defaultValue={task?.ownerId ?? ''}>
        <option value="">{t('project.unassigned')}</option>
        {task?.ownerId && !project.members.some(member => member.id === task.ownerId) &&
          <option value={task.ownerId}>{t('project.formerMember')}</option>}
        {project.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
      </select></Field>
      <Field label={t('project.executionMode')}><select className="dt-select" name="executionMode" defaultValue={task?.executionMode ?? ''}>
        <option value="">{t('project.unassigned')}</option>
        <option value="manual">{t('project.executionMode.manual')}</option>
        <option value="agent">{t('project.executionMode.agent')}</option>
      </select></Field>
      <Field label={t('project.due')}><Input name="dueDate" type="date" defaultValue={task?.dueDate ?? ''} /></Field>
      <Field label={t('project.milestone')}><select className="dt-select" name="milestoneId" defaultValue={task?.milestoneId ?? ''}>
        <option value="">{t('empty')}</option>
        {project.milestones.map(milestone => <option key={milestone.id} value={milestone.id}>{milestone.title}</option>)}
      </select></Field>
    </div>
    {project.tasks.some(item => item.id !== task?.id) && <fieldset className="dt-project-dependencies">
      <legend>{t('project.dependencies')}</legend>
      {project.tasks.filter(item => item.id !== task?.id).map(item => <label key={item.id}>
        <input name="blockedBy" type="checkbox" value={item.id} defaultChecked={task?.blockedBy.includes(item.id)} /> {item.title}
      </label>)}
    </fieldset>}
    <Field label={t('project.acceptance')}><textarea className="dt-textarea" rows={3} name="acceptance"
      defaultValue={task?.acceptance} maxLength={26000} /></Field>
    <IssueField t={t} url={task?.issueUrl} />
    <div className="dt-project-grid">
      <Field label={t('project.issueRole')}><select className="dt-select" name="issueRole" defaultValue={task?.issueRole ?? 'reference'}>
        <option value="reference">{t('project.issueRole.reference')}</option><option value="resolve">{t('project.issueRole.resolve')}</option>
      </select></Field>
      <Field label={t('project.deliveryMode')}><select className="dt-select" name="deliveryMode" defaultValue={task?.deliveryMode ?? 'report'}>
        <option value="report">{t('project.deliveryMode.report')}</option><option value="pull-request">{t('project.deliveryMode.pull-request')}</option>
      </select></Field>
      <Field label={t('project.pullRequestUrl')}><Input name="pullRequestUrl" type="url" defaultValue={task?.pullRequestUrl ?? ''} /></Field>
      <Field label={t('project.targetBranch')}><Input name="targetBranch" defaultValue={task?.targetBranch ?? ''} /></Field>
    </div>
    <p className="dt-hint">{t('project.repositoryDeliveryHelp')}</p>
  </>
}
function taskValue(data: FormData) {
  return { title: field(data, 'title'), description: field(data, 'description'), status: field(data, 'status') as ProjectTask['status'],
    ownerId: optional(data, 'ownerId'), milestoneId: optional(data, 'milestoneId'), blockedBy: data.getAll('blockedBy').map(String),
    dueDate: optional(data, 'dueDate'), acceptance: field(data, 'acceptance'), issueUrl: optional(data, 'issueUrl'),
    executionMode: optional(data, 'executionMode') as ProjectTask['executionMode'],
    priority: field(data, 'priority') as ProjectPriority, issueRole: field(data, 'issueRole') as ProjectTask['issueRole'],
    deliveryMode: field(data, 'deliveryMode') as ProjectTask['deliveryMode'], pullRequestUrl: optional(data, 'pullRequestUrl'),
    targetBranch: optional(data, 'targetBranch') }
}

function IssueTaskFields({ t, call, canLookup, projectId }: Basic & { call: Call; canLookup: boolean; projectId: string }) {
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lookUp = async () => {
    setBusy(true)
    setError('')
    try {
      const issue = await call('GET projects/issue', { query: { url, projectId } })
      setUrl(issue.url)
      setTitle(issue.title)
    } catch (failure) { setError(errorText(failure)) }
    finally { setBusy(false) }
  }
  return <>
    <div className="dt-issue-input">
      <Field label={t('project.issue')}><Input name="issueUrl" type="url" required value={url}
        placeholder="https://github.com/owner/repo/issues/42" readOnly={busy} onChange={event => setUrl(event.target.value)} /></Field>
      {canLookup && <Button variant="outline" disabled={busy || !url.trim()} onClick={() => { void lookUp() }}>
        {t(busy ? 'loading' : 'project.lookupIssue')}</Button>}
    </div>
    {error && <p className="dt-error" role="alert">{error}</p>}
    <Field label={t('project.taskTitle')}><Input name="title" required maxLength={200} value={title} readOnly={busy}
      onChange={event => setTitle(event.target.value)} /></Field>
    <Field label={t('project.description')}><textarea className="dt-textarea" rows={3} name="description" maxLength={26000} /></Field>
  </>
}

function TaskList({ t, project, visible, selected, select }: Basic & {
  project: ProjectDetail; visible: ProjectTask[]; selected: string | undefined; select: (task: ProjectTask) => void
}) {
  const names = new Map(project.members.map(member => [member.id, member.name]))
  const tasks = new Map(project.tasks.map(task => [task.id, task]))
  return <div className="dt-work-items">
    {TASK_STATES.map(status => {
        const matching = visible.filter(task => task.status === status)
        if (!matching.length) return null
        return <section className="dt-work-group" key={status}>
          <h4>{t(`project.state.${status}`)} <span>{matching.length}</span></h4>
          {matching.map(task => <button className="dt-work-item" key={task.id} aria-pressed={task.id === selected} onClick={() => select(task)}>
            <strong>{task.title}</strong>
            <span className="dt-project-meta">
              {task.ownerId ? names.get(task.ownerId) ?? t('project.formerMember') : t('project.unassigned')}
              {task.dueDate && <time dateTime={task.dueDate}>{task.dueDate}</time>}
              {task.blockedBy.some(id => tasks.get(id)?.status !== 'done') && <Tag tone="warning">{t('project.blocked')}</Tag>}
              {task.ticketId && <Tag>{t('project.hasTicket')}</Tag>}
            </span>
          </button>)}
        </section>
      })}
  </div>
}

function TicketSelect({ t, call, ticketId, issue, related }: Basic & {
  call: Call; ticketId: string | null; issue: string | null; related: ProjectTicket[]
}) {
  const { data, error } = usePoll(() => call('GET projects/recent-tickets'), [call], 30_000)
  const tickets = [...new Map([...data ?? [], ...related].map(ticket => [ticket.id, ticket])).values()]
    .sort((a, b) => Number(!!issue && b.issueUrl === issue) - Number(!!issue && a.issueUrl === issue))
  const loaded = data !== undefined || related.length > 0
  return <>
    <Field label={t('project.tickets')}>
      <select className="dt-select" name="ticketId" defaultValue={ticketId ?? ''} disabled={!loaded}>
        <option value="">{t(!loaded ? 'loading' : 'project.noTicketChoice')}</option>
        {ticketId && !tickets.some(ticket => ticket.id === ticketId) && <option value={ticketId}>{ticketId.slice(0, 12)}</option>}
        {tickets.map(ticket => <option key={ticket.id} value={ticket.id}>{ticket.title} · {ticket.id.slice(0, 12)}</option>)}
      </select>
    </Field>
    {error && <p className="dt-error" role="alert">{error.message}</p>}
    {loaded && !tickets.length && <p className="dt-hint">{t('project.noAvailableTickets')}</p>}
  </>
}

function TaskDetail({ t, project, task, execution, pending, editor, move, openTicket, showTitle = true }: Basic & {
  project: ProjectDetail; task: ProjectTask; execution: ProjectExecution | undefined; pending: boolean; editor: (value: ProjectEditor) => void;
  move: (status: ProjectTask['status']) => void; openTicket?: (id: string) => void; showTitle?: boolean
}) {
  const issue = task.issueUrl
  const attempts = project.tickets.filter(ticket => ticket.id === task.ticketId || ticket.taskId === task.id)
  const current = attempts.find(ticket => ticket.id === task.ticketId) ?? attempts[0]
  const own = current?.taskId === task.id
  const blocked = task.blockedBy.some(id => project.tasks.find(dep => dep.id === id)?.status !== 'done')
  const waiting = project.decisions.filter(decision => decision.taskId === task.id && !decision.answeredAt)
  const matching = issue ? project.tickets.filter(ticket => ticket.issueUrl === issue && ticket.taskId !== task.id).length : 0
  const canStart = task.executionMode !== 'manual' && project.status === 'active' && (task.status === 'todo' || task.status === 'in-progress')
    && !blocked && !waiting.length && !attempts.some(ticket => !ticket.ended)
  const milestone = project.milestones.find(item => item.id === task.milestoneId)
  const owner = task.ownerId ? project.members.find(member => member.id === task.ownerId)?.name ?? t('project.formerMember') : t('project.unassigned')
  const base = { task, revision: project.revision }
  const [share, setShare] = useState<'copied' | 'manual'>()
  const context = taskContext(project, task, t('project.acceptance'))
  const review = currentReview(task)
  const copyContext = async () => {
    try { await navigator.clipboard.writeText(context); setShare('copied') }
    catch { setShare('manual') }
  }
  return <article className="dt-work-detail" aria-label={task.title}>
    <div className="dt-project-heading">
      {showTitle && <h3>{task.title}</h3>}
      <Tag>{t(`project.priority.${task.priority ?? 'eliminate'}`)}</Tag>
      <Button size="sm" variant="outline" onClick={() => editor({ ...base, type: 'task' })}>{t('project.editTask')}</Button>
    </div>
    <dl className="dt-work-task-properties">
      <div><dt>{t('project.owner')}</dt><dd>{owner}</dd></div>
      {task.executionMode && <div><dt>{t('project.executionMode')}</dt><dd>{t(`project.executionMode.${task.executionMode}`)}</dd></div>}
      {milestone && <div><dt>{t('project.milestone')}</dt><dd>{milestone.title}</dd></div>}
      {task.dueDate && <div><dt>{t('project.due')}</dt><dd><time dateTime={task.dueDate}>{task.dueDate}</time></dd></div>}
    </dl>
    {task.description && <p className="dt-project-description">{task.description}</p>}
    <ol className="dt-work-flow">
      <li><Icon name="external" /><div>
        <h4>{t('project.source')}</h4>
        {issue ? <Issue url={issue} /> : <div className="dt-work-actions">
          <span className="dt-hint">{t('project.noIssue')}</span>
          <Button variant="ghost" size="sm" onClick={() => editor({ ...base, type: 'task' })}>{t('project.addIssue')}</Button>
        </div>}
        <div className="dt-work-actions">
          <Button variant="outline" size="sm" onClick={() => { void copyContext() }}>{t('project.copyTaskContext')}</Button>
          {share === 'copied' && <span role="status">{t('copied')}</span>}
        </div>
        {share === 'manual' && <Field label={t('project.taskContext')}>
          <textarea className="dt-input" rows={5} readOnly value={context} onFocus={event => event.currentTarget.select()} />
        </Field>}
      </div></li>
      <li><Icon name="play" /><div>
        <h4>{t('project.agentExecution')}</h4>
        {current ? <div className="dt-work-ticket">
          <strong>{current.title}</strong><span className="dt-mono">#{current.id.slice(0, 12)}</span>
          {current.runner && <Tag>{current.runner}</Tag>}
          <Tag>{ticketLabel(t, current)}</Tag>
          {openTicket && <Button size="sm" onClick={() => openTicket(current.id)}>{t('project.openTicket')}</Button>}
        </div> : <p className="dt-hint">{matching ? t('project.matchingTickets', { count: matching }) : t('project.noLinkedTicket')}</p>}
        {blocked && <p className="dt-hint">{t('project.blocked')}</p>}
        {waiting.length > 0 && <div className="dt-work-actions"><span>{t('project.waitingDecision')}</span>
          {waiting.map(decision => <button key={decision.id} type="button" className="dt-project-task-title"
            onClick={() => editor({ type: 'decision', decision, revision: project.revision })}>{decision.question}</button>)}
        </div>}
        <div className="dt-work-actions">
          {canStart && execution?.state === 'ready' && <Button variant="primary" size="sm" onClick={() => editor({ ...base, type: 'run' })}>{t('project.run')}</Button>}
          <Button variant="outline" size="sm" onClick={() => editor({ ...base, type: 'link' })}>{t('project.linkTicket')}</Button>
          {current && own && !current.ended && execution?.state === 'ready' &&
            <Button size="sm" onClick={() => editor({ ...base, type: 'follow-up', ticket: current })}>{t('project.followUp')}</Button>}
          {current && own && !current.ended && execution && execution.state !== 'planning' &&
            <Button size="sm" onClick={() => editor({ ...base, type: 'stop', ticket: current })}>{t('project.stopRun')}</Button>}
        </div>
      </div></li>
      <li><Icon name="review" /><div>
        <h4>{t('project.result')}</h4>
        {current?.question && <p className="dt-banner">{current.question}</p>}
        {current?.summary ? <MarkdownContent t={t} text={current.summary} /> : <p className="dt-hint">{t('project.noReport')}</p>}
        {current?.pullUrls.map(url => <Issue key={url} url={url} />)}
        {task.acceptance && <p className="dt-project-description"><strong>{t('project.acceptance')}</strong><br />{task.acceptance}</p>}
        {task.executionMode !== 'agent' && ['todo', 'in-progress'].includes(task.status) &&
          <Button variant="outline" size="sm" disabled={pending} onClick={() => editor({ ...base, type: 'delivery' })}>{t('project.submitDelivery')}</Button>}
        {task.status === 'in-review' && review?.status === 'pending' && <div className="dt-work-actions">
          <Button variant="primary" size="sm" disabled={pending} onClick={() => editor({ ...base, type: 'review', outcome: 'accepted' })}>{t('project.acceptTask')}</Button>
          <Button variant="outline" size="sm" disabled={pending} onClick={() => editor({ ...base, type: 'review', outcome: 'rejected' })}>{t('project.rejectDelivery')}</Button>
        </div>}
        {!!task.reviews?.length && <section aria-label={t('project.deliveryHistory')}>
          <h4>{t('project.deliveryHistory')}</h4>
          {[...task.reviews].reverse().map(item => <details key={item.id} open={item.id === review?.id}>
            <summary>{t('project.deliveryVersion', { version: item.version })} · {t(`project.review.${item.status}`)}</summary>
            <p className="dt-hint">{t('project.reviewReference')}: {item.id}</p>
            <MarkdownContent t={t} text={item.evidence.summary} />
            {item.evidence.links.map(url => <p key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a></p>)}
            <p><strong>{t('project.acceptance')}</strong><br />{item.requirements.acceptance}</p>
            {item.decision && <p>{t('project.reviewReason')}: {item.decision.reason}<br />
              {item.decision.actorId ? project.members.find(member => member.id === item.decision!.actorId)?.name ?? t('project.formerMember') : t('project.localOperator')}
              {' · '}<time dateTime={item.decision.at}>{new Date(item.decision.at).toLocaleString()}</time></p>}
          </details>)}
        </section>}
      </div></li>
    </ol>
    <label className="dt-work-status"><span>{t('project.status')}</span>
      <select className="dt-select" disabled={pending} aria-label={t('project.move', { title: task.title })} value={task.status}
        onChange={event => move(event.target.value as ProjectTask['status'])}>
        {TASK_STATES.map(state => <option key={state} value={state}
          disabled={state === 'done' && review?.status !== 'pending' || state === 'in-review' && task.executionMode === 'agent'}>{t(`project.state.${state}`)}</option>)}
      </select>
    </label>
  </article>
}

function ProjectWorkspace({ t, call, id, directory, openTicket, changed, directoryChanged, execution,
  section, selectSection }: Basic & {
  call: Call; id: string; directory: Member[]; openTicket?: (id: string) => void; changed: () => Promise<void>
  directoryChanged: () => Promise<void>; execution: ProjectExecution | undefined
  section: ProjectSection; selectSection: (section: ProjectSection) => void
}) {
  const { data: project, error, reload } = usePoll(() => call('GET projects/:id', { id }), [call, id])
  const [editor, setEditor] = useState<ProjectEditor>()
  const [view, setView] = useState<TaskView>('kanban')
  const [query, setQuery] = useState('')
  const [owner, setOwner] = useState('')
  const [milestoneFilter, setMilestoneFilter] = useState('')
  const [selectedTask, setSelectedTask] = useState<string>()
  const [inspecting, setInspecting] = useState(false)
  const [failure, setFailure] = useState('')
  const [pending, setPending] = useState(false)
  const [planFeedback, setPlanFeedback] = useState('')
  if (!project) return <p role={error ? 'alert' : 'status'}>{error?.message ?? t('loading')}</p>
  const needle = query.trim().toLowerCase()
  const issueReference = ISSUE_REFERENCE.exec(needle)
  const issueNumber = ISSUE_NUMBER.exec(needle)?.[1]
  const memberIds = new Set(project.members.map(member => member.id))
  const selectedOwner = owner === 'unassigned' || owner === 'former' || memberIds.has(owner) ? owner : ''
  const taskOwner = (task: ProjectTask) => {
    if (!task.ownerId) return 'unassigned'
    return memberIds.has(task.ownerId) ? task.ownerId : 'former'
  }
  const hasFormerOwner = project.tasks.some(task => taskOwner(task) === 'former')
  const visible = project.tasks.filter(task => {
    if (selectedOwner && taskOwner(task) !== selectedOwner) return false
    if (milestoneFilter && task.milestoneId !== milestoneFilter) return false
    if (!needle) return true
    const issueUrl = task.issueUrl?.toLowerCase() ?? ''
    if (issueReference) return issueUrl === `https://github.com/${issueReference[1]}/issues/${issueReference[2]}`
    if (issueNumber) return issueUrl.endsWith(`/issues/${issueNumber}`)
    return [task.title, task.description, issueUrl, issueUrl.replace('/issues/', '#')]
      .some(text => text.toLowerCase().includes(needle))
  })
  const selected = project.tasks.find(task => task.id === selectedTask)
  const listTask = visible.find(task => task.id === selectedTask) ?? visible.find(task => task.status !== 'done' && task.status !== 'cancelled') ?? visible[0]
  const inspect = (task: ProjectTask) => { setSelectedTask(task.id); setInspecting(true) }
  const filterTasks = (memberId: string, milestoneId: string) => {
    setOwner(memberId); setMilestoneFilter(milestoneId); setQuery(''); setInspecting(false); selectSection('tasks')
  }
  const close = () => setEditor(undefined)
  const commit = async (write: Promise<ProjectDetail>) => {
    let next: ProjectDetail
    try { next = await write }
    catch (error) { await reload(); throw error }
    await Promise.all([reload(), changed()])
    return next
  }
  const save = (change: Change, revision = project.revision) => commit(call('POST projects/:id/changes', { id, body: { revision, change } }))
  const action = async (change: Change) => {
    if (pending) return
    setPending(true); setFailure('')
    try { await save(change) } catch (error) { setFailure(errorText(error)) } finally { setPending(false) }
  }
  const moveTask = (task: ProjectTask, status: ProjectTask['status']) => {
    if (status === task.status) return
    if (status === 'done') { setEditor({ type: 'review', task, outcome: 'accepted', revision: project.revision }); return }
    if (status === 'in-review') { setEditor({ type: 'delivery', task, revision: project.revision }); return }
    if (task.status === 'in-review' && status === 'in-progress') { setEditor({ type: 'review', task, outcome: 'rejected', revision: project.revision }); return }
    void action({ kind: 'task-status', id: task.id, status })
  }
  const updatePlan = async () => {
    if (pending) return
    setPending(true); setFailure(''); setPlanFeedback('')
    try {
      const result = await call('POST projects/:id/plan', { id, body: {} })
      setPlanFeedback(result.text)
      await Promise.all([reload(), changed()])
    } catch (error) { setFailure(errorText(error)) } finally { setPending(false) }
  }
  const renderTask = (task: ProjectTask, showTitle: boolean) => <TaskDetail key={task.id}
    t={t} project={project} task={task} execution={execution} pending={pending} editor={setEditor} openTicket={openTicket}
    showTitle={showTitle} move={status => moveTask(task, status)} />
  const taskCounts = [project.tasks.filter(task => task.status !== 'cancelled').length,
    project.tasks.filter(task => task.status === 'in-progress').length, project.tasks.filter(task => task.status === 'in-review').length,
    project.tasks.filter(task => task.status === 'done').length]
  let dialog: ReactNode
  switch (editor?.type) {
    case 'project': dialog = <Editor t={t} title={t('project.edit')} close={close}
      save={data => save({ kind: 'project', value: projectValue(data) }, editor.revision)}><ProjectFields t={t} project={project} /></Editor>; break
    case 'new-member': dialog = <Editor t={t} title={t('project.newMember')} close={close}
      save={async data => { await save({ kind: 'new-member', value: memberValue(data) }, editor.revision); await directoryChanged() }}>
      <MemberFields t={t} />
    </Editor>; break
    case 'edit-member': dialog = <Editor t={t} title={t('project.editMember')} close={close}
      save={async data => {
        await call('PUT members/:id', { id: editor.member.id, body: memberValue(data) })
        await Promise.all([reload(), directoryChanged()])
      }}>
      <p className="dt-hint">{t('project.sharedMemberHelp')}</p>
      <MemberFields t={t} member={editor.member} />
    </Editor>; break
    case 'remove-member': dialog = <Editor t={t} title={t('project.removeMember', { name: editor.member.name })} close={close}
      submitLabel={t('project.remove')} save={async () => {
        await save({ kind: 'remove-member', memberId: editor.member.id }, editor.revision)
        if (owner === editor.member.id) setOwner('')
      }}>
      <p className="dt-hint">{t('project.removeMemberHelp')}</p>
    </Editor>; break
    case 'member': dialog = <Editor t={t} title={t('project.addMember')} close={close}
      save={data => save({ kind: 'add-member', memberId: field(data, 'memberId') }, editor.revision)}>
      <Field label={t('project.memberName')}><select className="dt-select" name="memberId" required defaultValue="">
        <option value="">{t('project.chooseMember')}</option>
        {directory.filter(member => !project.memberIds.includes(member.id)).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
      </select></Field>
    </Editor>; break
    case 'delivery': dialog = <Editor t={t} title={t('project.submitDelivery')} close={close} save={async data => {
      await call('POST projects/:id/tasks/:taskId/deliveries', { id, taskId: editor.task.id,
        body: { messageId: field(data, 'messageId'), summary: field(data, 'summary'), links: field(data, 'links').split(/\s+/).filter(Boolean) } })
      await Promise.all([reload(), changed()])
    }}>
      <p>{editor.task.title}</p>
      <Field label={t('project.deliverySummary')}><textarea className="dt-textarea" name="summary" required maxLength={12000} rows={5} /></Field>
      <Field label={t('project.deliveryLinks')}><textarea className="dt-textarea" name="links" rows={3} /></Field>
    </Editor>; break
    case 'review': dialog = <Editor t={t} title={t(editor.outcome === 'accepted' ? 'project.acceptTask' : 'project.rejectDelivery')} close={close}
      save={async data => {
        const review = currentReview(editor.task)
        if (!review) throw new Error(t('project.noCurrentReview'))
        await call('POST projects/:id/tasks/:taskId/reviews/:reviewId', { id, taskId: editor.task.id, reviewId: review.id,
          body: { messageId: field(data, 'messageId'), outcome: editor.outcome, reason: field(data, 'reason') } })
        await Promise.all([reload(), changed()])
      }}>
      <p>{editor.task.title} · {t('project.deliveryVersion', { version: currentReview(editor.task)?.version ?? 0 })}</p>
      <p>{currentReview(editor.task)?.requirements.acceptance}</p>
      <Field label={t('project.reviewReason')}><textarea className="dt-textarea" name="reason" required maxLength={8000} rows={4} /></Field>
      <p className="dt-hint">{t('project.localReviewHelp')}</p>
    </Editor>; break
    case 'task': dialog = <Editor t={t} title={t(editor.task ? 'project.editTask' : 'project.addTask')} close={close}
      save={async data => {
        const next = await save({ kind: 'task', id: editor.task?.id, value: { ...taskValue(data), ticketId: editor.task?.ticketId } }, editor.revision)
        const saved = next.tasks.find(task => task.id === editor.task?.id) ?? next.tasks.at(-1)
        if (saved) inspect(saved)
      }}>
      <TaskFields t={t} project={project} task={editor.task} />
    </Editor>; break
    case 'issue': dialog = <Editor t={t} title={t('project.issueTask')} close={close}
      save={async data => {
        const next = await save({ kind: 'task', value: { title: field(data, 'title'), issueUrl: field(data, 'issueUrl'),
          description: field(data, 'description') } }, editor.revision)
        const task = next.tasks.at(-1)
        if (task) inspect(task)
      }}>
      <IssueTaskFields t={t} call={call} canLookup={!!project.repository} projectId={id} />
    </Editor>; break
    case 'link': dialog = <Editor t={t} title={t('project.linkTicket')} close={close} save={data => {
      if (!data.has('ticketId')) throw new Error(t('project.waitForTickets'))
      return save({ kind: 'task-ticket', id: editor.task.id, ticketId: optional(data, 'ticketId') }, editor.revision)
    }}>
      <p className="dt-hint">{t('project.linkHelp')}</p>
      <TicketSelect t={t} call={call} ticketId={editor.task.ticketId} issue={editor.task.issueUrl} related={project.tickets} />
    </Editor>; break
    case 'run': dialog = <Editor t={t} title={t('project.run')} close={close} submitLabel={t('project.confirmRun')}
      save={() => commit(call('POST projects/:id/tasks/:taskId/run', { id, taskId: editor.task.id, body: { revision: editor.revision } }))}>
      <strong>{editor.task.title}</strong>
      <p className="dt-project-description">{project.repository ? t('project.runHelp', { repository: project.repository }) : t('project.runWithoutRepository')}</p>
      {editor.task.description && <p className="dt-project-description">{editor.task.description}</p>}
    </Editor>; break
    case 'follow-up': dialog = <Editor t={t} title={t('project.followUp')} close={close} submitLabel={t('project.send')}
      save={data => commit(call('POST projects/:id/tasks/:taskId/follow-up', { id, taskId: editor.task.id,
        body: { ticketId: editor.ticket.id, text: field(data, 'text') } }))}>
      {editor.ticket.question && <p className="dt-banner">{editor.ticket.question}</p>}
      <Field label={t('project.followUpText')}><textarea autoFocus required className="dt-textarea" name="text" rows={5} maxLength={8000} /></Field>
    </Editor>; break
    case 'stop': dialog = <Editor t={t} title={t('project.stopRun')} close={close} submitLabel={t('project.stopRun')}
      save={() => commit(call('POST projects/:id/tasks/:taskId/stop', { id, taskId: editor.task.id, body: { ticketId: editor.ticket.id } }))}>
      <p className="dt-project-description">{t('project.stopHelp')}</p>
    </Editor>; break
    case 'milestone': dialog = <Editor t={t} title={t(editor.milestone ? 'project.editMilestone' : 'project.addMilestone')} close={close}
      save={data => save({ kind: 'milestone', id: editor.milestone?.id, value: { title: field(data, 'title'), dueDate: optional(data, 'dueDate'),
        status: field(data, 'status') as ProjectMilestone['status'] } }, editor.revision)}>
      <Field label={t('project.name')}><Input name="title" defaultValue={editor.milestone?.title} required maxLength={200} /></Field>
      <Field label={t('project.due')}><Input name="dueDate" type="date" defaultValue={editor.milestone?.dueDate ?? ''} /></Field>
      <Status label={t('project.status')} choices={MILESTONE_STATES} value={editor.milestone?.status ?? 'open'}
        translated={value => t(`project.state.${value}`)} />
    </Editor>; break
    case 'decision': dialog = <Editor t={t} title={t(!editor.decision ? 'project.addDecision'
      : editor.decision.answeredAt ? 'project.editDecision' : 'project.resolveDecision')} close={close}
      save={data => save({ kind: 'decision', id: editor.decision?.id,
        value: { question: field(data, 'question'), context: field(data, 'context'), answer: field(data, 'answer'), taskId: optional(data, 'taskId') } }, editor.revision)}>
      <Field label={t('project.question')}><Input name="question" defaultValue={editor.decision?.question} required maxLength={500} /></Field>
      <Field label={t('project.relatedTask')}><select className="dt-select" name="taskId" defaultValue={editor.decision?.taskId ?? ''}>
        <option value="">{t('project.projectWide')}</option>
        {project.tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
      </select></Field>
      <Field label={t('project.context')}><textarea className="dt-textarea" name="context" rows={3} defaultValue={editor.decision?.context} maxLength={26000} /></Field>
      <Field label={t('project.answer')}><textarea className="dt-textarea" name="answer" rows={3} defaultValue={editor.decision?.answer} maxLength={8000} /></Field>
    </Editor>; break
  }
  const revision = project.revision
  const addable = directory.some(member => !project.memberIds.includes(member.id))
  return <>
    <header className="dt-work-header" data-compact={section !== 'tasks'}>
      <div className="dt-page-title"><h2>{project.name}</h2><Tag tone={project.status === 'active' ? 'success' : 'outline'}>{t(`project.state.${project.status}`)}</Tag>
        <Button variant="outline" size="sm" onClick={() => setEditor({ type: 'project', revision })}>{t('project.edit')}</Button></div>
      {section === 'tasks' && <>
        {project.repository && <a href={`https://github.com/${project.repository}`} target="_blank" rel="noreferrer"
          className="dt-project-link"><Icon name="external" size={13} />{project.repository}</a>}
        {project.objective && <p className="dt-work-objective">{project.objective}</p>}
        {project.description && <p className="dt-project-description">{project.description}</p>}
        {project.status === 'planning' && <p className="dt-hint">{t('project.waitingForKickoff')}</p>}
        {project.issueUrl && <span className="dt-project-meta">{t('project.pastIssue')} <Issue url={project.issueUrl} /></span>}
      </>}
    </header>
    {(failure || error) && <p className="dt-error" role="alert">{failure || error?.message}</p>}
    {section === 'members' && <ProjectMembers t={t} project={project} canAdd={addable} pending={pending}
      create={() => setEditor({ type: 'new-member', revision })} add={() => setEditor({ type: 'member', revision })}
      edit={member => setEditor({ type: 'edit-member', revision, member })} remove={member => setEditor({ type: 'remove-member', revision, member })}
      showTasks={member => filterTasks(member.id, '')} />}
    {section === 'milestones' && <ProjectMilestones t={t} project={project}
      edit={milestone => setEditor({ type: 'milestone', revision, milestone })} showTasks={milestone => filterTasks('', milestone.id)} />}
    {section === 'decisions' && <ProjectDecisions t={t} project={project}
      updatePlan={execution?.planner ? () => { void updatePlan() } : undefined} planning={pending} planFeedback={planFeedback}
      edit={decision => setEditor({ type: 'decision', revision, decision })} inspect={inspect} />}
    {section === 'history' && <ProjectHistory call={call} t={t} project={project} />}
    {section === 'tickets' && <ProjectTickets t={t} project={project} inspect={inspect} openTicket={openTicket} />}
    {section === 'tasks' && <>
      {!!project.tasks.length && <dl className="dt-project-stats">
      {(['project.tasks', 'project.state.in-progress', 'project.state.in-review', 'project.state.done'] as const).map((key, i) =>
        <div key={key}><dt>{t(key)}</dt><dd>{taskCounts[i]}</dd></div>)}
    </dl>}
    <section className="dt-work-area">
      <div className="dt-project-heading"><h3>{t('project.tasks')}</h3>
        <div className="dt-work-actions">
          <Button variant="outline" icon={<Icon name="external" size={14} />} onClick={() => setEditor({ type: 'issue', revision: project.revision })}>{t('project.issueTask')}</Button>
          <Button variant="primary" icon={<Icon name="plus" />} onClick={() => setEditor({ type: 'task', revision: project.revision })}>{t('project.addTask')}</Button>
        </div>
      </div>
      <div className="dt-work-toolbar">
        <div className="dt-work-views" role="group" aria-label={t('project.taskViews')}>
          {TASK_VIEWS.map(choice => <Button key={choice} size="sm" aria-pressed={view === choice}
            onClick={() => setView(choice)}>{t(`project.view.${choice}`)}</Button>)}
        </div>
        {!!project.tasks.length && <div className="dt-work-filters">
          <Input type="search" icon={<Icon name="search" size={14} />} aria-label={t('project.findTask')} placeholder={t('project.findTask')}
            value={query} onChange={event => setQuery(event.target.value)} />
          <select className="dt-select" aria-label={t('project.owner')} value={selectedOwner} onChange={event => setOwner(event.target.value)}>
            <option value="">{t('project.allOwners')}</option>
            <option value="unassigned">{t('project.unassignedOwner')}</option>
            {project.members.map(member => <option value={member.id} key={member.id}>{member.name}</option>)}
            {(hasFormerOwner || owner === 'former') && <option value="former">{t('project.formerMember')}</option>}
          </select>
          {!!project.milestones.length && <select className="dt-select" aria-label={t('project.milestone')} value={milestoneFilter}
            onChange={event => setMilestoneFilter(event.target.value)}>
            <option value="">{t('project.allMilestones')}</option>
            {project.milestones.map(milestone => <option value={milestone.id} key={milestone.id}>{milestone.title}</option>)}
          </select>}
        </div>}
      </div>
      {!project.tasks.length ? <div className="dt-work-empty"><Icon name="queue" size={24} /><p>{t('project.firstTask')}</p></div>
        : !visible.length ? <div className="dt-work-empty"><p>{t('project.noMatchingTasks')}</p>
          <Button variant="outline" size="sm" onClick={() => filterTasks('', '')}>{t('project.clearFilters')}</Button></div>
          : view === 'list' && listTask ? <div className="dt-work-columns">
            <TaskList t={t} project={project} visible={visible} selected={listTask.id} select={task => {
              setSelectedTask(task.id); setInspecting(false)
            }} />
            {renderTask(listTask, true)}
          </div>
            : view !== 'list' && <ProjectBoard t={t} project={project} view={view} tasks={visible} pending={pending}
              select={inspect} moveStatus={moveTask}
              movePriority={(task, priority) => { void action({ kind: 'task-priority', id: task.id, priority }) }} />}
    </section>
    </>}
    {(section !== 'tasks' || view !== 'list') && selected && inspecting && !editor && <Modal open title={selected.title} closeLabel={t('close')}
      className="dt-task-inspector" onClose={() => setInspecting(false)}>
      {failure && <p className="dt-error" role="alert">{failure}</p>}
      {renderTask(selected, false)}
    </Modal>}
    {dialog}
  </>
}

export function ProjectsPage({ t, call, openTicket, openExecution }: Basic & { call: Call; openTicket?: (id: string) => void; openExecution?: () => void }) {
  const [selected, setSelected] = useState<string>()
  const [section, setSection] = useState<ProjectSection>('tasks')
  const [area, setArea] = useState<'project' | 'directory' | 'agent'>('project')
  const [creating, setCreating] = useState(false)
  const [member, setMember] = useState<Member | null>()
  const [memberToDelete, setMemberToDelete] = useState<Member>()
  const projects = usePoll(() => call('GET projects'), [call])
  const directory = usePoll(() => call('GET members'), [call])
  const execution = usePoll(() => call('GET projects/execution'), [call])
  const issue = area === 'project' ? projects.error ?? directory.error : area === 'directory' ? directory.error : undefined
  const selection = projects.data?.find(project => project.id === selected)?.id
    ?? projects.data?.find(project => project.status === 'active')?.id ?? projects.data?.[0]?.id
  const current = projects.data?.find(project => project.id === selection)
  return <div className="dt-projects">
    <aside className="dt-work-nav">
      <nav className="dt-work-global" aria-label={t('project.workspaceNavigation')}>
        <button type="button" className="dt-work-section-link" aria-current={area === 'agent' ? 'page' : undefined} onClick={() => setArea('agent')}>
          <Icon name="session" size={15} />{t('project.agentStatus')}
        </button>
        <button type="button" className="dt-work-section-link" aria-current={area === 'directory' ? 'page' : undefined} onClick={() => setArea('directory')}>
          <Icon name="user" size={15} />{t('project.directory')}
        </button>
      </nav>
      <div className="dt-project-heading"><h2>{t('tab.projects')}</h2>
        <Button variant="outline" size="sm" icon={<Icon name="plus" />} aria-label={t('project.create')} title={t('project.create')}
          onClick={() => setCreating(true)} /></div>
      <nav aria-label={t('tab.projects')}>
        {projects.data?.map(project =>
          <button key={project.id} className="dt-work-nav-item" aria-current={area === 'project' && selection === project.id ? 'true' : undefined}
            onClick={() => { if (selection !== project.id) setSection('tasks'); setSelected(project.id); setArea('project') }}>
            <strong>{project.name}</strong>
            <span>{t('project.taskCount', { done: project.completedCount, total: project.taskCount })}</span>
          </button>)}
      </nav>
      {selection && area === 'project' && <nav className="dt-work-sections" aria-label={t('project.navigation')}>
        <h3>{t('project.navigation')}</h3>
        {SECTIONS.map(item => <button key={item} type="button" className="dt-work-section-link"
          aria-current={section === item ? 'page' : undefined} onClick={() => setSection(item)}>
          <Icon name={SECTION_ICONS[item]} size={15} />
          <span>{t(`project.${item}`)}</span>
          {item === 'decisions' && !!current?.pendingCount && <span className="dt-work-nav-count" title={t('project.pending')}>{current.pendingCount}</span>}
        </button>)}
      </nav>}
    </aside>
    <div className="dt-work-main">
      {issue && <p className="dt-error" role="alert">{issue.message}</p>}
      {area === 'agent' ? <AgentStatus t={t} call={call} execution={execution.data} error={execution.error} openExecution={openExecution} />
        : area === 'directory' ? <section className="dt-card dt-project-panel">
        <div className="dt-project-heading"><h2>{t('project.directory')}</h2>
          <Button variant="primary" size="sm" icon={<Icon name="plus" />} onClick={() => setMember(null)}>{t('project.newMember')}</Button></div>
        {directory.data?.length === 0 && <p className="dt-hint">{t('project.directoryEmpty')}</p>}
        {!!directory.data?.length && <ul className="dt-project-records">{directory.data.map(person => <li key={person.id} className="dt-project-record">
          <div className="dt-project-record-head"><span className="dt-project-avatar"><Icon name="user" /></span>
            <div className="dt-project-record-main"><h4>{person.name}</h4></div>
            <Button variant="outline" size="sm" onClick={() => setMember(person)}>{t('project.editMember')}</Button>
            <Button size="sm" onClick={() => setMemberToDelete(person)}>{t('project.deleteMember')}</Button>
          </div>
          {person.accounts.length > 0 && <div className="dt-project-meta"><span>{t('project.unverifiedAccounts')}</span>
            {person.accounts.map(account => <Tag key={JSON.stringify(account)} tone="quiet">
              {account.provider}{account.scope && ` · ${account.scope}`} · {account.accountId}</Tag>)}</div>}
        </li>)}</ul>}
      </section> : selection ? <ProjectWorkspace key={selection} t={t} call={call} id={selection} directory={directory.data ?? []}
        openTicket={openTicket} changed={projects.reload} directoryChanged={directory.reload}
        execution={execution.error ? undefined : execution.data} section={section} selectSection={setSection} />
        : projects.data ? <section className="dt-work-empty dt-work-welcome">
          <Icon name="inbox" size={28} /><h2>{t('project.noProjects')}</h2><p>{t('project.welcome')}</p>
          <Button variant="primary" icon={<Icon name="plus" />} onClick={() => setCreating(true)}>{t('project.create')}</Button>
        </section> : !issue && <p className="dt-hint">{t('loading')}</p>}
    </div>
    {creating && <Editor t={t} title={t('project.create')} close={() => setCreating(false)} save={async data => {
      const project = await call('POST projects', { body: projectValue(data) })
      setSelected(project.id); setSection('tasks'); setArea('project'); await projects.reload()
    }}><ProjectFields t={t} /></Editor>}
    {member !== undefined && <Editor t={t} title={t(member ? 'project.editMember' : 'project.newMember')} close={() => setMember(undefined)}
      save={async data => { const body = memberValue(data)
        if (member) await call('PUT members/:id', { id: member.id, body })
        else await call('POST members', { body })
        await directory.reload()
      }}><MemberFields t={t} member={member ?? undefined} /></Editor>}
    {memberToDelete && <Editor t={t} title={t('project.deleteMemberTitle', { name: memberToDelete.name })}
      close={() => setMemberToDelete(undefined)} submitLabel={t('project.confirmDeleteMember')} save={async () => {
        await call('DELETE members/:id', { id: memberToDelete.id })
        await Promise.all([directory.reload(), projects.reload()])
      }}><p className="dt-hint">{t('project.deleteMemberHelp')}</p></Editor>}
  </div>
}
