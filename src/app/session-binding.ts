import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Tool } from './tools/tool.ts'

export type AgentSessionRef = { runner: string; externalId: string }

/** A host that binds its own protocol to the orchestrator's existing role prompts and tools. */
export interface AgentSessionBinding {
  readonly runner: string
  capabilities?(): { runner: string; sandbox?: string; nativeApprovals: 'unavailable' | 'available' | 'unknown'; guidance?: string }
  bind(agent: Agent, instructions: () => string, tools: Tool[], guard: () => string | undefined): () => void
}

declare module '@deepseek-ai/cordis' { interface Context { agentSessionBinding: AgentSessionBinding } }
