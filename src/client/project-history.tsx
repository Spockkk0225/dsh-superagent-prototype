import { useState } from 'react'
import type { ProjectDetail } from '../app/projects.ts'
import { usePoll, type Call } from './api.ts'
import { Button, Tag } from './controls.tsx'
import { errorText, type T } from './text.ts'
import { MarkdownContent } from './widgets.tsx'

/** Shows facts, model proposals and confirmed results together, while keeping raw evidence available on demand. */
export function ProjectHistory({ call, t, project }: { call: Call; t: T; project: ProjectDetail }) {
  const [before, setBefore] = useState<number>()
  const [taskId, setTaskId] = useState('')
  const [failure, setFailure] = useState('')
  const [pending, setPending] = useState('')
  const { data, error, reload } = usePoll(() => call('GET projects/:id/history', { id: project.id, query: { before } }), [call, project.id, before])
  const retry = async (operationId: string) => {
    setPending(operationId); setFailure('')
    try { await call('POST projects/:id/synchronization/:operationId/retry', { id: project.id, operationId }); await reload() }
    catch (error) { setFailure(errorText(error)) }
    finally { setPending('') }
  }
  const taskName = (id: string) => project.tasks.find(task => task.id === id)?.title ?? id.slice(0, 8)
  return <section className="dt-card dt-project-panel">
    <div className="dt-project-heading"><h3>{t('project.history')}</h3>
      <select className="dt-select" aria-label={t('project.relatedTask')} value={taskId} onChange={event => setTaskId(event.target.value)}>
        <option value="">{t('project.allTasks')}</option>
        {project.tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
      </select></div>
    <p className="dt-hint">{t('project.historyHelp')}</p>
    {(failure || error) && <p role="alert" className="dt-error">{failure || error?.message}</p>}
    {!data && !error && <p role="status">{t('loading')}</p>}
    {data && <>
      {!!data.notifications.length && <details><summary>{t('project.notificationReceipts')}</summary>
        {data.notifications.filter(item => !taskId || item.origin.taskId === taskId).map(item => <div className="dt-project-record" key={item.id}>
          <Tag>{t(`project.notification.${item.status}`)}</Tag> · {item.source} · {item.format}
          <MarkdownContent t={t} text={item.text} />
          <p className="dt-hint">{item.id}{item.origin.eventId && ` · ${item.origin.eventId}`}{item.dropped && ` · ${item.dropped.reason}`}</p>
        </div>)}</details>}
      {!!data.synchronization.length && <section aria-label={t('project.synchronization')}><h4>{t('project.synchronization')}</h4>
        <ul className="dt-project-records">{data.synchronization.filter(item => !taskId || item.taskId === taskId).map(item => <li className="dt-project-record" key={item.id}>
          <strong>{taskName(item.taskId)}</strong> <Tag>{t(`project.sync.${item.status}`)}</Tag>
          <p>{item.reason}</p><a href={item.url} target="_blank" rel="noreferrer">{item.url}</a>
          {['failed', 'retrying'].includes(item.status) && <Button size="sm" variant="outline" disabled={!!pending} onClick={() => { void retry(item.id) }}>{t('project.retrySync')}</Button>}
          <p className="dt-hint"><time>{new Date(item.updatedAt).toLocaleString()}</time> · {t('project.attempts', { count: item.attempts })}</p>
        </li>)}</ul></section>}
      {!!data.remote.length && <details><summary>{t('project.remoteFacts')}</summary>
        {data.remote.filter(item => !taskId || item.taskId === taskId).map(item => <p key={`${item.taskId}:${item.url}`}>
          <strong>{taskName(item.taskId)}</strong> · <a href={item.url} target="_blank" rel="noreferrer">{item.url}</a> · {item.state}
          {item.head && <span className="dt-mono"> · {item.head.slice(0, 12)}</span>}
          {' · '}<time>{new Date(item.updatedAt).toLocaleString()}</time></p>)}</details>}
      {!!data.checks.length && <details><summary>{t('project.scheduledChecks')}</summary>
        {data.checks.filter(item => !taskId || item.taskId === taskId).map(item => <p key={item.id}>{taskName(item.taskId)} · {new Date(item.at).toLocaleString()} · {item.reason} · {t(item.fired ? 'project.checkFired' : 'project.checkWaiting')}</p>)}</details>}
      <ol className="dt-project-records">{data.entries.filter(item => !taskId || item.event.taskId === taskId ||
        (item.event.data as { tasks?: (string | { id: string })[] }).tasks?.some(task => typeof task === 'string' ? task === taskId : task.id === taskId)).map(item => <li key={item.event.seq} className="dt-project-record">
        <div className="dt-project-record-head"><strong>{item.label}</strong><Tag>{t(`project.event.${item.event.status}`)}</Tag></div>
        <p className="dt-hint">#{item.event.seq} · {item.event.source} · <time>{new Date(item.event.recordedAt).toLocaleString()}</time>
          {item.event.taskId && ` · ${taskName(item.event.taskId)}`}</p>
        {item.reason && <MarkdownContent t={t} text={item.reason} />}
        {item.decisions.map(decision => <div className="dt-project-decision" key={decision.id}>
          <strong>{t('project.agentDecision')} · {decision.status}</strong>
          {decision.reply ? <MarkdownContent t={t} text={decision.reply} /> : <p className="dt-hint">{t(decision.status === 'running' ? 'project.decisionPending' : 'project.silentDecision')}</p>}
          {decision.steps.map((step, index) => <div key={index}>
            <p className="dt-hint">{step.provider} · {step.calls.map(call => call.tool).join(', ')}</p>
            {step.error ? <p className="dt-error">{step.error}</p> : <ul>{step.results.map((result, index) => <li key={index}>{result.summary}</li>)}</ul>}
          </div>)}
        </div>)}
        <details><summary>{t('project.eventEvidence')}</summary>
          {item.event.causeId && <p>{t('project.cause')}: <span className="dt-mono">{item.event.causeId}</span></p>}
          <pre className="dt-history-json">{JSON.stringify(item.event.data, null, 2)}</pre></details>
      </li>)}</ol>
      {!data.entries.length && <p className="dt-hint">{t('project.historyEmpty')}</p>}
      <div className="dt-work-actions">
        {before && <Button variant="outline" onClick={() => setBefore(undefined)}>{t('project.latestEvents')}</Button>}
        {data.next && <Button variant="outline" onClick={() => setBefore(data.next!)}>{t('project.olderEvents')}</Button>}
      </div>
    </>}
  </section>
}
