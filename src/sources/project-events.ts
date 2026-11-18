import type { z } from 'zod'

/** Source plugins supply these definitions once. Users select categories and event reactions. */
export interface ProjectEventDefinition {
  type: string
  /** Internal payload version; omitted definitions use 1. User JSON has no schema fields. */
  version?: number
  category: string
  description: string
  schema: z.ZodType
  defaults: { enabled: boolean; instruction?: string }
  documentation: string
  /** Internal coordination facts stay outside user reaction configuration. */
  internal?: true
}

export interface ProjectEventInput {
  id: string
  type: string
  projectId?: string
  taskId?: string
  causeId?: string
  occurredAt?: string
  data: unknown
}

export interface ProjectEvent extends ProjectEventInput {
  seq: number
  version: number
  source: string
  recordedAt: string
  status: 'pending' | 'applied' | 'ignored'
  reason?: string
}

export interface ProjectEventPublisher {
  publish(event: ProjectEventInput): ProjectEvent
}
