import type {
  ExportSource,
  ExportV2,
  GraphQLTweet,
  GraphQLUser,
  NormalizedTweet,
  NormalizedUser,
  ParsedExport,
} from './types'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function jsonSize(value: unknown): number {
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
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
  return (
    typeof restId === 'string' &&
    restId.length > 5 &&
    (obj.legacy != null || obj.core != null)
  )
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
  const note = tweet.note_tweet?.note_tweet_results?.result?.text
  if (note) return note
  const article = tweet.article?.article_results?.result
  if (article) {
    const parts: string[] = []
    if (article.title) parts.push(article.title)
    if (article.content) parts.push(article.content)
    if (parts.length > 0) return parts.join('\n\n')
  }
  return tweet.legacy?.full_text ?? ''
}

function parseTwitterDate(value: string | undefined): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
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
    rawJson: JSON.stringify(user),
  }
}

function mergeUser(existing: NormalizedUser | undefined, next: NormalizedUser): NormalizedUser {
  if (!existing) return next
  return jsonSize(JSON.parse(next.rawJson)) >= jsonSize(JSON.parse(existing.rawJson))
    ? next
    : existing
}

function normalizeTweet(
  tweet: GraphQLTweet,
  mapKey: string,
  source: ExportSource,
): NormalizedTweet | null {
  const unwrapped = unwrapTweet(tweet)
  if (!unwrapped) return null
  const id = unwrapped.rest_id ?? mapKey
  if (!id) return null

  const embeddedUser = unwrapped.core?.user_results?.result
  const authorId = embeddedUser?.rest_id ?? unwrapped.legacy?.user_id_str
  if (!authorId) return null

  return {
    id,
    authorId,
    text: tweetFullText(unwrapped),
    createdAt: parseTwitterDate(unwrapped.legacy?.created_at),
    source,
    rawJson: JSON.stringify(unwrapped),
  }
}

function parseSource(value: unknown): ExportSource {
  return value === 'like' ? 'like' : 'bookmark'
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
  const tweetsMap = asRecord(root.tweets)
  if (!tweetsMap) throw new Error('Export is missing tweets map')

  const source = parseSource(root.source)
  const usersById = new Map<string, NormalizedUser>()
  const tweets: NormalizedTweet[] = []

  for (const [key, value] of Object.entries(tweetsMap)) {
    if (isUserObject(value)) {
      const user = normalizeUser(value)
      if (user) usersById.set(user.id, mergeUser(usersById.get(user.id), user))
      continue
    }

    if (!isTweetObject(value)) continue
    const tweet = normalizeTweet(value, key, source)
    if (!tweet) continue
    tweets.push(tweet)

    const embedded = unwrapTweet(value)?.core?.user_results?.result
    if (embedded && isUserObject(embedded)) {
      const user = normalizeUser(embedded)
      if (user) usersById.set(user.id, mergeUser(usersById.get(user.id), user))
    }
  }

  const exportV2 = root as unknown as ExportV2

  return {
    meta: {
      exportVersion: 2,
      source,
      exportedAt: typeof exportV2.exportedAt === 'string' ? exportV2.exportedAt : new Date().toISOString(),
    },
    users: Array.from(usersById.values()),
    tweets,
    responses: Array.isArray(exportV2.responses) ? exportV2.responses : [],
  }
}
