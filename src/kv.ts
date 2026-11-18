/**
 * Typed key-value store keys and key families grouped by the single component that owns and writes each family.
 * Readers and writers refer to a record by its entry here so each key is spelled once with its value type.
 */
import type { PromptVersion } from './app/prompts.ts'
import type { SettingsVersion } from './app/store.ts'
import type { Member, Project } from './app/projects.ts'
import type { ProjectPlanRecord } from './app/project-planning.ts'
import type { ProjectIssueAttempt } from './app/project-issues.ts'
import type { ProjectActionSelection } from './app/project-actions.ts'
import type { ProjectWorkflowVersion } from './app/project-events.ts'
import type { ProjectAgentRun } from './app/project-agent.ts'
import type { ComposedNotice, ConversationPreference } from './app/communication.ts'
import type { ProjectBlockage } from './app/events/task-blocked.ts'
import type { ProjectCheck } from './app/project-progress.ts'
import type { RepositoryFact } from './sources/repository-events.ts'
import type { IssueSync } from './app/project-repository.ts'
import type { AgentSessionRef } from './app/session-binding.ts'
import type { RobotPlannerId } from './harness/robot-agents.ts'
import type { SettingsSave } from './policy.ts'
import type { Retry } from './sources/github.ts'
import type { CiSnapshot } from './sources/github-read.ts'
import type { Health } from './sources/host.ts'

type BranchCiState = { branch?: string; failures?: string[]; revision: number; settled?: string; reported?: string; reportedSnapshot?: CiSnapshot }

/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
export type Key<V> = string & { readonly __value?: V }
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
export const record = <V>(key: string) => key as Key<V>
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

export const KV = {
  communication: { preference: family<ConversationPreference>('conversation-preference:'), notice: family<ComposedNotice>('composed-notice:') },
  /** Store: current database schema version. */
  store: { schema: record<number>('schema') },
  /** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
  settings: { revision: record<number>('settings-revision'),
    block: family<number, [block: SettingsSave]>('settings-block-revision:'),
    version: family<SettingsVersion, [revision: number]>('settings-version:') },
  /** Prompts: current revision and saved prompt versions. */
  prompts: { revision: record<number>('prompt-revision'), version: family<PromptVersion, [revision: number]>('prompt-version:'),
    /** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
    builtIn: family<string, [base: string]>('prompt-built-in:') },
  /** Runtime: the main Session's ID. */
  runtime: { masterId: record<string>('master-id'), robotPlanner: record<RobotPlannerId>('robot-planning-agent') },
  /** Project management and its team directory, independent of the execution Policy. */
  projects: { project: family<Project>('project:'), member: family<Member>('project-member:'),
    workflow: record<ProjectWorkflowVersion>('project-workflow'),
    agentRun: family<ProjectAgentRun>('project-agent-run:'),
    blockage: family<ProjectBlockage>('project-blockage:'),
    readiness: family<{ signature: string; episode: string }>('project-readiness:'),
    check: family<ProjectCheck>('project-check:'),
    remoteFact: family<RepositoryFact & { projectId: string; taskId: string }>('project-remote-fact:'),
    issueSync: family<IssueSync>('project-issue-sync:'),
    historyBaseline: family<true>('project-history-baseline:'),
    plan: family<ProjectPlanRecord>('project-plan:'), latestPlan: family<ProjectPlanRecord>('project-latest-plan:'),
    issueAttempt: family<ProjectIssueAttempt>('project-issue-attempt:'), issueSelection: family<string>('project-issue-selection:'),
    actionMessage: family<true>('project-issue-message:'), actionSelection: family<ProjectActionSelection>('project-action-selection:') },
  /** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:'),
    unavailableAction: family<{ runner: string; kind: 'command' | 'file-change'; at: string }>('session-unavailable-action:'),
    external: family<AgentSessionRef, [session: string]>('session-external:') },
  /** Schema 11 migration: legacy main-Session queues imported into the effect table. */
  queues: { relays: record<{ id: string; text: string }[]>('relay-queue'), unsubscribed: record<string[]>('subscription-results'),
    prompts: record<number | null>('prompt-notification'), settings: record<number | null>('settings-notification') },
  /** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
  /**
   * GitHub Source: notification cursor and pending retries; per-Issue/PR read cursor shared by notification and polled reads;
   * per-stream cursor, start times by kind, and ETag; default-branch CI state; and per-PR CI fingerprint and revision (`revision`
   * counts reported CI changes so each produces a distinct Trigger ID).
   */
  github: { since: record<string>('github-since'), retries: record<Record<string, Retry>>('github-retry'),
    cursor: family<string, [number: number]>('github-cursor:'),
    stream: family<{ since: string; started: Record<string, string>; etag?: string; boundAt?: string }, [stream: string]>('github-stream:'),
    branchCi: record<BranchCiState>('github-branch-ci'),
    repositoryCi: family<BranchCiState>('github-repository-ci:'), repositoryHealth: family<Health>('github-repository-health:'),
    ci: family<{ fingerprint: string; revision: number; settled?: string; reported?: string }, [number: number]>('github-ci:') },
  /**
   * Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
   * to last-seen timestamp; and per-polled-thread seen message IDs and initialization flag.
   */
  feishu: { chats: record<Record<string, boolean>>('feishu-chats'), history: family<string, [chat: string]>('feishu-history:'),
    topics: family<Record<string, string>, [chat: string]>('feishu-history-threads:'),
    seen: family<string[], [thread: string]>('thread-seen:'), initialized: family<boolean, [thread: string]>('thread-initialized:') },
}
