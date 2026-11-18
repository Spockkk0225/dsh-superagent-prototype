import type { Member, ProjectDecision, ProjectDetail, ProjectMilestone, ProjectTask, ProjectTicket } from '../app/projects.ts'
import { Button, Icon, Tag } from './controls.tsx'
import { fullTime, when, type T } from './text.ts'
import { MarkdownContent } from './widgets.tsx'

export function Issue({ url }: { url: string }) {
  return <a href={url} target="_blank" rel="noreferrer" className="dt-project-link">
    <Icon name="external" size={13} />{url.slice('https://github.com/'.length).replace('/issues/', '#').replace('/pull/', ' PR #')}
  </a>
}

export const ticketLabel = (t: T, ticket: ProjectTicket) => {
  if (ticket.stage === 'ended') return t('ticket.ended')
  if (ticket.stage === 'person') return t(`stage.${ticket.action}`)
  return t(ticket.stage === 'idle' ? 'stage.idle' : ticket.action === 'queued' ? 'stage.queued' : 'stage.working')
}

export function ProjectMembers({ t, project, canAdd, pending, create, add, edit, remove, showTasks }: {
  t: T; project: ProjectDetail; canAdd: boolean; pending: boolean; create: () => void; add: () => void;
  edit: (member: Member) => void; remove: (member: Member) => void; showTasks: (member: Member) => void
}) {
  return <section className="dt-card dt-project-panel">
    <div className="dt-project-heading"><h3>{t('project.members')}</h3><div className="dt-work-actions">
      {canAdd && <Button variant="outline" size="sm" onClick={add}>{t('project.addMember')}</Button>}
      <Button variant="primary" size="sm" icon={<Icon name="plus" size={14} />} onClick={create}>{t('project.newMember')}</Button>
    </div></div>
    <p className="dt-hint">{t(project.members.length ? 'project.membersHelp' : 'project.membersEmptyHelp')}</p>
    {!!project.members.length && <ul className="dt-project-records">{project.members.map(member => {
      const tasks = project.tasks.filter(task => task.ownerId === member.id)
      const active = tasks.filter(task => task.status !== 'done' && task.status !== 'cancelled').length
      return <li key={member.id} className="dt-project-record">
        <div className="dt-project-record-head">
          <span className="dt-project-avatar"><Icon name="user" /></span>
          <div className="dt-project-record-main"><h4>{member.name}</h4><span className="dt-project-meta">
            {t('project.memberWorkload', { active, total: tasks.length })}</span></div>
          <div className="dt-work-actions">
            {tasks.length > 0 && <Button size="sm" onClick={() => showTasks(member)}>{t('project.viewTasks')}</Button>}
            <Button size="sm" variant="outline" onClick={() => edit(member)}>{t('project.editMember')}</Button>
            <Button size="sm" aria-label={t('project.removeMember', { name: member.name })} disabled={pending || active > 0}
              onClick={() => remove(member)}>{t('project.remove')}</Button>
          </div>
        </div>
        {active > 0 && <p className="dt-hint">{t('project.reassignBeforeRemove')}</p>}
        {member.accounts.length > 0 ? <div className="dt-project-meta">
          <span>{t('project.unverifiedAccounts')}</span>
          {member.accounts.map(account => <Tag key={JSON.stringify(account)} tone="quiet">
            {account.provider}{account.scope && ` · ${account.scope}`} · {account.accountId}</Tag>)}
        </div> : <span className="dt-project-meta">{t('project.noAccounts')}</span>}
      </li>
    })}</ul>}
  </section>
}

