import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DWClient } from 'dingtalk-stream'
import { KV } from '../src/kv.ts'
import { Commands } from '../src/infra/commands.ts'
import type { ProjectAgentRun } from '../src/app/project-agent.ts'
import { ProjectChange, ProjectInput, Projects } from '../src/app/projects.ts'
import { projectMessageReceived } from '../src/sources/project-message.ts'
import { DingTalk, dingTalkKind } from '../src/sources/dingtalk.ts'
import { dingTalkProjectIntake } from '../src/sources/dingtalk.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { deferred } from './fixtures/async.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })
const call = (tool: string, args: unknown) => ({ tool, arguments: JSON.stringify(args) })
const done = (reply = '已处理，请查看任务。') => ({ calls: [], reply })
async function pilot() {
  const propose = vi.fn(async (_prompt: string, _schema: object, _signal: AbortSignal): Promise<unknown> => done())
  const h = host = await startRuntime(undefined, undefined, undefined, undefined, undefined, { name: 'Test Agent', propose })
  const projects = new Projects(h.runtime.store)
  const { id } = projects.create(ProjectInput.parse({ name: '2048 事件验收', status: 'planning', dingTalkGroup: 'test-group', autoAdvance: false }))
  projects.addDingTalkSender(id, 'test-corp', 'member', 'Robin')
  const member = projects.detail(id).members[0]!
  const assignee = projects.registerDingTalkSender('test-corp', 'assignee', '李顺阳').member
  const change = (change: ProjectChange['change']) => projects.change(id, ProjectChange.parse({ revision: projects.detail(id).revision, change }))
  const task = change({ kind: 'task', value: { title: '整理首版规则', description: '提交规则清单', acceptance: '列出移动和合并规则', executionMode: 'agent', ownerId: member.id } }).tasks[0]!
  const say = async (messageId: string, text: string, quoted = '') => {
    const response = await h.api('POST', `projects/${id}/messages`, { messageId, text, quoted })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    await h.runtime.idle()
    return h.runtime.projectAgent!.runs(id).find(run => run.message.messageId === messageId)!
  }
  return { h, projects, id, member, assignee, task, change, propose, say }
}

it('uses the screenshot request and quote to add acceptance criteria and assignment without dispatching work', async () => {
  const { h, projects, id, assignee, task, propose, say } = await pilot()
  propose.mockImplementationOnce(async prompt => {
    expect(prompt).toContain('请你帮忙梳理 验收通过条件并分派给 李顺阳')
    expect(prompt).toContain('整理开发测试用例')
    expect(prompt).toContain(assignee.id)
    expect(prompt).toContain('task.create')
    return { calls: [call('member.add', { memberId: assignee.id }), call('task.create', { title: '整理开发测试用例',
      description: '整理普通合并、连续相同数字、无效移动、结束与重开的用例', acceptance: '每条列明初始棋盘、操作、预期棋盘和计分变化',
      ownerId: assignee.id, executionMode: 'agent', blockedBy: [task.id] })], reply: '' }
  }).mockImplementationOnce(async prompt => {
    expect(prompt).toContain('已创建「整理开发测试用例」')
    return done('已补充测试用例的验收条件，由李顺阳验收。')
  })
  const run = await say('screenshot', '请你帮忙梳理 验收通过条件并分派给 李顺阳',
    '整理开发测试用例由 Agent 执行、李顺阳验收。需要覆盖哪些内容，以什么条件验收？')
  expect(run.status).toBe('completed')
  expect(projects.detail(id)).toMatchObject({ status: 'planning', autoAdvance: false, tickets: [], tasks: [task,
    { title: '整理开发测试用例', status: 'todo', ownerId: assignee.id, executionMode: 'agent', blockedBy: [task.id] }] })
  expect(run.steps[0]?.results).toHaveLength(2)
  expect(h.runtime.projectEvents.list({ projectId: id }).map(event => event.type)).toContain('project.message.received')
  const history = await h.api('GET', `projects/${id}/agent-runs`)
  expect(history).toMatchObject({ status: 200, body: [{ status: 'completed', steps: [{ results: [expect.anything(), expect.objectContaining({ summary: '已创建「整理开发测试用例」' })] }] }] })
})

