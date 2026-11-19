import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { executable } from '../deployment.ts'
import { CodexProjectPlanner, QoderProjectPlanner, QwenProjectPlanner } from './project-planner.ts'
import type { ProjectPlanner } from '../app/project-planning.ts'

export type RobotAgentStatus = {
  id: string; name: string; installed: boolean; planning: boolean; execution: boolean
}
export type RobotAgentSettings = { selected: RobotPlannerId; agents: RobotAgentStatus[] }

const agents = [
  { id: 'codex', name: 'Codex', planner: CodexProjectPlanner, execution: true },
  { id: 'qwen', name: 'Qwen Code', planner: QwenProjectPlanner, execution: false },
  { id: 'qoder', name: 'Qoder', planner: QoderProjectPlanner, execution: false },
  { id: 'claude', name: 'Claude Code', planner: null, execution: false },
] as const
type AgentId = typeof agents[number]['id']
export type RobotPlannerId = Exclude<typeof agents[number], { planner: null }>['id']
type AgentOptions = Partial<Record<AgentId, string> & Record<`${RobotPlannerId}Model`, string>>

/** Discovers local CLIs and exposes only complete runtimes as robot Agents. */
export class RobotAgents {
  constructor(private readonly options: AgentOptions) {}

  binary(id: AgentId): string | undefined {
    const configured = this.options[id]
    const home = homedir()
    const path = [process.env.PATH, join(home, '.local', 'bin'), join(home, '.qoder', 'entry'),
      join(home, '.claude', 'local'), ...(process.platform === 'darwin' ?
        ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS'] : [])].filter(Boolean).join(delimiter)
    try { return executable(configured || id, path) } catch { return undefined }
  }

  catalog(selected: RobotPlannerId): RobotAgentSettings {
    return { selected, agents: agents.map(({ id, name, planner, execution }) => ({ id, name, planning: !!planner, execution, installed: !!this.binary(id) })) }
  }

  selectable(id: string): RobotPlannerId | undefined {
    const agent = agents.find(entry => entry.id === id)
    return agent?.planner && agent.execution && this.binary(agent.id) ? agent.id : undefined
  }

  active(saved?: RobotPlannerId): RobotPlannerId {
    return (saved && this.selectable(saved)) || 'codex'
  }

  planner(id: RobotPlannerId): ProjectPlanner {
    const registered = agents.find(agent => agent.id === id)?.planner
    if (!registered) throw new Error('Planning Agent adapter is unavailable')
    return new registered(this.binary(id) ?? id, this.options[`${id}Model`])
  }
}
