/** Headless bootstrap for the original Runtime: Codex host adapter + DingTalk Source. */
import { Context } from '@deepseek-ai/cordis'
import { execFileSync } from 'node:child_process'
import { loadEnvFile } from 'node:process'
import { resolve, join } from 'node:path'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import type { Server } from 'node:http'
import { BlockList } from 'node:net'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { lockSync } from 'proper-lockfile'
import { z } from 'zod'
import { Runtime } from './app/runtime.ts'
import { projectHttpServer, type ProjectPublicAccess } from './app/http.ts'
import { Store } from './app/store.ts'
import { ProjectChange, ProjectRepository, Projects } from './app/projects.ts'
import { KV } from './kv.ts'
import { SettingsSchema } from './policy.ts'
import type { Machine } from './deployment.ts'
import { CodexHarness } from './harness/codex.ts'
import { RobotAgents } from './harness/robot-agents.ts'
import { dingTalkProjectIntake } from './sources/dingtalk-projects.ts'
import { DingTalk, dingTalkKind } from './sources/dingtalk.ts'
import { githubKind, watchGithub } from './sources/github.ts'
import { GithubAppSchema } from './infra/github-app.ts'

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
const reference = <T>(value: T) => ({ get: () => value })
const log = (event: string) => console.log(JSON.stringify({ at: new Date().toISOString(), event }))

function checkoutRepository(directory: string): string | null {
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(directory)) return null
    const remote = git('remote', 'get-url', 'origin')
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(remote)
    return ProjectRepository.safeParse(match?.[1]).data ?? null
  } catch { return null }
}

