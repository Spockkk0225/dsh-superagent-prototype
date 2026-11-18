import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { currentReview, reviewReference } from '../src/app/project-deliveries.ts'
import { ProjectChange, ProjectInput, Projects, TaskInput } from '../src/app/projects.ts'
import { reviewAccepted, reviewRejected, reviewRequested, type ReviewContext } from '../src/app/project-reviews.ts'
import { dingTalkKind, dingTalkRoute } from '../src/sources/dingtalk.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })
async function pilot(group: string | null = 'group') {
  const propose = vi.fn(async (_prompt: string, _schema: object, _signal: AbortSignal): Promise<unknown> => ({ calls: [], reply: '已核对实际结果。' }))
  const h = host = await startRuntime(undefined, undefined, undefined, undefined, undefined, { name: 'Review test Agent', propose })
  const projects = new Projects(h.runtime.store)
  const project = projects.create(ProjectInput.parse({ name: 'Review pilot', dingTalkGroup: group, autoAdvance: false }))
  const id = project.id
  projects.addDingTalkSender(id, 'corp', 'owner', 'Owner')
  projects.addDingTalkSender(id, 'corp', 'other', 'Other')
  const owner = projects.memberForAccount(id, 'dingtalk', 'corp', 'owner')!
  const other = projects.memberForAccount(id, 'dingtalk', 'corp', 'other')!
  const change = (change: ProjectChange['change']) => projects.change(id, ProjectChange.parse({ revision: projects.detail(id).revision, change }))
  const task = change({ kind: 'task', value: { title: 'Evaluate experiment', ownerId: owner.id, executionMode: 'manual', acceptance: 'Reproducible evidence' } }).tasks[0]!
  const send = vi.fn(async () => {})
  h.runtime.sources.register(dingTalkKind(send))
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, dingtalk: { enabled: true, config: {} } },
    policy: { ...settings.policy, sources: { ...settings.policy.sources, request: { allowed: [{ id: 'local' }] } } } })
  h.runtime.store.set(dingTalkRoute('group'), { conversationId: 'group', corpId: 'corp', robotCode: 'robot', expires: 0, webhook: 'https://oapi.dingtalk.com/robot/send' })
  const context = (operationId: string, actorId: string | null = owner.id): ReviewContext => ({ projectId: id, actorId, operationId,
    channel: actorId === null ? { source: 'request', thread: id, address: { projectId: id } } : { source: 'dingtalk', thread: 'group', address: { conversationId: 'group' } } })
  const readTask = () => projects.detail(id).tasks.find(item => item.id === task.id)!
  const submit = async (messageId = 'delivery') => {
    const response = await h.api('POST', `projects/${id}/tasks/${task.id}/deliveries`, { messageId, summary: 'Experiment output and repeatable results', links: ['https://example.com/result'] })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    await h.runtime.idle()
    return currentReview(readTask())!
  }
  const decide = async (reviewId: string, outcome: 'accepted' | 'rejected', messageId: string = outcome) => {
    const response = await h.api('POST', `projects/${id}/tasks/${task.id}/reviews/${reviewId}`, { messageId, outcome, reason: outcome === 'accepted' ? 'Checked all evidence' : 'Add missing boundary cases' })
    await h.runtime.idle(); return response
  }
  return { h, projects, id, owner, other, task, change, readTask, submit, decide, context, send, propose }
}
it('captures manual evidence and requirements once, notifies the bound reviewer and preserves the accepted decision', async () => {
  const { h, id, owner, readTask, submit, decide, send, projects } = await pilot()
  const review = await submit()
  expect(readTask()).toMatchObject({ status: 'in-review', deliveryVersion: 1, reviews: [{ status: 'pending', requirements: { ownerId: owner.id, acceptance: 'Reproducible evidence' }, evidence: { summary: 'Experiment output and repeatable results' } }] })
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining(reviewReference(review)), channel: expect.objectContaining({ address: { conversationId: 'group', mentionUserId: 'owner' } }) }))
  expect(await decide(review.id, 'accepted')).toMatchObject({ status: 200 })
  expect(readTask()).toMatchObject({ status: 'done', completedAt: expect.any(String), reviews: [{ status: 'accepted', decision: { actorId: null, source: 'request', reason: 'Checked all evidence' } }] })
  expect(projects.detail(id).tickets).toEqual([])
  expect(h.runtime.projectEvents.list({ projectId: id })).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'review.accepted', status: 'applied' })]))
})
it('retries the same delivery and decision idempotently, and rejects reuse with different evidence', async () => {
  const { h, id, task, readTask, submit, decide } = await pilot()
  const review = await submit(); const first = await decide(review.id, 'accepted')
  expect(await decide(review.id, 'accepted')).toMatchObject({ status: 200, body: { eventId: first.body.eventId, status: 'applied' } })
  await submit()
  expect(readTask().reviews).toHaveLength(1)
  expect(await h.api('POST', `projects/${id}/tasks/${task.id}/deliveries`, { messageId: 'delivery', summary: 'Different result' })).toMatchObject({ status: 409 })
})
it('checks current member identity, project group and the assigned reviewer on both submission and application', async () => {
  const { h, task, submit, other, owner, context, change, readTask } = await pilot()
  const review = await submit(); const reviews = h.runtime.projectReviews
  expect(() => reviews.decide(context('other', other.id), task.id, review.id, 'accepted', 'Looks fine')).toThrow('负责人')
  expect(() => reviews.decide({ ...context('wrong-group'), channel: { source: 'dingtalk', thread: 'wrong', address: { conversationId: 'wrong' } } }, task.id, review.id, 'accepted', 'Fine')).toThrow('另一个')
  expect(() => reviews.decide(context('unknown', 'unknown'), task.id, review.id, 'accepted', 'Fine')).toThrow('成员')
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  reviews.decide(context('owner'), task.id, review.id, 'accepted', 'Verified')
  change({ kind: 'task', id: task.id, value: { ...TaskInput.strip().parse(readTask()), ownerId: other.id } })
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: false }); await h.runtime.idle()
  expect(readTask().status).not.toBe('done')
  expect(readTask().reviews?.[0]?.requirements.ownerId).toBe(owner.id)
})
it('serializes simultaneous board acceptance and group rejection with exactly one valid decision', async () => {
  const { h, id, task, submit, context, readTask, send } = await pilot()
  const review = await submit(); send.mockClear()
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  h.runtime.projectReviews.decide(context('board', null), task.id, review.id, 'accepted', 'Checked from board')
  h.runtime.projectReviews.decide(context('group'), task.id, review.id, 'rejected', 'Missing a case')
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: false }); await h.runtime.idle()
  expect(readTask()).toMatchObject({ status: 'done', reviews: [{ status: 'accepted', decision: { reason: 'Checked from board' } }] })
  const results = h.runtime.projectEvents.list({ projectId: id }).filter(event => ['review.accepted', 'review.rejected'].includes(event.type))
  expect(results.map(event => event.status).sort()).toEqual(['applied', 'ignored'])
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('已结束或交付已更新') }))
})
it('retains a rejected delivery and requires new evidence before a later acceptance', async () => {
  const { h, readTask, submit, decide } = await pilot()
  const first = await submit(); await decide(first.id, 'rejected')
  expect(readTask()).toMatchObject({ status: 'in-progress', completedAt: null, reviews: [{ status: 'rejected', decision: { reason: 'Add missing boundary cases' } }] })
  const second = await submit('corrected')
  expect(second.version).toBe(2)
  expect(second.id).not.toBe(first.id)
  expect(await decide(first.id, 'accepted', 'old-reply')).toMatchObject({ status: 409 })
  expect(readTask().status).toBe('in-review')
  await decide(second.id, 'accepted', 'new-reply')
  expect(readTask().reviews?.map(review => review.status)).toEqual(['rejected', 'accepted'])
  expect(h.runtime.effects.pending('launch')).toBe(false)
})
it('invalidates a review when scope changes while priority-only edits preserve its version', async () => {
  const { task, readTask, submit, change, decide } = await pilot()
  const first = await submit()
  change({ kind: 'task-priority', id: task.id, priority: 'do' })
  expect(currentReview(readTask())?.id).toBe(first.id)
  change({ kind: 'task', id: task.id, value: { ...TaskInput.strip().parse(readTask()), acceptance: 'New acceptance scope' } })
  expect(readTask()).toMatchObject({ status: 'in-progress', deliveryVersion: 2, reviews: [{ status: 'superseded', requirements: { acceptance: 'Reproducible evidence' } }] })
  const second = await submit('new-scope')
  expect(second.version).toBe(2)
  expect(await decide(first.id, 'accepted')).toMatchObject({ status: 409 })
})
it('binds a quoted old review before Agent inference and prevents the Agent from swapping in the newest review', async () => {
  const { h, id, task, submit, decide, propose, readTask, context } = await pilot()
  const first = await submit(); await decide(first.id, 'rejected'); const second = await submit('new-evidence')
  propose.mockResolvedValueOnce({ calls: [{ tool: 'review.decide', arguments: JSON.stringify({ taskId: task.id, reviewId: second.id, outcome: 'accepted', reason: 'User approved' }) }], reply: '' })
  const { operationId, ...origin } = context('quoted')
  h.runtime.projectAgent!.submit({ ...origin, messageId: operationId, text: '我看过这版可以了', quoted: reviewReference(first) })
  await h.runtime.idle()
  const run = h.runtime.projectAgent!.runs(id)[0]!
  expect(run.message.reviewId).toBe(first.id)
  expect(run.steps[0]?.error).toContain('不能自动换成本版')
  expect(readTask().status).toBe('in-review')
})
it('uses the same Agent tool for an authorized natural-language review with no command keyword gate', async () => {
  const { h, id, task, context, submit, readTask, propose } = await pilot()
  const review = await submit()
  propose.mockImplementationOnce(async prompt => {
    expect(prompt).toContain('这些边界我都试过了，这版可以交了')
    expect(prompt).toContain(review.id)
    return { calls: [{ tool: 'review.decide', arguments: JSON.stringify({ taskId: task.id, reviewId: review.id, outcome: 'accepted', reason: '成员已验证全部边界' }) }], reply: '' }
  })
  const { operationId, ...origin } = context('natural')
  h.runtime.projectAgent!.submit({ ...origin, messageId: operationId, text: '这些边界我都试过了，这版可以交了', quoted: reviewReference(review) })
  await h.runtime.idle()
  expect(readTask()).toMatchObject({ status: 'done', reviews: [{ decision: { source: 'dingtalk', reason: '成员已验证全部边界' } }] })
  expect(h.runtime.projectAgent!.runs(id)[0]?.status).toBe('completed')
})
it('sends one final result for a group review instead of an event broadcast plus an Agent echo', async () => {
  const { h, task, context, submit, propose, send, readTask } = await pilot()
  const review = await submit(); send.mockClear()
  propose.mockResolvedValueOnce({ calls: [{ tool: 'review.decide', arguments: JSON.stringify({ taskId: task.id, reviewId: review.id, outcome: 'accepted', reason: 'Member checked the evidence' }) }], reply: '' })
    .mockResolvedValueOnce({ calls: [], reply: '**验收通过**，当前任务已完成。' })
  const { operationId, ...origin } = context('one-final-result')
  h.runtime.projectAgent!.submit({ ...origin, messageId: operationId, text: '检查过了，这版通过。', quoted: reviewReference(review) })
  await h.runtime.idle()
  expect(readTask().status).toBe('done')
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: '**验收通过**，当前任务已完成。' }))
})
it.each(['accepted', 'rejected'] as const)('disables review.%s through JSON without changing state or silently applying a queued decision', async outcome => {
  const { h, readTask, submit, decide } = await pilot()
  const review = await submit()
  await h.api('PUT', 'projects/workflow', { revision: 0, config: { on: { [`review.${outcome}`]: false } } })
  expect(await decide(review.id, outcome)).toMatchObject({ status: 200, body: { status: 'disabled' } })
  expect(readTask().status).toBe('in-review')
  expect(h.runtime.projectEvents.list()[0]).toMatchObject({ type: `review.${outcome}`, status: 'ignored' })
})
it('disables review requests without creating a snapshot or sending a notification', async () => {
  const { h, submit, readTask, send } = await pilot()
  await h.api('PUT', 'projects/workflow', { revision: 0, config: { on: { 'review.requested': false } } })
  await submit()
  expect(readTask().reviews).toBeUndefined()
  expect(send).not.toHaveBeenCalled()
  expect(h.runtime.projectEvents.list()[0]).toMatchObject({ type: 'review.requested', status: 'ignored' })
})
it('blocks state-edit bypasses and rejects spoofed local review identities and empty rejection reasons', async () => {
  const { h, id, task, submit, readTask } = await pilot()
  const path = `projects/${id}`
  expect(await h.api('POST', `${path}/changes`, { revision: readTask().deliveryVersion ?? 0, change: { kind: 'task-status', id: task.id, status: 'done' } })).toMatchObject({ status: 409 })
  const review = await submit()
  expect(await h.api('POST', `${path}/tasks/${task.id}/reviews/${review.id}`, { messageId: 'spoof', outcome: 'accepted', reason: 'Verified', actorId: 'other' })).toMatchObject({ status: 400 })
  expect(await h.api('POST', `${path}/tasks/${task.id}/reviews/${review.id}`, { messageId: 'empty', outcome: 'rejected', reason: '  ' })).toMatchObject({ status: 400 })
  expect(await h.api('POST', `${path}/tasks/${task.id}/deliveries`, { messageId: 'unsafe-link', summary: 'Evidence', links: ['javascript:alert(1)'] })).toMatchObject({ status: 400 })
  expect(readTask().status).toBe('in-review')
})
it('does not accept evidence queued before a task scope change', async () => {
  const { h, id, task, readTask, change } = await pilot()
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  await h.api('POST', `projects/${id}/tasks/${task.id}/deliveries`, { messageId: 'racing', summary: 'Old evidence' })
  change({ kind: 'task', id: task.id, value: { ...TaskInput.strip().parse(readTask()), acceptance: 'A different experiment' } })
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: false }); await h.runtime.idle()
  expect(readTask().reviews).toBeUndefined()
  expect(h.runtime.projectEvents.list().find(event => event.type === 'review.requested')).toMatchObject({ status: 'ignored', reason: expect.stringContaining('已变化') })
})
it('creates versioned reviews from real worker completion and never reuses a rejected report', async () => {
  const { h, id, task, readTask, change, decide } = await pilot()
  change({ kind: 'task', id: task.id, value: { ...TaskInput.strip().parse(readTask()), executionMode: 'agent' } })
  const run = async () => {
    expect(await h.api('POST', `projects/${id}/tasks/${task.id}/run`, { revision: new Projects(h.runtime.store).detail(id).revision })).toMatchObject({ status: 200 })
    await h.runtime.idle()
    const ticketId = readTask().ticketId!
    await h.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'ready', summary: 'Worker evidence' }); await h.runtime.idle()
    return currentReview(readTask())!
  }
  const first = await run()
  expect(first.evidence).toMatchObject({ ticketId: readTask().ticketId, reportAt: expect.any(String) })
  await decide(first.id, 'rejected')
  h.runtime.deliveryReady.recover(); await h.runtime.idle()
  expect(readTask().status).toBe('in-progress')
  const second = await run()
  expect(second.version).toBe(2)
  expect(second.evidence.ticketId).not.toBe(first.evidence.ticketId)
})
it('protects the scope of the very first active delivery before any review has been created', async () => {
  const { h, id, task, readTask, change, context } = await pilot()
  change({ kind: 'task', id: task.id, value: { ...TaskInput.strip().parse(readTask()), executionMode: 'agent' } })
  expect(await h.api('POST', `projects/${id}/tasks/${task.id}/run`, { revision: new Projects(h.runtime.store).detail(id).revision })).toMatchObject({ status: 200 })
  await h.runtime.idle()
  expect(readTask().reviews).toBeUndefined()
  expect(() => change({ kind: 'task', id: task.id, value: { ...TaskInput.strip().parse(readTask()), acceptance: 'Replacement scope' } })).toThrow('停止当前执行')
  expect(() => h.runtime.projectReviews.decide({ ...context('not-a-person', null), channel: { source: 'execution', thread: id, address: {} } }, task.id, 'not-a-review', 'accepted', 'Worker thinks it is ready')).toThrow('不能替代人工验收')
})
it('recovers legacy pending review state silently without migrating completed historical tasks', async () => {
  const { h, id, task, readTask, send, projects } = await pilot()
  const stored = h.runtime.store.get(KV.projects.project(id))!
  stored.tasks[0]!.status = 'in-review'
  stored.tasks.push({ ...stored.tasks[0]!, id: 'historical-done', status: 'done', completedAt: new Date().toISOString() })
  h.runtime.store.set(KV.projects.project(id), stored)
  h.runtime.projectReviews.recover(); await h.runtime.idle()
  h.runtime.projectReviews.recover(); await h.runtime.idle()
  expect(currentReview(readTask())?.evidence.summary).toContain('未保存交付摘要')
  expect(projects.detail(id).tasks.find(item => item.id !== task.id)?.reviews).toBeUndefined()
  expect(send).not.toHaveBeenCalled()
})
it('ships per-event defaults and configuration documents', () => {
  for (const event of [reviewRequested, reviewAccepted, reviewRejected]) {
    const config = JSON.parse(readFileSync(new URL(`../config/events/${event.type.replace('.', '-')}.defaults.json`, import.meta.url), 'utf8'))
    expect(config).toEqual({ on: { [event.type]: true } })
    expect(readFileSync(new URL(`../${event.documentation}`, import.meta.url), 'utf8')).toContain(event.type)
  }
})

