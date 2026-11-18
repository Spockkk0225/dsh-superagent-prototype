import type { ProjectTask } from './projects.ts'

export interface DeliveryEvidence { summary: string; links: string[]; ticketId?: string; reportAt?: string;
  code?: { url: string; head: string; mergeCommit: string; base?: string; updatedAt: string } }
export interface ProjectReview {
  id: string
  version: number
  requestedAt: string
  status: 'pending' | 'accepted' | 'rejected' | 'superseded'
  requirements: { title: string; description: string; acceptance: string; ownerId: string | null }
  evidence: DeliveryEvidence
  decision?: { actorId: string | null; source: string; reason: string; at: string }
}

export const reviewReference = (review: ProjectReview) => `〔交付第 ${review.version} 版 · 验收 ${review.id.slice(0, 8)}〕`
export const currentReview = (task: ProjectTask) => task.reviews?.findLast(review => review.version === task.deliveryVersion)

/** Invalidates the old review before beginning a new execution or changing its acceptance scope. */
export function nextDelivery(task: ProjectTask): void {
  const review = currentReview(task)
  if (review?.status === 'pending') review.status = 'superseded'
  task.deliveryVersion = (task.deliveryVersion ?? 0) + 1
}

export function deliveryScopeChanged(before: ProjectTask, after: ProjectTask): boolean {
  before = { ...before, deliveryMode: before.deliveryMode ?? 'report', pullRequestUrl: before.pullRequestUrl ?? null, targetBranch: before.targetBranch ?? null }
  after = { ...after, deliveryMode: after.deliveryMode ?? 'report', pullRequestUrl: after.pullRequestUrl ?? null, targetBranch: after.targetBranch ?? null }
  return ['title', 'description', 'acceptance', 'ownerId', 'executionMode', 'blockedBy', 'deliveryMode', 'pullRequestUrl', 'targetBranch'].some(field =>
    JSON.stringify(before[field as keyof ProjectTask]) !== JSON.stringify(after[field as keyof ProjectTask]))
}
