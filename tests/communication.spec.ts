import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { ProjectInput, Projects } from '../src/app/projects.ts'
import { preferenceRequested } from '../src/app/communication.ts'
import { dingTalkKind, dingTalkRoute } from '../src/sources/dingtalk.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { deferred } from './fixtures/async.ts'
import type { OutboundMessage } from '../src/core/index.ts'
let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })
async function pilot() {
  const propose = vi.fn(async (_prompt: string, schema: object, _signal: AbortSignal): Promise<unknown> =>
    'summary' in (schema as { properties: object }).properties ? { summary: '代码已保存，验证仍有环境限制。' } : { calls: [], reply: '已读取当前结果。' })
  const h = host = await startRuntime(undefined, undefined, undefined, undefined, undefined, { name: 'Communication Agent', propose })
  const projects = new Projects(h.runtime.store)
  const project = projects.create(ProjectInput.parse({ name: 'Communication pilot', dingTalkGroup: 'group', status: 'planning', autoAdvance: false }))
  projects.addDingTalkSender(project.id, 'corp', 'owner', 'Member')
  const member = projects.detail(project.id).members[0]!
  const channel = { source: 'dingtalk', thread: 'dingtalk:group', address: { conversationId: 'group' } }
  const send = vi.fn(async (_message: OutboundMessage) => {})
  h.runtime.sources.register(dingTalkKind(send))
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, dingtalk: { enabled: true, config: {} } } })
  h.runtime.store.set(dingTalkRoute('group'), { conversationId: 'group', corpId: 'corp', robotCode: 'robot', webhook: 'https://oapi.dingtalk.com/robot/send', expires: 0 })
  const context = (operationId: string) => ({ projectId: project.id, actorId: member.id, operationId, messageId: operationId, channel })
  const update = async (requestId = 'preference', revision = 0, format: 'text' | 'markdown' = 'markdown') => {
    const response = await h.api('PUT', `projects/${project.id}/conversation-preferences`, { requestId, revision,
      value: { format, instruction: '先结论，用加粗突出卡点和下一步。' } })
    expect(response.status, JSON.stringify(response.body)).toBe(200); await h.runtime.idle(); send.mockClear(); return response
  }
  const notice = (id = 'system-notice'): OutboundMessage => ({ id, channel, kind: 'notice', text: 'Stored raw evidence',
    presentation: { title: 'Test delivery', status: '待回答', summary: '任务尚未完成交付。', action: '请本机管理者核对执行限制，群内同意不会授予权限。',
      evidence: 'request:internal-id\n'.repeat(150) + 'Code exists; browser verification is blocked.', reference: '〔交付第 1 版 · 验收 abcdef12〕', details: '项目看板 → 任务详情' } })
  return { h, projects, project, member, channel, propose, send, context, update, notice }
}
it('turns the actual natural-language request into a persisted conversation setting through an Agent tool and event', async () => {
  const { h, project, channel, propose, context, send } = await pilot()
  propose.mockImplementationOnce(async prompt => {
    expect(prompt).toContain('下次给出消息的时候，能不能使用markdown格式，highlight一下重点')
    expect(prompt).toContain('conversation.preferences.update')
    return { calls: [{ tool: 'conversation.preferences.update', arguments: JSON.stringify({ revision: 0, value: { format: 'markdown', instruction: '突出结论、卡点和下一步。' } }) }], reply: '' }
  }).mockImplementationOnce(async prompt => {
    expect(prompt).toContain('"revision":1')
    return { calls: [], reply: '**已设置本群后续回复**：Markdown，突出结论和下一步。' }
  })
  const { operationId, ...origin } = context('style-request')
  h.runtime.projectAgent!.submit({ ...origin, messageId: operationId, text: '下次给出消息的时候，能不能使用markdown格式，highlight一下重点', quoted: '' })
  await h.runtime.idle()
  expect(h.runtime.communication.read(channel)).toMatchObject({ revision: 1, value: { format: 'markdown' } })
  expect(new Projects(h.runtime.store).detail(project.id)).toMatchObject({ status: 'planning', tasks: [], tickets: [] })
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ format: 'markdown', text: expect.stringContaining('已设置本群') }))
  expect(h.runtime.projectEvents.list()).toEqual(expect.arrayContaining([expect.objectContaining({ type: preferenceRequested.type, status: 'applied' })]))
})
it('keeps temporary reply instructions out of persistent preferences', async () => {
  const { h, project, context, channel, propose } = await pilot()
  propose.mockResolvedValueOnce({ calls: [], reply: '- 当前任务还未开始。' })
  const { operationId, ...origin } = context('one-time')
  h.runtime.projectAgent!.submit({ ...origin, messageId: operationId, text: '这条回复简单列一下即可，不改以后的设置。', quoted: '' })
  await h.runtime.idle()
  expect(h.runtime.communication.read(channel).revision).toBe(0)
  expect(h.runtime.projectAgent!.runs(project.id)[0]?.steps).toEqual([])
})
it('retains the preference across project replacement in the same group and isolates another group', async () => {
  const { h, projects, project, channel, update } = await pilot()
  await update()
  projects.change(project.id, { revision: projects.detail(project.id).revision, change: { kind: 'project', value: ProjectInput.parse({ name: project.name, status: 'archived', dingTalkGroup: null }) } })
  projects.create(ProjectInput.parse({ name: 'Next project', dingTalkGroup: 'group' }))
  expect(h.runtime.communication.read(channel).value.format).toBe('markdown')
  expect(h.runtime.communication.read({ source: 'dingtalk', thread: 'dingtalk:other' }).revision).toBe(0)
  expect(h.runtime.store.keys(KV.communication.preference)).toHaveLength(1)
})
it('makes duplicate preference requests idempotent and rejects stale revisions', async () => {
  const { h, project, update } = await pilot()
  const first = await update(); const second = await update()
  expect(second.body).toMatchObject({ eventId: first.body.eventId, status: 'applied' })
  expect(await h.api('PUT', `projects/${project.id}/conversation-preferences`, { requestId: 'stale', revision: 0, value: { format: 'text', instruction: '' } })).toMatchObject({ status: 409 })
})
it('rejects unauthorized and cross-group preference changes', async () => {
  const { h, context } = await pilot()
  expect(() => h.runtime.communication.update({ ...context('unknown'), actorId: 'unknown' }, 0, { format: 'markdown', instruction: '' })).toThrow('成员')
  expect(() => h.runtime.communication.update(context('cross-group'), 0, { format: 'markdown', instruction: '' },
    { source: 'dingtalk', thread: 'other', address: { conversationId: 'other' } })).toThrow('当前项目群')
})
it('serializes competing preference changes and honors the event switch', async () => {
  const { h, context, channel } = await pilot()
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  h.runtime.communication.update(context('first'), 0, { format: 'markdown', instruction: 'First' })
  h.runtime.communication.update(context('second'), 0, { format: 'text', instruction: 'Second' })
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: false }); await h.runtime.idle()
  expect(h.runtime.communication.read(channel).value.instruction).toBe('First')
  expect(h.runtime.projectEvents.list().filter(e => e.type === preferenceRequested.type).map(e => e.status).sort()).toEqual(['applied', 'ignored'])
  await h.api('PUT', 'projects/workflow', { revision: 0, config: { on: { [preferenceRequested.type]: false } } })
  h.runtime.communication.update(context('disabled'), 1, { format: 'text', instruction: 'Disabled' }); await h.runtime.idle()
  expect(h.runtime.communication.read(channel).value.format).toBe('markdown')
})
it('summarizes long evidence while preserving server-owned state, action and review reference', async () => {
  const { h, update, notice, send, propose } = await pilot()
  await update()
  h.runtime.communication.notify(notice()); await h.runtime.idle()
  expect(propose).toHaveBeenCalledWith(expect.stringContaining('request:internal-id'), expect.anything(), expect.anything())
  const message = send.mock.calls[0]![0]
  expect(message).toMatchObject({ format: 'markdown', title: 'Test delivery' })
  expect(message.text).toContain('**状态：**待回答')
  expect(message.text).toContain('代码已保存，验证仍有环境限制')
  expect(message.text).toContain('群内同意不会授予权限')
  expect(message.text).toContain('验收 abcdef12')
  expect(message.text).not.toContain('request:internal-id')
  expect(message.text.length).toBeLessThan(650)
  h.runtime.communication.notify(notice()); await h.runtime.idle()
  expect(send).toHaveBeenCalledOnce()
})
it('retains essential facts and a detail entry if the summary provider is unavailable', async () => {
  const { h, notice, send, propose } = await pilot()
  propose.mockRejectedValue(new Error('provider down'))
  h.runtime.communication.notify(notice()); await h.runtime.idle()
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('任务尚未完成交付') }))
  expect(send.mock.calls[0]![0].text).not.toContain('request:internal-id')
})
it('withdraws a stale reminder even while its model summary is running', async () => {
  const { h, notice, send, propose } = await pilot()
  const pending = deferred<unknown>()
  propose.mockImplementationOnce(() => pending.promise)
  h.runtime.communication.notify(notice())
  await vi.waitFor(() => expect(propose).toHaveBeenCalledOnce())
  h.runtime.communication.withdraw('system-notice')
  pending.resolve({ summary: 'A late summary' }); await h.runtime.idle()
  expect(send).not.toHaveBeenCalled()
  expect(h.runtime.store.get(KV.communication.notice('system-notice'))?.status).toBe('withdrawn')
})
it('recomposes under the latest preference instead of sending an old presentation', async () => {
  const { h, notice, send, propose } = await pilot()
  const pending = deferred<unknown>()
  propose.mockImplementationOnce(() => pending.promise)
  h.runtime.communication.notify(notice())
  await vi.waitFor(() => expect(propose).toHaveBeenCalledOnce())
  // The event queue commits the new preference while the independent composer is awaiting the provider.
  const projects = new Projects(h.runtime.store).list()
  await h.api('PUT', `projects/${projects[0]!.id}/conversation-preferences`, { requestId: 'while-composing', revision: 0, value: { format: 'markdown', instruction: 'Latest instruction' } })
  await h.runtime.effects.idle('project-events')
  pending.resolve({ summary: 'Old style' }); await h.runtime.idle()
  expect(send.mock.calls.map(([message]) => message).find(message => message.id === 'system-notice')?.format).toBe('markdown')
  expect(propose).toHaveBeenCalledTimes(2)
  expect(propose.mock.calls[1]![0]).toContain('Latest instruction')
})
it('exposes real capability facts without inventing a documentation lookup or chat approval bridge', async () => {
  const { h, context } = await pilot()
  const value = h.runtime.projectTools!.execute('runtime.inspect', {}, context('inspect')).data as { documentationLookup: boolean; communication: { channels: { source: string; transports: string[] }[] } }
  expect(value.documentationLookup).toBe(false)
  expect(value.communication.channels.find(channel => channel.source === 'dingtalk')?.transports).toEqual(['session-webhook (text/markdown)', 'application-group-api (sampleText/sampleMarkdown)'])
})
it('reloads the saved conversation preference after a full runtime restart without recreating a project', async () => {
  const { h, update, channel } = await pilot()
  await update()
  const entries = h.runtime.store.keys(KV.communication.preference).map(key => [key, h.runtime.store.get(key)!] as const)
  await h.stop(); host = undefined
  const resumed = host = await startRuntime(store => { for (const [key, value] of entries) store.set(key, value) })
  expect(resumed.runtime.communication.read(channel)).toMatchObject({ revision: 1, value: { format: 'markdown' } })
  expect(new Projects(resumed.runtime.store).list()).toEqual([])
})
it('ships the default event JSON and its explanation', () => {
  expect(JSON.parse(readFileSync(new URL('../config/events/communication.defaults.json', import.meta.url), 'utf8'))).toMatchObject({ sources: { communication: { on: { [preferenceRequested.type]: { enabled: true, description: preferenceRequested.description } } } } })
  expect(readFileSync(new URL(`../${preferenceRequested.documentation}`, import.meta.url), 'utf8')).toContain(preferenceRequested.type)
})
