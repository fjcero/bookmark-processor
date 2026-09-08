export type ArticleQueueStatus = "pending" | "fetching" | "ok" | "failed"

export interface ArticleQueueItem {
  tweetId: string
  articleId: string
  url: string
  attempts: number
  status: ArticleQueueStatus
  lastError?: string
  nextAt?: number
}

/** Minimum quiet time between finishing one article and starting the next. */
export const ARTICLE_GAP_MS = 30_000
/** How often to poll the server when the local queue is empty. */
export const ARTICLE_POLL_IDLE_MS = 300_000
/** Default global pause after X returns 429. */
export const ARTICLE_RATE_LIMIT_MS = 900_000
/** Delay before re-trying an item the extension marked ok but the server still lists. */
export const ARTICLE_REQUEUE_OK_MS = 600_000
export const ARTICLE_MAX_ATTEMPTS = 8
export const ARTICLE_TAB_TIMEOUT_MS = 45_000
export const ARTICLE_BACKOFF_MS = [
  120_000,
  300_000,
  600_000,
  900_000,
  1_800_000,
  1_800_000,
  3_600_000,
  3_600_000,
] as const
export const ARTICLE_RATE_LIMIT_BACKOFF_MS = [
  900_000,
  1_800_000,
  3_600_000,
  7_200_000,
] as const

export interface ArticleHydrationState {
  queue: ArticleQueueItem[]
  rateLimitedUntil?: number
  rateLimitHits?: number
  lastCompletedAt?: number
  processingArticleId?: string
  leaseUntil?: number
}

export type ArticleQueueIncoming = Pick<
  ArticleQueueItem,
  "tweetId" | "articleId" | "url"
> & { refetch?: boolean }

function resetQueueItem(item: ArticleQueueItem): void {
  item.status = "pending"
  item.attempts = 0
  item.nextAt = undefined
  item.lastError = undefined
}

export function isRateLimitError(error: string): boolean {
  const value = error.toLowerCase()
  return value.includes("429") || value.includes("rate limit")
}

export function parseRetryAfterMs(
  header: string | null | undefined,
  fallback = ARTICLE_RATE_LIMIT_MS,
): number {
  if (!header) return fallback
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 7_200_000)
  }
  const date = Date.parse(header)
  if (!Number.isNaN(date)) {
    return Math.max(0, Math.min(date - Date.now(), 7_200_000))
  }
  return fallback
}

export function extendRateLimit(
  state: ArticleHydrationState,
  delayMs: number,
  now = Date.now(),
): ArticleHydrationState {
  const hits = (state.rateLimitHits ?? 0) + 1
  const until = Math.max(state.rateLimitedUntil ?? 0, now + delayMs)
  return { ...state, rateLimitedUntil: until, rateLimitHits: hits }
}

export function isRateLimited(
  state: ArticleHydrationState,
  now = Date.now(),
): boolean {
  return (state.rateLimitedUntil ?? 0) > now
}

export function msUntilHydrationAllowed(
  state: ArticleHydrationState,
  now = Date.now(),
): number {
  const waits = [
    Math.max(0, (state.rateLimitedUntil ?? 0) - now),
    Math.max(0, (state.lastCompletedAt ?? 0) + ARTICLE_GAP_MS - now),
  ]
  return Math.max(...waits, 0)
}

export function enqueueArticles(
  queue: ArticleQueueItem[],
  incoming: ArticleQueueIncoming[],
  now = Date.now(),
): ArticleQueueItem[] {
  const byId = new Map(queue.map((item) => [item.articleId, item]))
  for (const next of incoming) {
    const existing = byId.get(next.articleId)
    if (existing) {
      existing.tweetId = next.tweetId
      existing.url = next.url
      if (next.refetch) {
        resetQueueItem(existing)
        continue
      }
      if (existing.status === "fetching") continue
      if (existing.status === "ok") {
        if (next.refetch) resetQueueItem(existing)
        continue
      }
      continue
    }
    const item: ArticleQueueItem = {
      tweetId: next.tweetId,
      articleId: next.articleId,
      url: next.url,
      attempts: 0,
      status: "pending",
    }
    queue.push(item)
    byId.set(next.articleId, item)
  }
  return queue
}

