import { afterEach, expect, it, vi } from 'vitest'
import { requestTrigger } from '../src/sources/request.ts'
import { KV } from '../src/kv.ts'
import { key } from '../src/core/index.ts'
import { Projects, ProjectInput, ProjectChange } from '../src/app/projects.ts'
import { RepositorySource, type RepositoryResource } from '../src/sources/repository-source.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { GithubSource, githubKind } from '../src/sources/github.ts'
import { feedbackReceived } from '../src/sources/repository-events.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })
const pr = 'https://github.com/acme/widgets/pull/3'
const time = () => new Date().toISOString()
async function pilot(reply = false) {
  const propose = vi.fn(async (_prompt: string): Promise<unknown> => ({ calls: [], reply: '' }))
  const h = host = await startRuntime(undefined, undefined, undefined, undefined, undefined, { name: 'Review Agent', propose })
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), policy: { ...h.runtime.store.settings().policy,
    sources: { ...h.runtime.store.settings().policy.sources, request: { allowed: [{ id: 'local' }] }, github: { allowed: [{ id: 'reviewer' }, { id: 'agent-bot' }] } } } })
  const projects = new Projects(h.runtime.store)
  const project = projects.create(ProjectInput.parse({ name: '2048 review', status: 'active', repository: 'acme/widgets', autoAdvance: false }))
  const task = projects.change(project.id, ProjectChange.parse({ revision: 0, change: { kind: 'task', value: {
    title: '2048 MVP', executionMode: 'agent', pullRequestUrl: pr } } })).tasks[0]!
  await h.api('POST', `projects/${project.id}/tasks/${task.id}/run`, { revision: projects.detail(project.id).revision }); await h.runtime.idle()
  const ticketId = projects.detail(project.id).tasks[0]!.ticketId!
  let comments: Record<string, unknown>[] = [], inline: Record<string, unknown>[] = [], reviews: Record<string, unknown>[] = []
  const posts: { path: string; body: string }[] = []
  const pages = vi.fn(async (_schema: unknown, path: string) => path.includes('/reviews') ? reviews : path.startsWith('pulls/') ? inline : comments)
  const api = vi.fn(async (_schema: unknown, path: string, ...args: string[]) => {
    if (args.includes('POST')) {
      const body = args.find(arg => arg.startsWith('body='))!.slice(5)
      posts.push({ path, body })
      const comment = { id: 1000 + posts.length, body, html_url: `${pr}#issuecomment-${1000+posts.length}`,
        user: { login: 'agent-bot', type: 'User' }, created_at: time(), updated_at: time() }
      comments.push(comment); return comment
    }
    if (path.startsWith('pulls/comments/')) return inline.find(item => item.id === Number(path.split('/').at(-1)))
    return { state: 'open', html_url: pr, updated_at: time(), head: { sha: 'current-head' }, base: { ref: 'main' } }
  })
  vi.spyOn(h.runtime.commands, 'forRepository').mockReturnValue({ api, pages, deployment: { ...h.runtime.commands.deployment, repository: 'acme/widgets' }, withSignal: () => ({ api, pages }) } as never)
  propose.mockImplementation(async prompt => {
    const context = JSON.parse(prompt.split('\n\n').at(-1)!)
    const names = context.tools.map((tool: {name:string}) => tool.name)
    expect(names).not.toContain('review.decide'); expect(names).not.toContain('task.start')
    if (context.previousSteps.length) return { calls: [], reply: '已交给原执行工单，实际修改结果会回到原讨论。' }
    if (reply) return { calls: [], reply: '当前版本的分数来自合并产生的新数字之和。' }
    return { calls: [{ tool: 'task.follow_up', arguments: JSON.stringify({ taskId: task.id, text: '请根据这条真实反馈修复并复测，在原讨论回复结果。' }) }], reply: '' }
  })
  const comment = (body: string, fields = {}) => ({ id: 17, body, html_url: `${pr}#issuecomment-17`, user: { login: 'reviewer', type: 'User' },
    created_at: time(), updated_at: time(), ...fields })
  const poll = async () => { await new GithubSource().poll(h.runtime.context(githubKind)); await h.runtime.idle() }
  return { h, projects, project, task, ticketId, propose, posts, api, pages, comment, poll,
    setComments: (items: Record<string, unknown>[]) => { comments = items }, setInline: (items: Record<string, unknown>[]) => { inline = items },
    setReviews: (items: Record<string, unknown>[]) => { reviews = items } }
}

