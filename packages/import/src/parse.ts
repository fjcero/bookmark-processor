import {
  articlePlainText,
  articleRawFrom,
  articleRestId,
  articleResultFromTweet,
  articleUrl,
  contentTypeOfTweet,
  findHydratedArticleResult,
  hasArticleBody,
  mergeArticleIntoTweet,
  stampArticleRaw,
} from './article.ts'
import { collectSortIndexes, compareSortIndex, sortIndexFromTweet } from './sort-index.ts'
import type {
  ExportSource,
  ExportV2,
  GraphQLTweet,
  GraphQLUser,
  NormalizedItem,
  NormalizedUser,
  ParsedExport,
} from './types.ts'
import { X_SOURCE } from './types.ts'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function unwrapTweet(tweet: GraphQLTweet | undefined | null): GraphQLTweet | null {
  if (!tweet) return null
  if (
    tweet.__typename === 'TweetWithVisibilityResults' ||
    tweet.__typename === 'TweetWithVisibilityResult'
  ) {
    return tweet.tweet ?? tweet
  }
  return tweet
}

function isTweetObject(value: unknown): value is GraphQLTweet {
  const obj = asRecord(value)
  if (!obj) return false
  if (obj.__typename === 'User') return false
  if (obj.__typename === 'Tweet') return true
  if (
    obj.__typename === 'TweetWithVisibilityResults' ||
    obj.__typename === 'TweetWithVisibilityResult'
  ) {
    return true
  }
  const restId = obj.rest_id
  if (typeof restId !== 'string' || restId.length <= 5) return false
  if (obj.legacy != null || obj.core != null) return true
  // Extension hydration uploads { rest_id, article } without core/legacy.
  return obj.article != null
}

/** True when parseExportV2 would emit a library item for this tweet. */
export function isImportableTweet(value: unknown): boolean {
  if (!isTweetObject(value)) return false
  const unwrapped = unwrapTweet(value as GraphQLTweet)
  if (!unwrapped) return false
  const embeddedUser = unwrapped.core?.user_results?.result
  const authorId = embeddedUser?.rest_id ?? unwrapped.legacy?.user_id_str ?? ''
  if (authorId) return true
  return contentTypeOfTweet(unwrapped) === 'article'
}

function isUserObject(value: unknown): value is GraphQLUser {
  const obj = asRecord(value)
  if (!obj) return false
  if (obj.__typename === 'User') return true
  const restId = obj.rest_id
  const core = asRecord(obj.core)
  const legacy = asRecord(obj.legacy)
  const hasHandle =
    typeof core?.screen_name === 'string' || typeof legacy?.screen_name === 'string'
  return typeof restId === 'string' && hasHandle && obj.__typename !== 'Tweet'
}

