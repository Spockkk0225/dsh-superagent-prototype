export interface RepositoryBinding { repository: string; since: string }
export interface RepositoryWatch extends RepositoryBinding { configured: boolean; projects: number }

/** The configured legacy repository and live project bindings share a single entry per canonical repository. */
export function repositoryWatches(configured: string, bindings: readonly RepositoryBinding[]): RepositoryWatch[] {
  const watches = new Map<string, RepositoryWatch>()
  if (configured) watches.set(configured.toLowerCase(), { repository: configured.toLowerCase(), since: '', configured: true, projects: 0 })
  for (const binding of bindings) {
    const repository = binding.repository.toLowerCase()
    const existing = watches.get(repository)
    if (existing) {
      existing.projects++
      if (binding.since < existing.since) existing.since = binding.since
    } else watches.set(repository, { repository, since: binding.since, configured: false, projects: 1 })
  }
  return [...watches.values()].sort((a, b) => a.repository.localeCompare(b.repository))
}

export function hasRepositoryStreams(config?: Record<string, unknown>): boolean {
  return !!config && [config.observeIssues, config.observePulls, config.observeComments, config.observeCi].some(value => value === true)
}