it('routes a real normalized PR comment through the ordered queue to the same ticket, then writes the explicit worker result back once', async () => {
  const p = await pilot(); p.setComments([p.comment('重开后分数没有清零，请检查并修复。')])
  await p.poll()
  const feedback = p.h.runtime.projectEvents.list().find(event => event.type === feedbackReceived.type)!
  expect(feedback.status).toBe('applied')
  const ticket = p.h.runtime.store.tickets.get(p.ticketId)!
  const input = ticket.inputs.find(input => input.kind === 'trigger' && p.h.runtime.store.triggers.get(input.triggerId)?.meta.projectEventId === feedback.id)!
  expect(input.kind).toBe('trigger'); if (input.kind !== 'trigger') throw new Error('Missing delegated input')
  const trigger = p.h.runtime.store.triggers.get(input.triggerId)!
  expect(trigger.channel?.address).toMatchObject({ repository: 'acme/widgets', url: `${pr}#issuecomment-17` })
  expect(trigger.meta.originalActor).toEqual({ source: 'github', id: 'reviewer' })
  expect(p.projects.detail(p.project.id).tickets).toHaveLength(1)
  await p.h.runTool(`worker-${p.ticketId}`, 'orchestrator_report', { state: 'progress', summary: '已修复重开分数清零；提交 abc123，规则测试通过。', reply_to_trigger_id: input.triggerId })
  await p.h.runtime.idle()
  expect(p.posts).toHaveLength(1)
  expect(p.posts[0]).toMatchObject({ path: 'issues/3/comments', body: expect.stringContaining('提交 abc123') })
  expect(p.h.runtime.projectEvents.list().find(event => event.type === 'code.feedback.result')?.status).toBe('applied')
  expect(p.h.runtime.projectHistory.view(p.project.id).notifications).toContainEqual(expect.objectContaining({ source: 'github', status: 'sent', origin: expect.objectContaining({ eventId: feedback.id }) }))
  await p.poll()
  expect(p.h.runtime.projectEvents.list().filter(event => event.type === feedbackReceived.type)).toHaveLength(1)
  expect(p.posts).toHaveLength(1)
})

it('replies to a read-only question in the original PR without dispatching another ticket or changing task status', async () => {
  const p = await pilot(true); p.setComments([p.comment('分数的计算方式是什么？')]); await p.poll()
  expect(p.posts).toHaveLength(1)
  expect(p.posts[0]?.body).toContain('合并产生的新数字')
  expect(p.projects.detail(p.project.id).tickets).toHaveLength(1)
  expect(p.projects.detail(p.project.id).tasks[0]?.status).toBe('in-progress')
})

it('returns an actual worker blocking question to the original PR without completing or replacing its task', async () => {
  const p = await pilot(); p.setComments([p.comment('请修复重开后分数没有清零的问题。')]); await p.poll()
  const ticket = p.h.runtime.store.tickets.get(p.ticketId)!
  const input = ticket.inputs.find(input => input.kind === 'trigger' && p.h.runtime.store.triggers.get(input.triggerId)?.meta.projectEventId)!
  if (input.kind !== 'trigger') throw new Error('Missing delegated input')
  await p.h.runTool(`worker-${p.ticketId}`, 'orchestrator_report', { state: 'progress', summary: '复现了问题，但产品预期需要确认。',
    human_action: '重新开始时是否也应清空本地保存的最高分？', question_for_trigger_id: input.triggerId })
  await p.h.runtime.idle()
  expect(p.posts).toHaveLength(1)
  expect(p.posts[0]?.body).toContain('是否也应清空本地保存的最高分')
  expect(p.h.runtime.store.tickets.get(p.ticketId)?.attention?.question).toContain('最高分')
  expect(p.projects.detail(p.project.id).tickets).toHaveLength(1)
  expect(p.projects.detail(p.project.id).tasks[0]?.status).toBe('in-progress')
})