function projectPublicAccess(localPort: number): { port: number; access: ProjectPublicAccess } | undefined {
  const enabled = process.env.SUPERAGENT_PROJECT_PUBLIC_ENABLED?.trim()
  if (!enabled || enabled === '0') return
  if (enabled !== '1') throw new Error('Set SUPERAGENT_PROJECT_PUBLIC_ENABLED to 0 or 1')
  const origin = URL.parse(process.env.SUPERAGENT_PROJECT_PUBLIC_ORIGIN?.trim() ?? '')
  if (origin?.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('Set SUPERAGENT_PROJECT_PUBLIC_ORIGIN to the external HTTPS origin without a path')
  const port = z.coerce.number().int().min(1).max(65535).safeParse(process.env.SUPERAGENT_PROJECT_PUBLIC_PORT ?? 3092)
  if (!port.success || port.data === localPort)
    throw new Error('Set SUPERAGENT_PROJECT_PUBLIC_PORT to a port different from SUPERAGENT_PORT')
  const username = process.env.SUPERAGENT_PROJECT_PUBLIC_USER ?? 'projects'
  const password = process.env.SUPERAGENT_PROJECT_PUBLIC_PASSWORD ?? ''
  if (!username.trim() || /[:\r\n]/.test(username)) throw new Error('Set a valid SUPERAGENT_PROJECT_PUBLIC_USER without colons or line breaks')
  if (password.length < 16 || /[\r\n]/.test(password))
    throw new Error('Set SUPERAGENT_PROJECT_PUBLIC_PASSWORD to a password with at least 16 characters and no line breaks')
  return { port: port.data, access: { origin, username, password } }
}

async function startProjects(stateDir: string, port: number, previewIp: string | undefined): Promise<void> {
  const previewInterface = previewIp && Object.values(networkInterfaces()).flat()
    .find(info => info?.family === 'IPv4' && !info.internal && info.address === previewIp)
  if (previewIp && !previewInterface)
    throw new Error('Set SUPERAGENT_PROJECT_PREVIEW_IP to an IPv4 address assigned to this machine')
  const lan = process.env.SUPERAGENT_PROJECT_PREVIEW_LAN?.trim()
  if (lan && lan !== '0' && lan !== '1') throw new Error('Set SUPERAGENT_PROJECT_PREVIEW_LAN to 0 or 1')
  let previewNetwork: BlockList | undefined
  if (lan === '1') {
    if (!previewInterface || !previewInterface.cidr)
      throw new Error('Set SUPERAGENT_PROJECT_PREVIEW_IP to an interface with an IPv4 subnet before enabling LAN access')
    const prefix = Number(previewInterface.cidr.split('/')[1])
    if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) throw new Error('Setup: LAN access requires a configured IPv4 subnet')
    previewNetwork = new BlockList()
    previewNetwork.addSubnet(previewInterface.address, prefix)
  }
  const publicAccess = projectPublicAccess(port)
  const listeners: { address: string; port: number; publicAccess?: ProjectPublicAccess; previewNetwork?: BlockList }[] = [{ address: '127.0.0.1', port }]
  if (previewIp) listeners.push({ address: previewIp, port, ...(previewNetwork && { previewNetwork }) })
  if (publicAccess) listeners.push({ address: '127.0.0.1', port: publicAccess.port, publicAccess: publicAccess.access })
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const release = lockSync(stateDir)
  let store: Store | undefined
  const servers: Server[] = []
  let stopping: Promise<void> | undefined
  const stop = async () => {
    try {
      await Promise.all(servers.filter(server => server.listening).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    }
    finally { try { store?.close() } finally { release() } }
  }
  const shutdown = () => stopping ??= stop().catch(() => { process.exitCode = 1 })
  try {
    store = new Store(join(stateDir, 'orchestrator.sqlite'))
    for (const listener of listeners) {
      const server = projectHttpServer(store, listener.port, listener.address, listener)
      servers.push(server)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(listener.port, listener.address, () => { server.off('error', reject); resolve() })
      })
    }
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void shutdown() })
    for (const listener of listeners) {
      if (listener.publicAccess) console.log(`Project HTTPS proxy upstream at 127.0.0.1:${listener.port} for ${listener.publicAccess.origin.origin}/orchestrator/projects`)
      else console.log(`Projects ready at http://${listener.address}:${listener.port}/orchestrator/projects`)
    }
  } catch (error) { await stop(); throw error }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const usage = 'Usage: node lib/codex-cli.js [--env-file /absolute/path/to/env] [--projects-only]'
  let projectsOnly = false
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env-file' && args[i + 1]) loadEnvFile(args[++i]!)
    else if (args[i] === '--projects-only') projectsOnly = true
    else throw new Error(usage)
  }
  const stateDir = resolve(process.env.SUPERAGENT_STATE_DIR ?? './state-codex')
  const port = z.coerce.number().int().min(1).max(65535).parse(process.env.SUPERAGENT_PORT ?? 3082)
  if (projectsOnly) {
    try { await startProjects(stateDir, port, process.env.SUPERAGENT_PROJECT_PREVIEW_IP?.trim()); return }
    catch (error) { throw new Error(`Setup: Project management could not start. ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
  }
  if (process.env.SUPERAGENT_PROJECT_PUBLIC_ENABLED?.trim() === '1')
    throw new Error('Set SUPERAGENT_PROJECT_PUBLIC_ENABLED=1 only with --projects-only')
  const clientId = process.env.DINGTALK_CLIENT_ID || process.env.DINGTALK_APP_KEY
  const clientSecret = process.env.DINGTALK_CLIENT_SECRET || process.env.DINGTALK_APP_SECRET
  if (!!clientId !== !!clientSecret) throw new Error('Set both DINGTALK_CLIENT_ID and DINGTALK_CLIENT_SECRET for DingTalk delivery')
  const intakeGroup = process.env.DINGTALK_OPEN_CONVERSATION_ID?.trim() || undefined
  const projectId = process.env.DINGTALK_PROJECT_ID?.trim() || undefined
  if (projectId && !(clientId && clientSecret && intakeGroup))
    throw new Error('Set the DingTalk application credentials and DINGTALK_OPEN_CONVERSATION_ID before DINGTALK_PROJECT_ID')
  const notificationGroup = clientId && clientSecret ? process.env.DINGTALK_GITHUB_NOTIFY_CONVERSATION_ID?.trim() || undefined : undefined
  // These keys are read only to transfer older headless installs to saved settings.
  const legacyRepository = process.env.SUPERAGENT_GITHUB_REPOSITORY?.trim() || undefined
  const legacyCheckout = process.env.SUPERAGENT_REPOSITORY?.trim() || undefined
  const worktreeArgs = 'worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" HEAD'
  const legacyPrepare = legacyCheckout
    ? `git -C ${quote(resolve(legacyCheckout))} ${worktreeArgs}` : ''
  const legacyPrepares = legacyCheckout
    ? [legacyPrepare, `git -C ${JSON.stringify(resolve(legacyCheckout))} ${worktreeArgs}`] : []
  const sandbox = z.enum(['read-only', 'workspace-write', 'danger-full-access']).parse(process.env.CODEX_SANDBOX ?? 'workspace-write')
  const githubAuth = z.enum(['user', 'app']).parse(process.env.SUPERAGENT_GITHUB_AUTH ?? 'user')
  const githubApp = githubAuth === 'app' ? GithubAppSchema.parse({
    appId: process.env.SUPERAGENT_GITHUB_APP_ID,
    ...(process.env.SUPERAGENT_GITHUB_INSTALLATIONS
      ? { installations: JSON.parse(process.env.SUPERAGENT_GITHUB_INSTALLATIONS) }
      : { installationId: process.env.SUPERAGENT_GITHUB_INSTALLATION_ID }),
    privateKeyPath: process.env.SUPERAGENT_GITHUB_PRIVATE_KEY_PATH,
  }) : undefined
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  // Seed installation settings once using the original schema/store; subsequent settings retain their original history.
  const release = lockSync(stateDir)
  try {
    const store = new Store(join(stateDir, 'orchestrator.sqlite'))
    try { store.atomic(() => {
      const remote = !projectId ? legacyRepository ?? '' : ''
      if (!store.get(KV.settings.revision)) {
        store.saveSettings(SettingsSchema.parse({
          sources: { github: { enabled: !!remote, config: { repository: remote, cli: process.env.SUPERAGENT_GITHUB_CLI ?? 'gh',
            ...(githubApp ? { app: githubApp } : {}) } },
            ...clientId && clientSecret ? { dingtalk: { enabled: true, config: {} } } : {} },
          // Use the original admission table to allow every mentioned sender; no new gate or whitelist implementation.
          policy: { sources: { dingtalk: { allowed: [], admission: { group: { unlistedAddressed: 'explicit' } } } } },
          executor: { maxWorkers: Number(process.env.SUPERAGENT_MAX_WORKERS ?? 3),
            prepare: remote ? legacyPrepare : '' },
        }))
      }
      // A preview can have saved settings before DingTalk credentials were added for the first time.
      const saved = store.settings()
      if (clientId && clientSecret && !saved.sources.dingtalk) {
        store.saveSettings({ ...saved, sources: { ...saved.sources, dingtalk: { enabled: true, config: {} } },
          policy: { ...saved.policy, sources: { ...saved.policy.sources,
            dingtalk: saved.policy.sources.dingtalk ?? { allowed: [], admission: { group: { unlistedAddressed: 'explicit' } } } } } })
      }
      if (projectId) {
        const project = store.get(KV.projects.project(projectId))
        if (!project) throw new Error('Set DINGTALK_PROJECT_ID to an existing project ID')
        const current = store.settings()
        const github = current.sources.github
        const repository = project.repository === undefined && legacyRepository ? ProjectRepository.parse(legacyRepository) : undefined
        const dingTalkGroup = project.dingTalkGroup === undefined ? intakeGroup : undefined
        if (repository || dingTalkGroup) {
          const projects = new Projects(store)
          projects.change(projectId, ProjectChange.parse({ revision: project.revision, change: { kind: 'project',
            value: { name: project.name, description: project.description, objective: project.objective, status: project.status, repository, dingTalkGroup } } }))
        }
        // Retire the former generated workspace default. Existing runs retain their actual checkout and PR routes.
        const boundRepository = repository ?? project.repository
        if (boundRepository && github && legacyPrepares.includes(current.executor.prepare)
          && String(github.config.repository).toLowerCase() === boundRepository
          && legacyRepository?.toLowerCase() === boundRepository) {
          const open = store.tickets.open()
          for (const ticket of open) {
            if (!ticket.execution || ticket.execution.projectRepository !== undefined) continue
            const target = existsSync(ticket.execution.directory) ? checkoutRepository(ticket.execution.directory) : boundRepository
            store.tickets.save({ ...ticket, execution: { ...ticket.execution, projectRepository: target } })
          }
          const keepWatcher = open.some(ticket => ticket.channels.some(channel => channel.source === 'github')
            || ticket.follows?.some(follow => /^github:[1-9]\d*$/.test(follow.thread) && !follow.closed))
            || !!github.config.app
            || ['observeIssues', 'observePulls', 'observeComments', 'observeCi'].some(key => github.config[key] === true)
          store.saveSettings({ ...current, executor: { ...current.executor, prepare: '' },
            sources: { ...current.sources, github: keepWatcher ? github : { ...github, enabled: false, config: { ...github.config, repository: '' } } } })
        }
      }
      // An explicit deployment email also updates an already initialized installation.
      const commitEmail = process.env.SUPERAGENT_GITHUB_COMMIT_EMAIL
      if (commitEmail !== undefined) {
        const email = z.email().parse(commitEmail)
        const settings = store.settings()
        const github = settings.sources.github
        if (github && github.config.commitEmail !== email) {
          github.config = { ...github.config, commitEmail: email }
          store.saveSettings(settings)
        }
      }
    }) } finally { store.close() }
  } finally { release() }
  const machine: Machine = { stateDir, githubOptional: true, promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
    admissionContextTimeoutMs: reference(15000) }
  const ctx = new Context()
  const model = process.env.CODEX_MODEL
  const robotAgents = new RobotAgents({ codex: process.env.CODEX_BINARY, qwen: process.env.QWEN_BINARY, codexModel: model,
    qwenModel: process.env.QWEN_MODEL, qoder: process.env.QODER_BINARY, qoderModel: process.env.QODER_MODEL })
  const binary = robotAgents.binary('codex') ?? process.env.CODEX_BINARY ?? 'codex'
  const harness = new CodexHarness(ctx, { binary, model, sandbox, port })
  let runtime: Runtime | undefined, robot: DingTalk | undefined
  const githubController = new AbortController()
  let githubPolling: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  const stop = () => stopping ??= (async () => {
    robot?.stop()
    githubController.abort()
    await githubPolling
    const stopped = runtime?.stop()
    await harness.close()
    await stopped
  })()
  try {
    runtime = new Runtime(ctx, machine, () => { log('restart_required'); void stop() },
      notificationGroup, trigger => robot?.received(trigger),
      (ticketId, deliveryId, triggerId, busy) => robot?.bindWorkerDelivery(ticketId, deliveryId, triggerId, busy),
      undefined, robotAgents)
    runtime.lifetime.addEventListener('abort', () => { githubController.abort(); robot?.stop(); void harness.close() }, { once: true })
    runtime.sources.register(githubKind)
    if (clientId && clientSecret) {
      const kind = dingTalkKind(message => robot!.send(message))
      runtime.sources.register(kind)
      const intake = dingTalkProjectIntake(new Projects(runtime.store), runtime.projectPlanning, intakeGroup, runtime.projectAgent)
      // Construct the transport before startup recovery can submit a worker delivery.
      robot = new DingTalk(runtime.context(kind), { clientId, clientSecret }, log, fetch,
        process.env.DINGTALK_CARD_TEMPLATE_ID, process.env.DINGTALK_ROBOT_NAME, intake)
    }
    await runtime.ready
    if (!runtime.configured()) throw new Error(`Setup: ${runtime.setupProblem?.detail ?? 'not configured'}`)
    // Export once at startup, then keep using the original static allowed list and gate.
    if (runtime.commands.deployment.repository && runtime.sources.instance('github')?.enabled) {
      const allowed = githubKind.policy!.schema.parse({ allowed: JSON.parse(await runtime.commands.run('python3', [
        fileURLToPath(new URL('../scripts/export-github-admins', import.meta.url)),
        runtime.commands.deployment.repository, runtime.commands.deployment.github.cli,
      ]).catch(() => { throw new Error('Setup: GitHub admin export failed; the saved allowed list was kept') })) }).allowed
      const policy = runtime.store.settings().policy
      await runtime.settings.save('policy', { ...policy, sources: { ...policy.sources,
        github: { ...policy.sources.github, allowed } } }, runtime.store.blockRevision('policy'), 'sync')
    }
    await harness.listen()
    await robot?.start()
    githubPolling = watchGithub(runtime.context(githubKind), githubController.signal)
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop().catch(() => { process.exitCode = 1 }) })
    log('ready')
  } catch (error) { await stop(); throw error }
}
void main().catch(error => {
  // SDK errors may retain credentials; never print raw HTTP/Stream errors.
  console.error(error instanceof Error && /^(Set |Usage:|Setup:)/.test(error.message) ? error.message
    : 'Startup failed; check Codex and GitHub setup and any configured DingTalk credentials.')
  process.exitCode = 1
})