it('handles expressions with no project keywords and changes only supplied task fields', async () => {
  const { projects, id, assignee, task, propose, say } = await pilot()
  propose.mockResolvedValueOnce({ calls: [call('member.add', { memberId: assignee.id }),
    call('task.update', { taskId: task.id, changes: { ownerId: assignee.id, acceptance: '检查四个相同数字的合并与计分' } })], reply: '' })
  const run = await say('plain-language', '这块交给顺阳，四个一样的数字也算一下。', `「${task.title}」由 Agent 执行，Robin 验收。`)
  expect(run.status).toBe('completed')
  expect(projects.detail(id).tasks[0]).toMatchObject({ id: task.id, description: task.description, status: 'todo',
    executionMode: 'agent', ownerId: assignee.id, acceptance: '检查四个相同数字的合并与计分' })
  expect(projects.detail(id).tickets).toEqual([])
})

it('lets the Agent explain or ask a question without creating or starting a task', async () => {
  const { projects, id, propose, say } = await pilot()
  const before = projects.detail(id).revision
  propose.mockResolvedValueOnce(done('你希望李顺阳负责执行，还是继续由 Agent 执行、李顺阳验收？'))
  const run = await say('question', '这个让顺阳来吧')
  expect(run.reply).toContain('负责执行')
  expect(run.steps).toEqual([])
  expect(projects.detail(id).revision).toBe(before)
  expect(projects.detail(id).tickets).toEqual([])
  expect(propose).toHaveBeenCalledOnce()
})

it('rolls back an entire tool batch and returns the failure to the Agent before replying', async () => {
  const { projects, id, task, propose, say } = await pilot()
  propose.mockResolvedValueOnce({ calls: [call('task.update', { taskId: task.id, changes: { acceptance: 'changed' } }),
    call('task.update', { taskId: task.id, changes: { ownerId: 'unknown-member' } })], reply: '' })
  propose.mockImplementationOnce(async prompt => {
    expect(prompt).toContain('这批操作已回滚')
    return done('指定的人还不是项目成员，请确认人员。')
  })
  const run = await say('rollback', '调整验收条件并指派')
  expect(projects.detail(id).tasks[0]?.acceptance).toBe(task.acceptance)
  expect(run.steps[0]?.results).toEqual([])
  expect(run.steps[0]?.error).toContain('回滚')
  expect(run.reply).not.toContain('本次实际操作')
})

it('reconsiders a stale proposal using current context instead of committing old tool calls', async () => {
  const { h, projects, id, change, propose } = await pilot()
  const pending = deferred<unknown>()
  propose.mockImplementationOnce(() => pending.promise).mockImplementationOnce(async prompt => {
    expect(prompt).toContain('Changed while thinking')
    return done('已根据更新后的目标重新判断。')
  })
  await h.api('POST', `projects/${id}/messages`, { messageId: 'stale', text: '帮我重新安排' })
  await vi.waitFor(() => expect(propose).toHaveBeenCalledOnce())
  change({ kind: 'project', value: { name: projects.detail(id).name, status: 'planning', objective: 'Changed while thinking' } })
  pending.resolve({ calls: [call('task.create', { title: 'Outdated work' })], reply: '' })
  await h.runtime.idle()
  expect(projects.detail(id).tasks).toHaveLength(1)
  expect(h.runtime.projectAgent!.runs(id)[0]).toMatchObject({ status: 'completed', conflicts: 1 })
  expect(h.runtime.projectEvents.list({ projectId: id }).some(event => event.reason?.includes('Project changed'))).toBe(true)
})