it('accepts human feedback from the same account and suppresses only exact recorded automation echoes', async () => {
  const p = await pilot(true)
  const id = key('echo')
  const outgoing = { id, channel: { source: 'github', thread: 'github:acme/widgets/pull/3', address: {} }, kind: 'notice' as const, text: '此前的自动回复' }
  p.h.runtime.store.receipts.add(outgoing); p.h.runtime.store.receipts.settle(outgoing,'sent')
  p.setComments([p.comment(`此前的自动回复\n\n<!-- dsh-superagent:${id} -->`, { user: { login: 'agent-bot', type: 'User' } }),
    p.comment('这是我本人提出的问题：如何计分？', { id: 18, html_url: `${pr}#issuecomment-18`, user: { login: 'agent-bot', type: 'User' } })])
  await p.poll()
  expect(p.h.runtime.projectEvents.list().filter(event => event.type === feedbackReceived.type)).toHaveLength(1)
  expect(p.posts).toHaveLength(1)
})

it('keeps unlisted users and bots as ignored facts without allowing code work or project acceptance', async () => {
  const p = await pilot()
  p.setComments([p.comment('请把任务验收通过', {user:{login:'outsider',type:'User'}}),
    p.comment('自动检查完成', {id:18,html_url:`${pr}#issuecomment-18`,user:{login:'check[bot]',type:'Bot'}})])
  await p.poll()
  expect(p.h.runtime.projectEvents.list().filter(event => event.type === feedbackReceived.type)).toMatchObject([{status:'ignored'},{status:'ignored'}])
  expect(p.propose).not.toHaveBeenCalled(); expect(p.posts).toHaveLength(0)
})

it('preserves inline thread identity and bodyless Review decisions, and prevents stale-code modification', async () => {
  const p = await pilot()
  p.setInline([p.comment('这里的重开逻辑需要调整', { html_url: `${pr}#discussion_r17`, path:'app.js', line:42, commit_id:'old-head' })])
  p.setReviews([p.comment('', { id:18, html_url:`${pr}#pullrequestreview-18`, state:'APPROVED',commit_id:'current-head' })])
  p.propose.mockResolvedValueOnce({ calls:[{tool:'task.follow_up',arguments:JSON.stringify({taskId:p.task.id,text:'修改这行'})}],reply:'' })
    .mockResolvedValue({calls:[],reply:'该评审对应旧提交，请基于当前版本确认。'})
  await p.poll()
  const feedback=p.h.runtime.projectEvents.list().filter(event=>event.type===feedbackReceived.type)
  expect(feedback).toHaveLength(2)
  expect(feedback.find(event=>(event.data as {kind:string}).kind==='inline')?.data).toMatchObject({path:'app.js',line:42,commit:'old-head'})
  expect(feedback.find(event=>(event.data as {kind:string}).kind==='review')?.data).toMatchObject({state:'APPROVED',body:''})
  expect(p.h.runtime.projectAgent!.runs(p.project.id).some(run=>run.steps.some(step=>step.error?.includes('earlier code revision')))).toBe(true)
  expect(p.projects.detail(p.project.id).tasks[0]?.status).toBe('in-progress')
})