export function ProjectMilestones({ t, project, edit, showTasks }: {
  t: T; project: ProjectDetail; edit: (milestone?: ProjectMilestone) => void; showTasks: (milestone: ProjectMilestone) => void
}) {
  return <section className="dt-card dt-project-panel">
    <div className="dt-project-heading"><h3>{t('project.milestones')}</h3>
      <Button variant="primary" size="sm" icon={<Icon name="plus" size={14} />} onClick={() => edit()}>{t('project.addMilestone')}</Button></div>
    <p className="dt-hint">{t(project.milestones.length ? 'project.milestonesHelp' : 'project.milestonesEmpty')}</p>
    {!!project.milestones.length && <ul className="dt-project-records">{project.milestones.map(milestone => {
      const tasks = project.tasks.filter(task => task.milestoneId === milestone.id && task.status !== 'cancelled')
      const done = tasks.filter(task => task.status === 'done').length
      return <li key={milestone.id} className="dt-project-record">
        <div className="dt-project-record-head">
          <div className="dt-project-record-main"><h4>{milestone.title}</h4>
            <div className="dt-project-meta"><Tag tone={milestone.status === 'done' ? 'success' : 'quiet'}>{t(`project.state.${milestone.status}`)}</Tag>
              {milestone.dueDate ? <time dateTime={milestone.dueDate}>{t('project.dueOn', { date: milestone.dueDate })}</time> : t('project.noDueDate')}
            </div></div>
          <div className="dt-work-actions">
            <Button size="sm" onClick={() => showTasks(milestone)}>{t('project.viewTasks')}</Button>
            <Button size="sm" variant="outline" onClick={() => edit(milestone)}>{t('project.editMilestone')}</Button>
          </div>
        </div>
        {tasks.length > 0 ? <label className="dt-milestone-progress"><span>{t('project.taskCount', { done, total: tasks.length })}</span>
          <progress max={tasks.length} value={done} /></label> : <p className="dt-hint">{t('project.milestoneNoTasks')}</p>}
      </li>
    })}</ul>}
  </section>
}

export function ProjectDecisions({ t, project, edit, inspect, updatePlan, planning, planFeedback }: {
  t: T; project: ProjectDetail; edit: (decision?: ProjectDecision) => void; inspect: (task: ProjectTask) => void
  updatePlan?: () => void; planning?: boolean; planFeedback?: string
}) {
  const decisions = [...project.decisions].sort((a, b) => Number(!!a.answeredAt) - Number(!!b.answeredAt)
    || (b.answeredAt ?? '').localeCompare(a.answeredAt ?? ''))
  return <section className="dt-card dt-project-panel">
    <div className="dt-project-heading"><h3>{t('project.decisions')}</h3>
      <div className="dt-work-actions">
        {updatePlan && decisions.some(decision => decision.meetingReplies !== undefined) &&
          <Button size="sm" variant="outline" disabled={planning} onClick={updatePlan}>{t(planning ? 'loading' : 'project.updatePlan')}</Button>}
        <Button variant="primary" size="sm" icon={<Icon name="plus" size={14} />} onClick={() => edit()}>{t('project.addDecision')}</Button>
      </div></div>
    {planFeedback && <p role="status" className="dt-project-description">{planFeedback}</p>}
    <p className="dt-hint">{t(decisions.length ? 'project.decisionsHelp' : 'project.decisionsEmpty')}</p>
    {!!decisions.length && <ul className="dt-project-records">{decisions.map(decision => {
      const task = project.tasks.find(item => item.id === decision.taskId)
      return <li key={decision.id} className="dt-project-record">
        <div className="dt-project-record-head">
          <div className="dt-project-record-main"><h4>{decision.question}</h4><div className="dt-project-meta">
            <Tag tone={decision.answeredAt ? 'success' : 'warning'}>{t(decision.answeredAt ? 'project.answered' : 'project.pending')}</Tag>
            {decision.answeredAt && <time dateTime={decision.answeredAt} title={fullTime(decision.answeredAt, t('lang'))}>
              {when(decision.answeredAt, t('lang'))}</time>}
            {task ? <button type="button" className="dt-project-task-title" onClick={() => inspect(task)}>{task.title}</button>
              : t('project.projectWide')}
          </div></div>
          <Button size="sm" variant="outline" onClick={() => edit(decision)}>
            {t(decision.answeredAt ? 'project.editDecision' : 'project.resolveDecision')}
          </Button>
        </div>
        {decision.context && <details className="dt-project-disclosure"><summary>{t('project.context')}</summary>
          <MarkdownContent t={t} text={decision.context} /></details>}
        {!!decision.meetingReplies?.length && <div className="dt-project-answer">
          <strong>{t('project.meetingReplies', { count: decision.meetingReplies.length })}</strong>
          <ul className="dt-project-records">{decision.meetingReplies.map(reply => <li key={reply.triggerId}>
            <strong>{reply.name}</strong> <time className="dt-project-meta" dateTime={reply.at} title={fullTime(reply.at, t('lang'))}>
              {when(reply.at, t('lang'))}</time>
            <MarkdownContent t={t} text={reply.text} />
          </li>)}</ul>
        </div>}
        {decision.answer && <div className="dt-project-answer"><strong>{t('project.answer')}</strong>
          <MarkdownContent t={t} text={decision.answer} /></div>}
      </li>
    })}</ul>}
  </section>
}