it('starts work through normal project tools and reuses the same run on request redelivery', async () => {
  const { h, projects, id, task, propose, say } = await pilot()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy,
    sources: { ...settings.policy.sources, request: { allowed: [{ id: 'local' }] } } } })
  propose.mockResolvedValueOnce({ calls: [call('project.update', { status: 'active' }), call('task.start', { taskId: task.id })], reply: '' })
  const run = await say('start', '项目开工，先让 Agent 做规则整理')
  expect(run.status).toBe('completed')
  expect(projects.detail(id)).toMatchObject({ status: 'active', tasks: [{ status: 'in-progress' }], tickets: [expect.objectContaining({ taskId: task.id })] })
  await say('start', '项目开工，先让 Agent 做规则整理')
  expect(projects.detail(id).tickets).toHaveLength(1)
  expect(propose).toHaveBeenCalledTimes(2)
})

it('preserves dependency gates and rolls back kickoff when dispatch fails', async () => {
  const { projects, id, change, task, propose, say } = await pilot()
  const downstream = change({ kind: 'task', value: { title: 'Dependent work', executionMode: 'agent', blockedBy: [task.id] } }).tasks[1]!
  propose.mockResolvedValueOnce({ calls: [call('project.update', { status: 'active' }), call('task.start', { taskId: downstream.id })], reply: '' })
  const run = await say('blocked-dispatch', '先开始第二项')
  expect(run.steps[0]?.error).toBeTruthy()
  expect(projects.detail(id)).toMatchObject({ status: 'planning', tickets: [] })
})

it('uses the selected task repository and links the Issue without dispatching a worker', async () => {
  const { projects, id, task, change, propose, say } = await pilot()
  change({ kind: 'project', value: { name: projects.detail(id).name, repository: 'acme/pilot' } })
  const url = 'https://github.com/acme/pilot/issues/18'
  const api = vi.spyOn(Commands.prototype, 'gh').mockResolvedValue({ html_url: url })
  try {
    propose.mockResolvedValueOnce({ calls: [call('issue.create', { taskId: task.id })], reply: '' })
    const run = await say('issue', '这个先帮我在项目仓库留个 Issue，暂时不要做。', task.title)
    expect(run.status).toBe('completed')
    expect(projects.detail(id).tasks[0]?.issueUrl).toBe(url)
    expect(projects.detail(id).tickets).toEqual([])
    expect(api).toHaveBeenCalledOnce()
    expect(api.mock.calls[0]?.[0]).toContain('repos/acme/pilot/issues')
  } finally { api.mockRestore() }
})

it('recovers a persisted model decision after restart without asking the model to repeat the committed proposal', async () => {
  const { h, projects, id, task } = await pilot()
  const project = projects.detail(id)
  const members = projects.members()
  const runId = 'persisted-project-request'
  const pending: NonNullable<ProjectAgentRun['pending']> = { runId, turn: 0, revision: project.revision, provider: 'Before restart',
    decision: { calls: [call('task.update', { taskId: task.id, changes: { acceptance: '恢复后保留的具体条件' } })], reply: '' } }
  const run: ProjectAgentRun = { id: runId, message: { projectId: id, actorId: null, messageId: 'restart', text: '补充验收条件', quoted: '',
    channel: { source: 'request', thread: id, address: { projectId: id } } }, status: 'running', instruction: '', turn: 0,
    conflicts: 0, steps: [], pending, at: new Date().toISOString() }
  await h.stop(); host = undefined
  const propose = vi.fn(async () => done('已恢复并补充条件。'))
  const resumed = host = await startRuntime(store => {
    store.set(KV.projects.project(id), project)
    for (const member of members) store.set(KV.projects.member(member.id), member)
    store.set(KV.projects.agentRun(runId), run)
    store.db.prepare('INSERT INTO effect (kind,key,value,seq,due,since) VALUES (?,?,?,?,?,?)')
      .run('project-agent', runId, JSON.stringify({ runId }), 1, Date.now(), run.at)
  }, undefined, undefined, undefined, undefined, { name: 'After restart', propose })
  await resumed.runtime.idle()
  expect(new Projects(resumed.runtime.store).detail(id).tasks[0]?.acceptance).toBe('恢复后保留的具体条件')
  expect(resumed.runtime.projectAgent!.runs(id)[0]).toMatchObject({ status: 'completed', steps: [{ provider: 'Before restart' }] })
  expect(propose).toHaveBeenCalledOnce()
})