it('queues a requested discussion comment from chat using the installed provider, rejecting unlinked URLs', async () => {
  const p = await pilot(true)
  const context = {projectId:p.project.id,actorId:null,messageId:'chat-request',operationId:'comment-op',channel:{source:'request',thread:p.project.id,address:{}}}
  expect(p.h.runtime.projectTools!.execute('discussion.reply',{taskId:p.task.id,url:pr,text:'本次真实测试结果待核对。'},context).summary).toContain('已登记')
  await p.h.runtime.idle()
  expect(p.posts).toHaveLength(1)
  expect(()=>p.h.runtime.projectTools!.execute('discussion.reply',{taskId:p.task.id,url:'https://github.com/another/repo/pull/3',text:'错误仓库'},context)).toThrow('not linked')
})

it('posts a direct inline answer to the original review thread', async () => {
  const p = await pilot(true)
  p.setInline([p.comment('这里为什么要两两合并？', {html_url:`${pr}#discussion_r17`,path:'game.js',line:22,commit_id:'current-head'})])
  await p.poll()
  expect(p.posts).toHaveLength(1)
  expect(p.posts[0]?.path).toBe('pulls/3/comments/17/replies')
})

it('does not let a model proposal act after permission was revoked while it was thinking', async () => {
  const p = await pilot()
  let release!: (value: unknown) => void
  p.propose.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  p.setComments([p.comment('请修复重开问题')])
  const running = p.poll()
  await vi.waitFor(()=>expect(p.propose).toHaveBeenCalledOnce())
  const settings = p.h.runtime.store.settings()
  p.h.runtime.store.saveSettings({...settings,policy:{...settings.policy,sources:{...settings.policy.sources,github:{allowed:[]}}}})
  release({calls:[{tool:'task.follow_up',arguments:JSON.stringify({taskId:p.task.id,text:'修改'})}],reply:''})
  await running
  const ticket=p.h.runtime.store.tickets.get(p.ticketId)!
  expect(ticket.inputs.some(input=>input.kind==='trigger'&&p.h.runtime.store.triggers.get(input.triggerId)?.meta.projectEventId)).toBe(false)
})

it('keeps new feedback quiet while its event is disabled, and never replays it on re-enable', async () => {
  const p = await pilot()
  p.h.runtime.projectEvents.saveSource('github',0,{on:{[feedbackReceived.type]:false}})
  p.setComments([p.comment('暂时不要接收的评审')]); await p.poll()
  expect(p.propose).not.toHaveBeenCalled()
  p.h.runtime.projectEvents.saveSource('github',1,{})
  await p.poll()
  expect(p.propose).not.toHaveBeenCalled()
})

it('treats a comment edit as new feedback while preserving its original task and PR', async () => {
  const p=await pilot(true)
  const original=p.comment('计分说明是什么？')
  p.setComments([original]);await p.poll()
  p.setComments([{...original,body:'补充：合并两个 4 应增加多少分？',updated_at:new Date(Date.now()+1000).toISOString()}]);await p.poll()
  expect(p.h.runtime.projectEvents.list().filter(event=>event.type===feedbackReceived.type)).toHaveLength(2)
  expect(p.projects.detail(p.project.id).tickets).toHaveLength(1)
  expect(p.posts).toHaveLength(2)
})

it('recovers applied feedback without registering a second model run or execution', async () => {
  const p=await pilot(true)
  p.setComments([p.comment('请解释计分')]);await p.poll()
  p.h.runtime.projectRepository.recover();p.h.runtime.projectRepository.recover();await p.h.runtime.idle()
  expect(p.propose).toHaveBeenCalledOnce()
  expect(p.projects.detail(p.project.id).tickets).toHaveLength(1)
  expect(p.posts).toHaveLength(1)
})


