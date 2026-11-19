import { expect, it } from 'vitest'
import { once } from 'node:events'
import { get } from 'node:http'
import { BlockList } from 'node:net'
import { z } from 'zod'
import { projectHttpServer, registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import type { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('accepts only a nonempty bounded prompt on the existing protected local API', async () => {
  const prompts: string[] = []
  const call = serve({ machine: { promptMaxChars: { get: () => 100 } },
    submitRequest: (prompt: string) => { prompts.push(prompt); return { trigger_id: 'request:1', status: 'stored' } } })
  expect(await call('POST', 'requests', { prompt: '  Summarize CI  ' })).toEqual({ status: 200,
    body: { trigger_id: 'request:1', status: 'stored' } })
  for (const body of [{}, { prompt: '' }, { prompt: '  ' }, { prompt: 1 }, { prompt: 'x'.repeat(101) },
    { prompt: 'Run', source: 'dingtalk' }, { prompt: 'Run', output: 'another-group' }]) {
    expect(await call('POST', 'requests', body)).toMatchObject({ status: 400 })
  }
  expect(await call('POST', 'requests', { prompt: 'Run' }, { 'x-orchestrator-request': undefined })).toMatchObject({ status: 403 })
  expect(prompts).toEqual(['Summarize CI'])
})

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('requires the HTTPS project proxy and valid credentials before serving the public page or API', async () => {
  const origin = new URL('https://projects.example.com')
  const password = 'test-only-project-password'
  const store = { keys: () => [] } as unknown as Store
  const server = projectHttpServer(store, 0, '127.0.0.1', { publicAccess: { origin, username: 'projects', password } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server')
  const page = '/orchestrator/projects'
  const api = '/orchestrator/api/projects'
  const call = (path: string, headers: Record<string, string> = {}) => new Promise<{
    status: number | undefined; challenge: string | undefined; text: string
  }>((resolve, reject) => {
    get(`http://127.0.0.1:${address.port}${path}`, { headers: { host: origin.host, 'x-forwarded-proto': 'https', ...headers } }, response => {
      let text = ''
      response.setEncoding('utf8').on('data', chunk => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode, challenge: response.headers['www-authenticate'], text }))
      response.on('error', reject)
    }).on('error', reject)
  })
  const authorization = `Basic ${Buffer.from(`projects:${password}`).toString('base64')}`
  const apiHeaders = { authorization, origin: origin.origin, 'x-orchestrator-request': '1' }
  try {
    for (const path of [page, '/orchestrator/projects.js', api]) {
      const response = await call(path)
      expect(response.status).toBe(401)
      expect(response.challenge).toMatch(/^Basic /)
    }
    expect((await call(page, { authorization: 'Basic d3Jvbmc=' })).status).toBe(401)
    expect((await call(page, { authorization, 'x-forwarded-proto': 'http' })).status).toBe(403)
    expect((await call(page, { authorization, host: 'localhost' })).status).toBe(403)
    expect((await call(page, { authorization })).status).toBe(200)
    expect((await call(api, { ...apiHeaders, origin: 'https://other.example.com' })).status).toBe(403)
    expect((await call(api, { authorization })).status).toBe(403)
    expect(JSON.parse((await call(api, apiHeaders)).text)).toEqual([])
    expect((await call('/orchestrator/api/state', apiHeaders)).status).toBe(404)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

it('admits a preview client only when its network is enabled and still checks the API origin', async () => {
  const store = { keys: () => [] } as unknown as Store
  const previewAddress = '192.0.2.10'
  const previewHost = `${previewAddress}:3090`
  const clients = new BlockList()
  clients.addSubnet('127.0.0.0', 24)
  // Use the loopback client as a distinct peer so the test can run on any host.
  for (const previewNetwork of [undefined, clients]) {
    const server = projectHttpServer(store, 3090, previewAddress, { previewNetwork })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP server')
    const call = (path: string, origin = `http://${previewHost}`) => new Promise<number | undefined>((resolve, reject) => {
      get(`http://127.0.0.1:${address.port}${path}`, { headers: { host: previewHost, origin, 'x-orchestrator-request': '1' } }, response => {
        response.resume()
        resolve(response.statusCode)
      }).on('error', reject)
    })
    try {
      const expected = previewNetwork ? 200 : 403
      expect(await call('/orchestrator/projects')).toBe(expected)
      expect(await call('/orchestrator/api/projects')).toBe(expected)
      expect(await call('/orchestrator/api/projects', 'http://other.example.com')).toBe(403)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  }
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})