it('reports model failure after a bounded retry and leaves no silent request', async () => {
  const { h, propose, say, id } = await pilot()
  propose.mockRejectedValue(new Error('provider unavailable'))
  const run = await say('unavailable', '请整理一下')
  expect(run).toMatchObject({ status: 'failed', reply: expect.stringContaining('无法生成有效处理结果') })
  expect(propose).toHaveBeenCalledTimes(2)
  expect(h.runtime.effects.pending('project-agent')).toBe(false)
  expect((await h.api('GET', `projects/${id}/agent-runs`)).body).toMatchObject([{ status: 'failed' }])
})

it('uses configured Agent instructions and supports additional tools through the catalog', async () => {
  const { h, id, propose, say } = await pilot()
  h.runtime.projectTools!.register({ name: 'project.count_tasks', description: 'Count current project tasks', schema: z.strictObject({}),
    execute: context => ({ summary: '已统计任务数量', data: h.runtime.projectTools!.snapshot(context.projectId).project.tasks.length }) })
  expect(await h.api('PUT', 'projects/workflow', { revision: 0, config: { on: { 'project.message.received': '每次说明需要谁采取下一步行动。' } } }))
    .toMatchObject({ status: 200 })
  propose.mockImplementationOnce(async prompt => {
    expect(prompt).toContain('每次说明需要谁采取下一步行动')
    expect(prompt).toContain('project.count_tasks')
    return { calls: [call('project.count_tasks', {})], reply: '' }
  })
  const run = await say('custom-tool', '现在有多少项？')
  expect(run.steps[0]?.results[0]?.data).toBe(1)
  expect((await h.api('GET', 'projects/tools')).body).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'project.count_tasks' })]))
  expect(h.runtime.projectEvents.view().events.some(event => event.type === 'project.agent.proposed')).toBe(false)
  expect(await h.api('PUT', 'projects/workflow', { revision: 1, config: { on: { 'project.agent.proposed': false } } })).toMatchObject({ status: 400 })
})

it('can disable project message handling with JSON and stops proposals disabled during inference', async () => {
  const { h, id, propose, projects } = await pilot()
  const pending = deferred<unknown>()
  propose.mockImplementationOnce(() => pending.promise)
  await h.api('POST', `projects/${id}/messages`, { messageId: 'disable-running', text: '整理一下' })
  await vi.waitFor(() => expect(propose).toHaveBeenCalledOnce())
  await h.api('PUT', 'projects/workflow', { revision: 0, config: { on: { 'project.message.received': false } } })
  pending.resolve({ calls: [call('task.create', { title: 'Should remain uncreated' })], reply: '' })
  await h.runtime.idle()
  expect(projects.detail(id).tasks).toHaveLength(1)
  const response = await h.api('POST', `projects/${id}/messages`, { messageId: 'disabled', text: '再整理一下' })
  expect(response).toMatchObject({ status: 200, body: { status: 'disabled' } })
  await h.runtime.idle()
  expect(propose).toHaveBeenCalledOnce()
  expect(h.runtime.projectEvents.list({ projectId: id })[0]).toMatchObject({ status: 'ignored' })
})

