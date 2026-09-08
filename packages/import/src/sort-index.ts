/** Stamped onto captured tweet objects so it survives without raw timeline responses. */
export const SORT_INDEX_KEY = "_sortIndex"

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

export function normalizeSortIndex(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return String(Math.trunc(value))
  }
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!/^\d{5,}$/.test(trimmed)) return null
  return trimmed
}

export function compareSortIndex(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length
  if (a === b) return 0
  return a < b ? -1 : 1
}

export function sortIndexFromTweet(tweet: unknown): string | null {
  const obj = asRecord(tweet)
  if (!obj) return null
  return normalizeSortIndex(obj[SORT_INDEX_KEY] ?? obj.sortIndex)
}

export function stampSortIndex(tweet: unknown, sortIndex: string): void {
  const obj = asRecord(tweet)
  if (!obj) return
  const current = normalizeSortIndex(obj[SORT_INDEX_KEY])
  if (!current || compareSortIndex(sortIndex, current) > 0) {
    obj[SORT_INDEX_KEY] = sortIndex
  }
}

function tweetRestId(node: Record<string, unknown>): string | null {
  const direct = node.rest_id
  if (typeof direct === "string" && direct.length > 5) {
    if (node.__typename === "User") return null
    if (node.legacy != null || node.core != null || node.__typename === "Tweet") {
      return direct
    }
  }
  const nested = asRecord(asRecord(node.tweet_results)?.result)
  if (!nested) return null
  if (
    nested.__typename === "TweetWithVisibilityResults" ||
    nested.__typename === "TweetWithVisibilityResult"
  ) {
    const inner = asRecord(nested.tweet)
    return typeof inner?.rest_id === "string" ? inner.rest_id : null
  }
  return typeof nested.rest_id === "string" ? nested.rest_id : null
}

export function collectSortIndexes(value: unknown): Map<string, string> {
  const found = new Map<string, string>()
  const seen = new Set<unknown>()

  function remember(id: string, sortIndex: string): void {
    const current = found.get(id)
    if (!current || compareSortIndex(sortIndex, current) > 0) {
      found.set(id, sortIndex)
    }
  }

  function walk(node: unknown, inherited: string | null, depth: number): void {
    if (!node || typeof node === "string" || typeof node === "number" || depth > 18) {
      return
    }
    if (seen.has(node)) return
    if (typeof node === "object") seen.add(node)

    if (Array.isArray(node)) {
      for (const child of node) walk(child, inherited, depth + 1)
      return
    }

    const record = asRecord(node)
    if (!record) return
    const data = record.data
    if (data && record.url != null) {
      walk(data, inherited, depth + 1)
      return
    }

    const sortIndex =
      normalizeSortIndex(record.sortIndex) ??
      normalizeSortIndex(record[SORT_INDEX_KEY]) ??
      inherited
    const restId = tweetRestId(record)
    if (restId && sortIndex) remember(restId, sortIndex)

    for (const [key, child] of Object.entries(record)) {
      if (key === "quoted_status_result") continue
      walk(child, sortIndex, depth + 1)
    }
  }

  walk(value, null, 0)
  return found
}

export function applySortIndexes(
  tweets: Record<string, unknown>,
  source: unknown,
): void {
  for (const [id, sortIndex] of collectSortIndexes(source)) {
    stampSortIndex(tweets[id], sortIndex)
  }
}
