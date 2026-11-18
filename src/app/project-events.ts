/** Ordered project facts and reactions. Handlers commit synchronously; remote work belongs in Effects. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { key } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { ProjectEvent, ProjectEventDefinition, ProjectEventInput, ProjectEventPublisher } from '../sources/project-events.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'
import { ProjectError } from './projects.ts'

const name = z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/)
const id = z.string().min(1).max(300)
const Input = z.strictObject({ id, type: name, projectId: id.optional(), taskId: id.optional(), causeId: id.optional(),
  occurredAt: z.iso.datetime().optional(), data: z.unknown() })
const EventOptions = z.strictObject({ enabled: z.boolean().optional(), description: z.string().max(2000).optional(),
  instruction: z.string().trim().min(1).max(8000).optional() })
const EventSetting = z.union([z.boolean(), z.string().trim().min(1).max(8000), EventOptions])
const Reactions = z.record(name, EventSetting)
export const SourceWorkflowConfig = z.strictObject({ enabled: z.boolean().optional(), watch: z.array(name).max(100).optional(), on: Reactions.optional() })
export const ProjectWorkflowConfig = z.strictObject({
  sources: z.record(name, SourceWorkflowConfig).default({}),
  on: Reactions.default({}),
})
export type ProjectWorkflowConfig = z.output<typeof ProjectWorkflowConfig>
export type ProjectWorkflowVersion = { revision: number; config: ProjectWorkflowConfig }
type Reaction = { enabled: boolean; instruction?: string; description?: string }
type Result = { status: 'applied' | 'ignored'; reason?: string }
type Handler = (event: ProjectEvent, reaction: Reaction) => Result

/** Registers source facts and processes their durable queue in one ordered SQLite transaction per event. */
export class ProjectEvents {
  private readonly sources = new Map<string, readonly ProjectEventDefinition[]>()
  private readonly handlers = new Map<string, Handler>()
  private readonly observers = new Set<(event: ProjectEvent, reaction: Reaction) => void>()
  private active?: ProjectEvent
  /** The fact whose synchronous handler is committing this mutation; absent for direct operator writes. */
  processing(): ProjectEvent | undefined { return this.active }
  /** Subscribe to applied facts inside the same transaction; durable reactions must be queued here. */
  observe(observer: (event: ProjectEvent, reaction: Reaction) => void): () => void {
    this.observers.add(observer)
    return () => { this.observers.delete(observer) }
  }
  constructor(private readonly store: Store, private readonly effects: Effects,
    runnable: () => boolean = () => true) {
    effects.handle('project-events', () => this.consume(), { ordered: true, limit: () => runnable() ? 1 : 0 })
  }

  register(source: string, definitions: readonly ProjectEventDefinition[]): () => void {
    name.parse(source)
    if (this.sources.has(source)) throw new Error(`Project event source already registered: ${source}`)
    const types = new Set<string>()
    for (const definition of definitions) {
      name.parse(definition.type); name.parse(definition.category)
      z.number().int().positive().parse(definition.version ?? 1)
      if (types.has(definition.type)) throw new Error(`Duplicate project event: ${definition.type}`)
      const existing = this.definitions().find(item => item.type === definition.type)
      if (existing && existing !== definition) throw new Error(`Conflicting project event definition: ${definition.type}`)
      types.add(definition.type)
    }
    this.sources.set(source, definitions)
    return () => { this.sources.delete(source) }
  }

  handle(type: string, handler: Handler): () => void {
    if (!this.definitions().some(item => item.type === type)) throw new Error(`Unknown project event: ${type}`)
    if (this.handlers.has(type)) throw new Error(`Project event handler already registered: ${type}`)
    this.handlers.set(type, handler)
    return () => { this.handlers.delete(type) }
  }

  private definitions(): ProjectEventDefinition[] {
    return [...new Set([...this.sources.values()].flat())]
  }