function tweetFullText(tweet: GraphQLTweet): string {
  const article = articleResultFromTweet(tweet)
  if (article) return articlePlainText(article)
  const note = tweet.note_tweet?.note_tweet_results?.result?.text
  if (note) return note
  return tweet.legacy?.full_text ?? ''
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function originUrl(handle: string | undefined, restId: string): string {
  return handle ? `https://x.com/${handle}/status/${restId}` : `https://x.com/i/status/${restId}`
}

function normalizeItem(
  tweet: GraphQLTweet,
  mapKey: string,
  kind: ExportSource,
): NormalizedItem | null {
  const unwrapped = unwrapTweet(tweet)
  if (!unwrapped) return null
  const id = unwrapped.rest_id ?? mapKey
  if (!id) return null

  const embeddedUser = unwrapped.core?.user_results?.result
  const authorId = embeddedUser?.rest_id ?? unwrapped.legacy?.user_id_str ?? ''
  const handle = embeddedUser?.core?.screen_name ?? embeddedUser?.legacy?.screen_name
  const article = articleResultFromTweet(unwrapped)
  const articleId = articleRestId(article)
  const contentType = contentTypeOfTweet(unwrapped)
  if (!authorId && contentType !== 'article') return null

  return {
    id,
    authorId,
    text: tweetFullText(unwrapped),
    createdAt: parseDate(unwrapped.legacy?.created_at),
    source: X_SOURCE,
    kind,
    contentType,
    url: articleId ? articleUrl(articleId) : originUrl(handle, id),
    sortIndex: sortIndexFromTweet(unwrapped),
    rawJson: JSON.stringify(unwrapped),
  }
}

function normalizeUser(user: GraphQLUser): NormalizedUser | null {
  const id = user.rest_id
  if (!id) return null
  const handle = user.core?.screen_name ?? user.legacy?.screen_name ?? ''
  const name = user.core?.name ?? user.legacy?.name ?? handle
  const avatarUrl =
    user.avatar?.image_url ?? user.legacy?.profile_image_url_https ?? null
  return {
    id,
    handle,
    name: name || handle || id,
    avatarUrl,
  }
}

function userRichness(user: NormalizedUser): number {
  return (user.handle ? 1 : 0) + (user.name ? 1 : 0) + (user.avatarUrl ? 2 : 0)
}

function mergeUser(existing: NormalizedUser | undefined, next: NormalizedUser): NormalizedUser {
  if (!existing) return next
  return userRichness(next) >= userRichness(existing) ? next : existing
}

function parseKind(value: unknown): ExportSource {
  if (value === 'like') return 'like'
  if (value === 'history') return 'history'
  return 'bookmark'
}

function applyArticleBodiesFromResponses(
  tweets: Record<string, unknown>,
  responses: unknown[],
): void {
  const keys = Object.keys(tweets)
  if (keys.length === 0) return

  for (const response of responses) {
    const record = asRecord(response)
    const data = record?.data ?? response
    const article = findHydratedArticleResult(data)
    if (!article || !hasArticleBody(article)) continue
    const articleId = articleRestId(article)
    let targets = keys.filter((key) => {
      const id = articleRestId(articleResultFromTweet(tweets[key]))
      return id != null && id === articleId
    })
    if (targets.length === 0 && keys.length === 1) targets = keys
    for (const key of targets) {
      tweets[key] = stampArticleRaw(mergeArticleIntoTweet(tweets[key], article), data)
    }
  }

  for (const key of keys) {
    const tweet = tweets[key]
    const raw = articleRawFrom(tweet)
    if (raw == null) continue
    const article = findHydratedArticleResult(raw) ?? findHydratedArticleResult(tweet)
    if (!article || !hasArticleBody(article)) continue
    tweets[key] = stampArticleRaw(mergeArticleIntoTweet(tweet, article), raw)
  }
}

export function parseExportV2(json: string | object): ParsedExport {
  let data: unknown
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json)
    } catch {
      throw new Error('Invalid JSON')
    }
  } else {
    data = json
  }

  const root = asRecord(data)
  if (!root) throw new Error('Export must be a JSON object')
  if (root.exportVersion !== 2) {
    throw new Error('Expected exportVersion 2')
  }
  const tweetsRecord = asRecord(root.tweets)
  if (!tweetsRecord) throw new Error('Export is missing tweets map')
  const tweetsMap = { ...tweetsRecord }
  applyArticleBodiesFromResponses(
    tweetsMap,
    Array.isArray(root.responses) ? root.responses : [],
  )

  const kind = parseKind(root.source)
  const usersById = new Map<string, NormalizedUser>()
  const items: NormalizedItem[] = []

  for (const [key, value] of Object.entries(tweetsMap)) {
    if (isUserObject(value)) {
      const user = normalizeUser(value)
      if (user) usersById.set(user.id, mergeUser(usersById.get(user.id), user))
      continue
    }

    if (!isTweetObject(value)) continue
    const item = normalizeItem(value, key, kind)
    if (!item) continue
    items.push(item)

    const embedded = unwrapTweet(value)?.core?.user_results?.result
    if (embedded && isUserObject(embedded)) {
      const user = normalizeUser(embedded)
      if (user) usersById.set(user.id, mergeUser(usersById.get(user.id), user))
    }
  }

  const exportV2 = root as unknown as ExportV2
  const sortIndexes = collectSortIndexes(exportV2.responses)
  for (const item of items) {
    const fromTimeline = sortIndexes.get(item.id)
    if (!fromTimeline) continue
    if (!item.sortIndex || compareSortIndex(fromTimeline, item.sortIndex) > 0) {
      item.sortIndex = fromTimeline
    }
  }

  return {
    meta: {
      exportVersion: 2,
      kind,
      exportedAt: typeof exportV2.exportedAt === 'string' ? exportV2.exportedAt : new Date().toISOString(),
    },
    users: Array.from(usersById.values()),
    items,
    responses: Array.isArray(exportV2.responses) ? exportV2.responses : [],
  }
}