export function pickNextArticle(
  queue: ArticleQueueItem[],
  now = Date.now(),
): ArticleQueueItem | null {
  if (queue.some((item) => item.status === "fetching")) return null
  const ready = queue
    .filter(
      (item) =>
        item.status === "pending" &&
        (item.nextAt == null || item.nextAt <= now),
    )
    .sort((a, b) => {
      if (a.attempts !== b.attempts) return a.attempts - b.attempts
      return (a.nextAt ?? 0) - (b.nextAt ?? 0)
    })
  return ready[0] ?? null
}

export function markArticleFetching(
  queue: ArticleQueueItem[],
  articleId: string,
): ArticleQueueItem[] {
  const item = queue.find((entry) => entry.articleId === articleId)
  if (!item) return queue
  item.status = "fetching"
  item.attempts += 1
  return queue
}

export function markArticleSuccess(
  queue: ArticleQueueItem[],
  articleId: string,
): ArticleQueueItem[] {
  return markArticleRemoved(queue, articleId)
}

export function markArticleFailure(
  queue: ArticleQueueItem[],
  articleId: string,
  error: string,
  now = Date.now(),
): ArticleQueueItem[] {
  const item = queue.find((entry) => entry.articleId === articleId)
  if (!item) return queue
  item.lastError = error
  if (item.attempts >= ARTICLE_MAX_ATTEMPTS) {
    item.status = "failed"
    item.nextAt = undefined
    return queue
  }
  const delay = ARTICLE_BACKOFF_MS[
    Math.min(item.attempts - 1, ARTICLE_BACKOFF_MS.length - 1)
  ]
  item.status = "pending"
  item.nextAt = now + delay
  return queue
}

export function markArticleRateLimited(
  queue: ArticleQueueItem[],
  articleId: string,
  error: string,
  now = Date.now(),
  rateLimitHits = 1,
): ArticleQueueItem[] {
  const item = queue.find((entry) => entry.articleId === articleId)
  if (!item) return queue
  item.lastError = error
  item.status = "pending"
  item.attempts = Math.max(0, item.attempts - 1)
  const delay =
    ARTICLE_RATE_LIMIT_BACKOFF_MS[
      Math.min(rateLimitHits - 1, ARTICLE_RATE_LIMIT_BACKOFF_MS.length - 1)
    ]
  item.nextAt = now + delay
  return queue
}

export function retryFailedArticles(
  queue: ArticleQueueItem[],
  now = Date.now(),
): ArticleQueueItem[] {
  for (const item of queue) {
    if (item.status !== "failed") continue
    item.status = "pending"
    item.attempts = 0
    item.nextAt = now + ARTICLE_GAP_MS
    item.lastError = undefined
  }
  return queue
}

export function markArticleRemoved(
  queue: ArticleQueueItem[],
  articleId: string,
): ArticleQueueItem[] {
  return queue.filter((item) => item.articleId !== articleId)
}

export function articleQueueStats(queue: ArticleQueueItem[]): {
  pending: number
  fetching: number
  ok: number
  failed: number
  total: number
} {
  const stats = { pending: 0, fetching: 0, ok: 0, failed: 0, total: queue.length }
  const now = Date.now()
  for (const item of queue) {
    if (item.status === "pending") {
      if (item.nextAt != null && item.nextAt > now) continue
      stats.pending++
      continue
    }
    stats[item.status]++
  }
  return stats
}

export function isTerminalArticleFailure(item: ArticleQueueItem): boolean {
  return item.status === "failed" && item.attempts >= ARTICLE_MAX_ATTEMPTS
}

export function nextQueueWakeAt(
  queue: ArticleQueueItem[],
  state: ArticleHydrationState,
  now = Date.now(),
): number | null {
  const waits: number[] = []
  const globalWait = msUntilHydrationAllowed(state, now)
  if (globalWait > 0) waits.push(globalWait)
  for (const item of queue) {
    if (item.status !== "pending" || item.nextAt == null) continue
    waits.push(Math.max(0, item.nextAt - now))
  }
  const min = waits.reduce<number | null>(
    (earliest, wait) =>
      earliest == null ? wait : Math.min(earliest, wait),
    null,
  )
  return min
}