it('routes real DingTalk messages and native quotes into the same Agent entry without keyword filtering', async () => {
  const { h, projects, id, task, propose } = await pilot()
  const send = vi.fn(async () => {})
  const kind = dingTalkKind(send)
  h.runtime.sources.register(kind)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, dingtalk: { enabled: true, config: {} } } })
  let receive!: (frame: { headers: { messageId: string }; data: string }) => Promise<void>
  const callback = vi.spyOn(DWClient.prototype, 'registerCallbackListener').mockImplementation(function (this: DWClient, _topic, fn) {
    receive = fn as typeof receive; return this
  })
  const ack = vi.spyOn(DWClient.prototype, 'socketCallBackResponse').mockImplementation(() => {})
  try {
    new DingTalk(h.runtime.context(kind), { clientId: 'test', clientSecret: 'test' }, () => {}, undefined, undefined, undefined,
      dingTalkProjectIntake(projects, h.runtime.projectPlanning, 'test-group', h.runtime.projectAgent))
    propose.mockImplementationOnce(async prompt => {
      expect(prompt).toContain('四个一样的也算一下')
      expect(prompt).toContain(task.title)
      return { calls: [call('task.update', { taskId: task.id, changes: { acceptance: '验证四个相同数字的合并和计分' } })], reply: '' }
    })
    const frame = { headers: { messageId: 'delivery' }, data: JSON.stringify({ msgId: 'no-keywords', conversationId: 'test-group',
      conversationType: '2', isInAtList: true, chatbotUserId: 'bot', senderStaffId: 'member', senderCorpId: 'test-corp',
      robotCode: 'robot', msgtype: 'text', text: { content: '四个一样的也算一下', isReplyMsg: true,
        repliedMsg: { senderId: 'bot', content: `「${task.title}」的说明` } },
      sessionWebhook: 'https://oapi.dingtalk.com/robot/send?fixture', sessionWebhookExpiredTime: Date.now() + 60000 }) }
    await receive(frame); await receive(frame)
    await h.runtime.idle()
    expect(projects.detail(id).tasks[0]?.acceptance).toBe('验证四个相同数字的合并和计分')
    expect(projects.detail(id).tickets).toEqual([])
    expect(h.runtime.projectAgent!.runs(id)).toHaveLength(1)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: '已处理，请查看任务。' }))
    expect(h.runtime.projectAgent!.runs(id)[0]?.steps[0]?.results[0]?.summary).toBe('已更新「整理首版规则」')
    expect(ack).toHaveBeenCalledTimes(2)
  } finally { callback.mockRestore(); ack.mockRestore() }
})

it('rejects membership spoofing, cross-project tools and stale group membership', async () => {
  const { h, id, member, projects, change, propose, task } = await pilot()
  expect(await h.api('POST', `projects/${id}/messages`, { text: 'change', actorId: 'forged' })).toMatchObject({ status: 400 })
  const other = projects.create(ProjectInput.parse({ name: 'Other project' }))
  const otherTask = projects.change(other.id, ProjectChange.parse({ revision: other.revision,
    change: { kind: 'task', value: { title: 'Private task' } } })).tasks[0]!
  expect(() => h.runtime.projectTools!.execute('task.update', { taskId: otherTask.id, changes: { title: 'Intrusion' } }, {
    projectId: id, actorId: member.id, messageId: 'bad', operationId: 'bad', channel: { source: 'dingtalk', thread: 'test-group', address: { conversationId: 'test-group' } },
  })).toThrow('does not belong')
  const kind = dingTalkKind(async () => {})
  h.runtime.sources.register(kind)
  const pending = deferred<unknown>()
  propose.mockImplementationOnce(() => pending.promise)
  h.runtime.projectAgent!.submit({ projectId: id, actorId: member.id, messageId: 'remove-member', text: '补充条件', quoted: '',
    channel: { source: 'dingtalk', thread: 'test-group', address: { conversationId: 'test-group' } } })
  await vi.waitFor(() => expect(propose).toHaveBeenCalledOnce())
  change({ kind: 'task', id: task.id, value: { title: task.title, ownerId: null } })
  change({ kind: 'remove-member', memberId: member.id })
  pending.resolve({ calls: [call('task.update', { taskId: task.id, changes: { acceptance: 'unauthorized' } })], reply: '' })
  await h.runtime.idle()
  expect(projects.detail(id).tasks[0]?.acceptance).not.toBe('unauthorized')
  expect(h.runtime.projectAgent!.runs(id)[0]?.status).toBe('failed')
})

it('ships a matching default JSON for the message event and its configuration documentation', () => {
  const defaults = JSON.parse(readFileSync(new URL('../config/events/dingtalk.defaults.json', import.meta.url), 'utf8'))
  expect(defaults.sources.dingtalk.on['project.message.received']).toEqual({ enabled: true, description: projectMessageReceived.description })
  expect(readFileSync(new URL(`../${projectMessageReceived.documentation}`, import.meta.url), 'utf8')).toContain('project.message.received')
})
