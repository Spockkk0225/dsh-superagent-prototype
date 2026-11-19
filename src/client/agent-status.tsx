import type { ReactNode } from 'react'
import type { ProjectExecution } from '../app/projects.ts'
import { usePoll, type Call } from './api.ts'
import { Button, Icon, Tag, type IconName, type TagTone } from './controls.tsx'
import { healthText, type T } from './text.ts'

function ConnectionRow({ icon, label, state, tone, detail }: { icon: IconName; label: ReactNode; state: string; tone: TagTone; detail?: ReactNode }) {
  return <li className="dt-runtime-connection">
    <Icon name={icon} size={15} /><strong>{label}</strong><Tag tone={tone}>{state}</Tag>
    {detail && <span className="dt-runtime-connection-detail">{detail}</span>}
  </li>
}

function RuntimeStatus({ t, execution, error, openExecution }: {
  t: T; execution?: ProjectExecution; error?: Error; openExecution?: () => void
}) {
  const agent = execution?.agent
  const health = agent?.health
  const capability = health?.state === 'error' ? t('project.runtime.error') : execution ? t(`project.runtime.${execution.state}`) : t('loading')
  const warning = !!error || health?.state === 'error'
  const dingTalk = execution?.connections?.dingtalk
  const github = execution?.github
  const gitHubHealth = execution?.connections?.github
  const repositories = github?.repositories ?? (github && execution?.repository ? [{ repository: execution.repository, configured: true,
    projects: 0, health: github.watchingRepository ? gitHubHealth ?? { state: 'starting' as const, detail: '' } : { state: 'paused' as const, detail: '' } }] : [])
  return <section className="dt-work-runtime dt-card" aria-label={t('project.agentStatus')}>
    <div className="dt-project-heading">
      <div className="dt-agent-title"><Icon name="session" size={18} /><h2>{t('project.agentStatus')}</h2>
        <Tag tone={warning ? 'warning' : execution?.state === 'ready' && health?.state !== 'starting' ? 'success' : 'quiet'}>
          {error ? t('project.runtime.stale') : capability}
        </Tag>
      </div>
      {openExecution && <Button size="sm" variant="outline" onClick={openExecution}>{t('project.allExecution')}</Button>}
    </div>
    {error && <p className="dt-error" role="alert">{error.message}</p>}
    {health?.state === 'error' && <p className="dt-error">{healthText(t, health)}</p>}
    {execution?.state === 'planning' && <details><summary>{t('project.enableExecution')}</summary>
      <p>{t('project.executionHelp')}</p><code>pnpm start:codex --env-file .env</code></details>}
    {agent && <dl className="dt-agent-metrics">
      {execution?.planner && <div><dt>{t('project.robotAgent')}</dt><dd>{execution.planner}</dd></div>}
      <div><dt>{t('project.mainSession')}</dt><dd>{t(`project.session.${agent.main}`)}</dd></div>
      <div><dt>{t('project.globalWorkers')}</dt><dd>{agent.load.running} / {agent.load.maxWorkers}</dd></div>
      <div><dt>{t('project.globalQueue')}</dt><dd>{agent.load.queued}</dd></div>
    </dl>}
    {agent?.load.running === 0 && <p className="dt-hint">{t('project.noActiveWorkers')}</p>}
    <ul className="dt-runtime-connections">
      {dingTalk && <ConnectionRow icon="message" label={t('project.connection.dingtalk')}
        state={t(`project.connectionState.${dingTalk.state}`)} tone={dingTalk.state === 'error' ? 'warning' : dingTalk.state === 'ready' ? 'success' : 'outline'}
        detail={dingTalk.state === 'error' ? healthText(t, dingTalk) : undefined} />}
      {github && <ConnectionRow icon="user" label={t('project.githubAccount')}
          state={t(github.authenticated ? 'project.githubAuthenticated' : 'project.githubAuthenticationMissing')}
          tone={github.authenticated ? 'success' : 'outline'} />}
    </ul>
    {github && <section className="dt-repository-status" aria-label={t('project.githubWatch')}>
      <h3>{t('project.githubWatch')}</h3>
      {repositories.length ? <ul className="dt-runtime-connections">{repositories.map(({ repository, projects, health }) =>
        <ConnectionRow key={repository} icon="pull"
          label={<a className="dt-project-link" href={`https://github.com/${repository}`} target="_blank" rel="noreferrer">{repository}</a>}
          state={t(health.state === 'paused' ? 'project.watchDisabled' : `project.connectionState.${health.state}`)}
          tone={health.state === 'error' ? 'warning' : health.state === 'ready' ? 'success' : 'outline'}
          detail={<>{t(projects ? 'project.githubWatchProjects' : 'project.githubWatchConfigured', { count: projects })}
            {health.state === 'error' && <> · {healthText(t, health)}</>}</>} />)}</ul>
        : <p className="dt-hint">{t(github.repositories ? 'project.githubWatchEmpty' : 'project.watchDisabled')}</p>}
    </section>}
  </section>
}

function RobotAgentsPanel({ t, call }: { t: T; call: Call }) {
  const { data, error, reload } = usePoll(() => call('GET projects/agents'), [call])
  if (error) return <p role="alert" className="dt-error">{error.message}</p>
  if (!data) return null
  const active = data.agents.find(item => item.id === data.selected)
  return <section className="dt-card dt-project-panel" aria-label={t('project.localAgents')}>
    <div className="dt-project-heading"><h3>{t('project.localAgents')}</h3>
      <Button size="sm" variant="outline" onClick={() => { void reload() }}>{t('project.scanAgents')}</Button>
    </div>
    {active && <p className="dt-project-meta"><strong>{t('project.robotAgent')}</strong><Tag tone={active.installed ? 'success' : 'warning'}>{active.name}</Tag></p>}
    <ul className="dt-project-records">{data.agents.map(item => <li key={item.id} className="dt-project-meta">
      <strong>{item.name}</strong>
      <Tag>{t(!item.installed ? 'project.agentMissing' : item.planning && item.execution ? 'project.agentDetected' : 'project.agentNotIntegrated')}</Tag>
    </li>)}</ul>
  </section>
}

export function AgentStatus({ t, call, execution, error, openExecution }: {
  t: T; call: Call; execution?: ProjectExecution; error?: Error; openExecution?: () => void
}) {
  return <>
    <RuntimeStatus t={t} execution={execution} error={error} openExecution={openExecution} />
    <RobotAgentsPanel t={t} call={call} />
  </>
}