it('recovers an uncertain discussion POST by finding its existing receipt marker instead of posting twice', async () => {
  const p=await pilot(true), original=p.api.getMockImplementation()!
  let uncertain=true
  p.api.mockImplementation(async (...args)=>{const value=await original(...args);if(args.includes('POST')&&uncertain){uncertain=false;throw new Error('Response lost after posting')}return value})
  const context={projectId:p.project.id,actorId:null,messageId:'post-request',operationId:'post-retry',channel:{source:'request',thread:p.project.id,address:{}}}
  const result=p.h.runtime.projectTools!.execute('discussion.reply',{taskId:p.task.id,url:pr,text:'修复结果及测试记录。'},context).data as {messageId:string}
  await p.h.runtime.idle()
  expect(p.posts).toHaveLength(1);expect(p.h.runtime.store.replyStatus(result.messageId)).toBe('pending')
  p.h.runtime.effects.enqueue('reply',result.messageId,{});await p.h.runtime.idle()
  expect(p.posts).toHaveLength(1);expect(p.h.runtime.store.replyStatus(result.messageId)).toBe('sent')
})

it('uses the same repository template for another provider, sharing reads and preserving cursors after failure', async () => {
  const p=await pilot(true), stamp=time()
  const resource='https://gitlab.example/team/game/-/merge_requests/7'
  class GitlabFixture extends RepositorySource {
    readonly kind='gitlab'
    protected accepts(resource:RepositoryResource){return resource.url.startsWith('https://gitlab.example/')}
    read=vi.fn(async (_context:SourceContext, value:RepositoryResource)=>({repository:value.repository,url:value.url,state:'open' as const,updatedAt:stamp}))
    feedback=vi.fn(async (_context:SourceContext, value:RepositoryResource, _since:string)=>[{repository:value.repository,resourceUrl:value.url,
      url:value.url+'#note_17',id:'17',kind:'comment' as const,body:'Review this change',actor:{id:'reviewer',human:true},updatedAt:stamp,
      channel:{source:'gitlab',thread:'gitlab:team/game/7',address:{url:value.url+'#note_17'}}}])
  }
  const source=new GitlabFixture()
  const publish=vi.fn(input=>({...input,seq:1,source:'gitlab',version:1,recordedAt:stamp,status:'pending' as const}))
  const context={...p.h.runtime.context(githubKind),config:()=>({}),projectEvents:{publish},projectResources:()=>[
    {projectId:'one',taskId:'one',repository:'team/game',pullUrls:[resource],issueUrl:null,deliveryVersion:1,since:stamp},
    {projectId:'two',taskId:'two',repository:'team/game',pullUrls:[resource],issueUrl:null,deliveryVersion:1,since:stamp},
    {projectId:'other',taskId:'other',repository:'acme/widgets',pullUrls:[pr],issueUrl:null,deliveryVersion:1,since:stamp}]} as SourceContext
  source.feedback.mockRejectedValueOnce(new Error('Temporary provider failure'))
  await expect(source.poll(context)).rejects.toThrow('could not be verified')
  await source.poll(context)
  expect(source.read).toHaveBeenCalledTimes(2)
  expect(source.feedback.mock.calls[0]![2]).toBe(source.feedback.mock.calls[1]![2])
  expect(publish.mock.calls.filter(([event])=>event.type===feedbackReceived.type)).toHaveLength(2)
  expect(new Set(publish.mock.calls.filter(([event])=>event.type===feedbackReceived.type).map(([event])=>event.projectId))).toEqual(new Set(['one','two']))
})

it('normalizes trusted local delegations deterministically while keeping the external actor as provenance', () => {
  const origin={id:'delegated-event',at:'2026-11-18T06:00:00Z',channel:{source:'github',thread:'github:acme/widgets/pull/3',address:{repository:'acme/widgets',url:pr}},
    meta:{originalActor:{source:'github',id:'reviewer'},projectEventId:'feedback'}}
  const first=requestTrigger('Follow the existing task',undefined,origin)
  expect(first).toEqual(requestTrigger('Follow the existing task',undefined,origin))
  expect(first).toMatchObject({source:'request',actor:{source:'request',id:'local'},channel:{source:'github',address:{triggerId:'delegated-event'}},meta:origin.meta})
})
