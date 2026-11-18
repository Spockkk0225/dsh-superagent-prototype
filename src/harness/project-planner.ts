import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectPlanner } from '../app/project-planning.ts'

function run(binary: string, args: string[], cwd: string, prompt: string, signal: AbortSignal): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:DINGTALK_|SUPERAGENT_|(?:GH|GITHUB)_(?:ENTERPRISE_)?TOKEN$)/u.test(key)))
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, { cwd, env, signal, timeout: 100_000, maxBuffer: 2_000_000 }, (error, stdout) => {
      if (error) reject(new Error('Planning Agent invocation failed'))
      else resolve(stdout)
    })
    child.stdin?.on('error', () => {}) // The process callback reports an early exit.
    child.stdin?.end(prompt)
  })
}

/** A tool-free, ephemeral planning session, independent of the persistent Worker sessions. */
export class CodexProjectPlanner implements ProjectPlanner {
  readonly name = 'Codex'
  constructor(private readonly binary: string, private readonly model?: string) {}

  async propose(prompt: string, schema: object, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const directory = await mkdtemp(join(tmpdir(), 'superagent-planner-'))
    const inputSchema = join(directory, 'schema.json')
    const output = join(directory, 'plan.json')
    try {
      await writeFile(inputSchema, JSON.stringify(schema), { mode: 0o600 })
      const args = ['-a', 'never', 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral',
        '--skip-git-repo-check', '--sandbox', 'read-only', '--disable', 'shell_tool', '--disable', 'apps',
        '--disable', 'plugins', '-c', 'web_search="disabled"', '-c', 'mcp_servers={}',
        '--output-schema', inputSchema, '--output-last-message', output,
        ...(this.model ? ['--model', this.model] : []), '-']
      await run(this.binary, args, directory, prompt, signal)
      return JSON.parse(await readFile(output, 'utf8'))
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
}

/** Qwen Code's structured-output mode counts tool calls other than its terminal schema result. */
export class QwenProjectPlanner implements ProjectPlanner {
  readonly name = 'Qwen Code'
  constructor(private readonly binary = 'qwen', private readonly model?: string) {}

  async propose(prompt: string, schema: object, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const directory = await mkdtemp(join(tmpdir(), 'superagent-planner-'))
    try {
      const args = ['--json-schema', JSON.stringify(schema), '--output-format', 'text', '--max-tool-calls', '0',
        '--max-session-turns', '8', '--approval-mode', 'plan', '--extensions', 'none',
        '--allowed-mcp-server-names', '__superagent_no_mcp__',
        ...(this.model ? ['--model', this.model] : [])]
      return JSON.parse(await run(this.binary, args, directory, prompt, signal))
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
}

/** Runs Qoder without tools, MCP servers, hooks or a persisted session. The application validates its proposed JSON. */
export class QoderProjectPlanner implements ProjectPlanner {
  readonly name = 'Qoder'
  constructor(private readonly binary = 'qoder', private readonly model?: string) {}

  async propose(prompt: string, schema: object, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const directory = await mkdtemp(join(tmpdir(), 'superagent-planner-'))
    try {
      const args = ['--print', '--output-format', 'text', '--permission-mode', 'dont_ask', '--tools', '',
        '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
        ...(this.model ? ['--model', this.model] : [])]
      const input = [prompt, 'Return one JSON object with no surrounding prose. Use exactly this JSON Schema:', JSON.stringify(schema)].join('\n\n')
      const response = (await run(this.binary, args, directory, input, signal)).trim()
      return JSON.parse(/^\x60\x60\x60(?:json)?\s+([\s\S]*?)\s+\x60\x60\x60$/i.exec(response)?.[1] ?? response)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
}
