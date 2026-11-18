import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { importMissionControl } from './app/mission-control-import.ts'
import { Store } from './app/store.ts'

const usage = 'Usage: pnpm import:mission-control <mission-control/data> <super-agent-state-dir>'
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') console.log(usage)
else if (args.length !== 2) { console.error(usage); process.exitCode = 1 }
else {
  try {
    const [source, target] = args.map(path => resolve(path)) as [string, string]
    const database = join(target, 'orchestrator.sqlite')
    if (!existsSync(database)) throw new Error(`No existing Super Agent database at ${database}`)
    const release = lockSync(target)
    try {
      const store = new Store(database)
      try { console.log(JSON.stringify(importMissionControl(store, source), null, 2)) }
      finally { store.close() }
    } finally { release() }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