  view() {
    const saved = this.store.get(KV.projects.workflow) ?? { revision: 0, config: ProjectWorkflowConfig.parse({}) }
    const definitions = this.definitions().filter(item => !item.internal)
    const sources = [...this.sources].map(([source, definitions]) => ({ source, config: saved.config.sources[source] ?? {},
      categories: [...new Set(definitions.filter(item => !item.internal).map(item => item.category))],
      defaults: { sources: { [source]: { on: Object.fromEntries(definitions.filter(item => !item.internal)
        .map(item => [item.type, { enabled: item.defaults.enabled, description: item.description }])) } } },
      events: definitions.filter(item => !item.internal).map(item => ({ type: item.type, documentation: item.documentation,
        effective: this.settings(source, item.type) })),
    })).filter(source => !this.sources.get(source.source)?.length || this.sources.get(source.source)!.some(item => !item.internal))
    return { ...saved,
      sources,
      defaults: { sources: Object.fromEntries(sources.filter(source => source.events.length)
        .map(source => [source.source, source.defaults.sources[source.source]!])), on: {} },
      events: definitions.map(definition => {
        const { schema: _schema, ...metadata } = definition
        return { ...metadata, version: definition.version ?? 1, effective: this.reaction(definition, saved.config) }
      }),
    }
  }

  /** Updates a registered source without replacing any other source or legacy global overrides. */
  saveSource(source: string, revision: number, input: unknown): ReturnType<ProjectEvents['view']> {
    if (!this.sources.has(source)) throw new ProjectError(400, `Project event source is not installed: ${source}`)
    const value = SourceWorkflowConfig.parse(input)
    const saved = this.view().config
    return this.save(revision, { ...saved, sources: { ...saved.sources, [source]: value } })
  }

  save(revision: number, input: unknown): ReturnType<ProjectEvents['view']> {
    const config = ProjectWorkflowConfig.parse(input)
    for (const [source, value] of Object.entries(config.sources)) {
      const definitions = this.sources.get(source)
      if (!definitions) throw new ProjectError(400, `Project event source is not installed: ${source}`)
      if (definitions.length && definitions.every(item => item.internal)) throw new ProjectError(400, 'Internal event sources have no user configuration')
      const categories = new Set(definitions.map(item => item.category))
      if (value.watch?.some(category => !categories.has(category)))
        throw new ProjectError(400, `Unknown watch category for ${source}`)
      for (const [type, setting] of Object.entries(value.on ?? {})) this.validateReaction(type, setting, definitions)
    }
    for (const [type, value] of Object.entries(config.on)) this.validateReaction(type, value, this.definitions())
    return this.store.atomic(() => {
      if (this.view().revision !== revision) throw new ProjectError(409, 'Project workflow configuration changed. Reload before saving.')
      this.store.set(KV.projects.workflow, { revision: revision + 1, config })
      this.wake()
      return this.view()
    })
  }

  private validateReaction(type: string, value: z.output<typeof EventSetting>, definitions: readonly ProjectEventDefinition[]): void {
    const definition = definitions.find(item => item.type === type)
    if (!definition) throw new ProjectError(400, `Project event is not installed for this source: ${type}`)
    if (definition.internal) throw new ProjectError(400, 'Internal events have no user configuration')
    if ((typeof value === 'string' || typeof value === 'object' && value.instruction !== undefined) && definition.defaults.instruction === undefined)
      throw new ProjectError(400, `This event uses a background handler and has no Agent instruction: ${type}`)
  }

  private reaction(definition: ProjectEventDefinition, config: ProjectWorkflowConfig, sourceValue?: z.output<typeof EventSetting>): Reaction {
    const normalize = (value?: z.output<typeof EventSetting>) => typeof value === 'boolean' ? { enabled: value }
      : typeof value === 'string' ? { enabled: true, instruction: value } : value ?? {}
    return { ...definition.defaults, description: definition.description, ...normalize(config.on[definition.type]), ...normalize(sourceValue) }
  }

  settings(source: string, type: string): Reaction {
    const definition = this.sources.get(source)?.find(item => item.type === type)
    if (!definition) throw new ProjectError(400, `Event ${type} is not registered for source ${source}`)
    if (definition.internal) return definition.defaults
    const config = this.store.get(KV.projects.workflow)?.config ?? ProjectWorkflowConfig.parse({})
    const sourceConfig = config.sources[source]
    const reaction = this.reaction(definition, config, sourceConfig?.on?.[type])
    return { ...reaction, enabled: reaction.enabled && sourceConfig?.enabled !== false &&
      (!sourceConfig?.watch || sourceConfig.watch.includes(definition.category)) }
  }