it('recovers a queued decision from SQLite after restart with no model call or lost-wakeup dependency', async () => {
  const { h, id, task, submit, context, projects } = await pilot(null)
  const review = await submit()
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  h.runtime.projectReviews.decide(context('recover-decision', null), task.id, review.id, 'accepted', 'Verified before restart')
  const project = h.runtime.store.get(KV.projects.project(id))!
  const members = projects.members()
  const events = h.runtime.store.db.prepare('SELECT * FROM project_event ORDER BY seq').all()
  await h.stop(); host = undefined
  const propose = vi.fn(async () => ({ calls: [], reply: 'Unused' }))
  const resumed = host = await startRuntime(store => {
    store.set(KV.projects.project(id), project)
    for (const member of members) store.set(KV.projects.member(member.id), member)
    for (const row of events) store.db.prepare('INSERT INTO project_event(id,value,recorded_at,status,reason) VALUES(?,?,?,?,?)')
      .run(row.id!, row.value!, row.recorded_at!, row.status!, row.reason!)
  }, undefined, undefined, undefined, undefined, { name: 'Restart Agent', propose })
  await resumed.runtime.idle()
  const saved = new Projects(resumed.runtime.store).detail(id).tasks[0]!
  expect(saved).toMatchObject({ status: 'done', reviews: [{ status: 'accepted', decision: { reason: 'Verified before restart' } }] })
  expect(propose).not.toHaveBeenCalled()
  expect(resumed.runtime.projectEvents.list({ projectId: id }).filter(event => event.type === 'review.accepted')).toMatchObject([{ status: 'applied' }])
})