const ticketOrder = (ticket: ProjectTicket) => ({ person: 0, working: 1, idle: 2, ended: 3 })[ticket.stage]

export function ProjectTickets({ t, project, inspect, openTicket }: {
  t: T; project: ProjectDetail; inspect: (task: ProjectTask) => void; openTicket?: (id: string) => void
}) {
  const tickets = [...project.tickets].sort((a, b) => ticketOrder(a) - ticketOrder(b))
  const needsHuman = tickets.filter(ticket => ticket.stage === 'person').length
  return <section className="dt-card dt-project-panel">
    <div className="dt-project-heading"><h3>{t('project.tickets')}</h3>
      {needsHuman > 0 && <Tag tone="warning">{t('project.needsHuman', { count: needsHuman })}</Tag>}</div>
    <p className="dt-hint">{t('project.ticketsHelp')}</p>
    {!tickets.length && <p className="dt-hint">{t('project.ticketsEmpty')}</p>}
    {!!tickets.length && <ul className="dt-project-records">{tickets.map(ticket => {
      const linked = project.tasks.filter(task => task.ticketId === ticket.id || task.id === ticket.taskId)
      const suggested = !linked.length && ticket.issueUrl ? project.tasks.find(task => task.issueUrl === ticket.issueUrl) : undefined
      return <li key={ticket.id} className="dt-project-record">
        <div className="dt-project-record-head">
          <div className="dt-project-record-main"><h4>{ticket.title || t('project.untitledTicket')}</h4><div className="dt-project-meta">
            <span className="dt-mono">#{ticket.id.slice(0, 12)}</span>
            {ticket.runner && <Tag>{ticket.runner}</Tag>}
            <Tag tone={ticket.stage === 'person' ? 'warning' : ticket.stage === 'working' ? 'info' : 'quiet'}>{ticketLabel(t, ticket)}</Tag>
            {ticket.issueUrl && <Issue url={ticket.issueUrl} />}
            {ticket.updatedAt && <time dateTime={ticket.updatedAt} title={fullTime(ticket.updatedAt, t('lang'))}>
              {t('project.lastActivity', { time: when(ticket.updatedAt, t('lang')) })}</time>}
          </div></div>
          {openTicket && <Button size="sm" variant="outline" onClick={() => openTicket(ticket.id)}>{t('project.openTicket')}</Button>}
        </div>
        {(linked.length > 0 || suggested) && <div className="dt-project-meta">
          {linked.length > 0 && <span>{t('project.relatedTask')}</span>}
          {linked.map(task => <button key={task.id} type="button" className="dt-project-task-title" onClick={() => inspect(task)}>{task.title}</button>)}
          {suggested && <><span>{t('project.ticketIssueMatch')}</span>
            <button type="button" className="dt-project-task-title" onClick={() => inspect(suggested)}>{suggested.title}</button></>}
        </div>}
        {ticket.question && <div className="dt-project-answer"><strong>{t('project.agentQuestion')}</strong>
          <MarkdownContent t={t} text={ticket.question} /></div>}
        {ticket.summary ? <details className="dt-project-disclosure"><summary>{t('project.readReport')}</summary>
          <MarkdownContent t={t} text={ticket.summary} /></details> : <p className="dt-hint">{t('project.reportPending')}</p>}
        {ticket.pullUrls.length > 0 && <div className="dt-project-meta">{ticket.pullUrls.map(url => <Issue key={url} url={url} />)}</div>}
      </li>
    })}</ul>}
  </section>
}