  publisher(source: string): ProjectEventPublisher {
    return { publish: input => this.publish(source, input) }
  }

  private publish(source: string, input: ProjectEventInput): ProjectEvent {
    const parsed = Input.parse(input)
    const definition = this.sources.get(source)?.find(item => item.type === parsed.type)
    if (!definition) throw new ProjectError(400, `Event ${parsed.type} is not registered for source ${source}`)
    const value = { ...parsed, data: definition.schema.parse(parsed.data), source, version: definition.version ?? 1 }
    const serialized = JSON.stringify(value)
    const fingerprint = JSON.parse(serialized)
    const eventId = key('project-event', source, parsed.id)
    return this.store.atomic(() => {
      const existing = this.store.db.prepare('SELECT * FROM project_event WHERE id=?').get(eventId)
      if (existing) {
        if (!isDeepStrictEqual(JSON.parse(String(existing.value)), fingerprint))
          throw new ProjectError(409, 'This project event ID was already used with different content')
        return this.record(existing)
      }
      const recordedAt = new Date().toISOString()
      const row = this.store.db.prepare('INSERT INTO project_event(id, value, recorded_at) VALUES(?, ?, ?) RETURNING *')
        .get(eventId, serialized, recordedAt)!
      this.wake()
      return this.record(row)
    })
  }

  /** Called on startup as well as after enqueue; the database is authoritative if a wakeup was lost. */
  recover(): void {
    if (this.store.db.prepare("SELECT 1 FROM project_event WHERE status='pending' LIMIT 1").get()) this.wake()
  }

  private wake(): void {
    this.effects.enqueue('project-events', 'queue', {})
    this.store.afterCommit(() => { this.effects.kick() })
  }

  list(query: { projectId?: string; limit?: number; before?: number } = {}): ProjectEvent[] {
    const limit = z.number().int().min(1).max(200).parse(query.limit ?? 50)
    const before = z.number().int().positive().optional().parse(query.before)
    const rows = this.store.db.prepare("SELECT * FROM project_event WHERE (? IS NULL OR value ->> '$.projectId'=?) AND (? IS NULL OR seq<?) ORDER BY seq DESC LIMIT ?")
      .all(query.projectId ?? null, query.projectId ?? null, before ?? null, before ?? null, limit)
    return rows.map(row => this.record(row))
  }

  private record(row: Record<string, unknown>): ProjectEvent {
    return { ...JSON.parse(String(row.value)), seq: Number(row.seq), recordedAt: String(row.recorded_at),
      status: row.status, ...(row.reason ? { reason: String(row.reason) } : {}) }
  }

  get(source: string, id: string): ProjectEvent | undefined {
    const row = this.store.db.prepare('SELECT * FROM project_event WHERE id=?').get(key('project-event', source, id))
    return row ? this.record(row) : undefined
  }

  private async consume(): Promise<void> {
    // Yield between batches so large backlogs do not hold the HTTP event loop.
    for (let batch = 0; batch < 100; batch++) {
      const next = this.store.db.prepare("SELECT * FROM project_event WHERE status='pending' ORDER BY seq LIMIT 1").get()
      if (!next) return
      this.store.atomic(() => {
        const event = this.record(next)
        const definition = this.sources.get(event.source)?.find(item => item.type === event.type)
        const handler = this.handlers.get(event.type)
        if (!definition || !handler) throw new Error(`Waiting for project event handler: ${event.source}/${event.type}`)
        if ((definition.version ?? 1) !== event.version) throw new Error(`Waiting for project event version: ${event.type}@${event.version}`)
        const reaction = this.settings(event.source, event.type)
        this.active = event
        let result: Result
        try { result = !reaction.enabled ? { status: 'ignored', reason: 'Disabled by project workflow configuration' } : handler(event, reaction) }
        finally { this.active = undefined }
        if (result instanceof Promise) throw new Error('Project event handlers must commit synchronously')
        if (result.status === 'applied') for (const observer of this.observers) observer({ ...event, status: 'applied' }, reaction)
        this.store.db.prepare('UPDATE project_event SET status=?, reason=? WHERE seq=?')
          .run(result.status, result.reason ?? '', event.seq)
      })
    }
    this.wake()
  }
}
