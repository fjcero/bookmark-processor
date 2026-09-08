export type ContentType = "post" | "article"
export type PostFormat = "original" | "reply" | "quote" | "repost" | "thread"

export interface DraftJsBlock {
  text?: string
  type?: string
}

export interface GraphQLArticleResult {
  id?: string
  rest_id?: string
  title?: string
  preview_text?: string
  summary_text?: string
  content_state?: { blocks?: DraftJsBlock[]; entityMap?: unknown }
  plain_text?: string
  plaintext?: string
  cover_media?: { media_info?: { original_img_url?: string } }
  media_entities?: Array<{ media_info?: { original_img_url?: string } }>
  metadata?: { first_published_at_secs?: number }
  /** Full article markup scraped from the X page when GraphQL has no body. */
  extracted_html?: string
  hydration_source?: "graphql" | "html"
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function blocksFromPlainText(text: string): DraftJsBlock[] {
  const parts = text
    .split(/\n\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
  const lines = parts.length > 0 ? parts : [text.trim()].filter(Boolean)
  return lines.map((line) => ({ text: line, type: "unstyled" }))
}

function blocksText(blocks: DraftJsBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return ""
  return blocks
    .map((block) => (block?.text ?? "").trim())
    .filter(Boolean)
    .join("\n\n")
}

function rawArticleBodyText(obj: Record<string, unknown>): string | null {
  for (const key of [
    "plain_text",
    "plaintext",
    "body_text",
    "article_text",
    "markdown",
  ] as const) {
    const value = asString(obj[key])
    if (value) return value
  }
  if (typeof obj.content === "string" && obj.content.trim().length > 80) {
    return obj.content
  }
  if (typeof obj.content_state === "string" && obj.content_state.trim().length > 80) {
    try {
      const parsed = JSON.parse(obj.content_state) as unknown
      const nested = asRecord(parsed)
      const fromBlocks = blocksText(nested?.blocks as DraftJsBlock[] | undefined)
      if (fromBlocks) return fromBlocks
    } catch {
      return obj.content_state
    }
  }
  return null
}

function isSubstantialVersusPreview(body: string, preview: string | null): boolean {
  const trimmed = body.trim()
  if (trimmed.length < 80) return false
  const prev = (preview ?? "").trim()
  if (!prev) return trimmed.length >= 120
  return trimmed.length > prev.length + 40
}

export function normalizeArticleResult(
  article: GraphQLArticleResult,
): GraphQLArticleResult {
  const preview = article.preview_text ?? article.summary_text ?? null
  const existingBlocks = article.content_state?.blocks
  const fromBlocks = blocksText(existingBlocks)
  const plain = rawArticleBodyText(article as unknown as Record<string, unknown>)
  const plainIsFull = Boolean(plain && isSubstantialVersusPreview(plain, preview))
  const plainIsRicher =
    plainIsFull &&
    (!fromBlocks || plain!.trim().length > fromBlocks.trim().length + 40)
  if (plainIsRicher && plain) {
    return {
      ...article,
      content_state: {
        ...(article.content_state ?? {}),
        blocks: blocksFromPlainText(plain),
      },
      hydration_source: article.hydration_source ?? "graphql",
    }
  }
  return article
}

export function articleUrl(restId: string): string {
  return `https://x.com/i/article/${restId}`
}

export function articleResultFromUnknown(value: unknown): GraphQLArticleResult | null {
  const obj = asRecord(value)
  if (!obj) return null
  const title = asString(obj.title)
  const restId = asString(obj.rest_id) ?? asString(obj.id)
  const contentState = asRecord(obj.content_state) ?? asRecord(obj.contentState)
  const hasBlocks = Array.isArray(contentState?.blocks)
  const hasHtml = typeof obj.extracted_html === "string" && obj.extracted_html.length > 0
  if (!title && !restId && !hasBlocks && !hasHtml) return null
  if (!obj.content_state && contentState) {
    return normalizeArticleResult({
      ...(obj as GraphQLArticleResult),
      content_state: contentState,
    })
  }
  return normalizeArticleResult(obj as GraphQLArticleResult)
}

export function articleResultFromTweet(tweet: unknown): GraphQLArticleResult | null {
  const obj = asRecord(tweet)
  if (!obj) return null
  const nested =
    asRecord(asRecord(asRecord(obj.article)?.article_results)?.result) ??
    asRecord(asRecord(obj.article_results)?.result)
  return articleResultFromUnknown(nested)
}

export function articleRestId(result: GraphQLArticleResult | null | undefined): string | null {
  if (!result) return null
  return asString(result.rest_id) ?? null
}

export function hasArticleBody(result: unknown): boolean {
  const article = articleResultFromUnknown(result) ?? articleResultFromTweet(result)
  const blocks = article?.content_state?.blocks
  if (Array.isArray(blocks) && blocks.some((block) => Boolean(block?.text?.trim()))) {
    return true
  }
  return Boolean(article?.extracted_html && article.extracted_html.length > 200)
}

export const ARTICLE_RAW_KEY = "_articleRaw"

export function articleRawFrom(value: unknown): unknown | undefined {
  const raw = asRecord(value)?.[ARTICLE_RAW_KEY]
  return raw === undefined ? undefined : raw
}

export function stampArticleRaw(tweet: unknown, raw: unknown): Record<string, unknown> {
  const base = asRecord(tweet) ? { ...(tweet as Record<string, unknown>) } : {}
  if (raw != null) base[ARTICLE_RAW_KEY] = raw
  return base
}

/** True only when the body is substantially longer than the bookmark preview. */
export function hasFullArticleBody(result: unknown): boolean {
  const article = articleResultFromUnknown(result) ?? articleResultFromTweet(result)
  if (!article) return false
  const preview = article.preview_text ?? article.summary_text ?? null
  const normalized = normalizeArticleResult(article)
  const blocks = flattenArticleBlocks(normalized)
  if (isSubstantialVersusPreview(blocks, preview)) return true
  const plain = rawArticleBodyText(normalized as unknown as Record<string, unknown>)
  if (plain && isSubstantialVersusPreview(plain, preview)) return true
  const html = (normalized.extracted_html ?? "").replace(/<[^>]+>/g, " ").trim()
  return html.length > 400 && isSubstantialVersusPreview(html, preview)
}

export function flattenArticleBlocks(result: GraphQLArticleResult | null | undefined): string {
  const blocks = result?.content_state?.blocks
  if (!Array.isArray(blocks)) return ""
  return blocks
    .map((block) => (block?.text ?? "").trim())
    .filter(Boolean)
    .join("\n\n")
}

export function articleBodyLength(result: GraphQLArticleResult | null | undefined): number {
  if (!result) return 0
  const normalized = normalizeArticleResult(result)
  const fromBlocks = flattenArticleBlocks(normalized).trim().length
  const fromHtml = (normalized.extracted_html ?? "").trim().length
  const fromPlain = (rawArticleBodyText(normalized as unknown as Record<string, unknown>) ?? "").trim()
    .length
  return Math.max(fromBlocks, fromHtml, fromPlain)
}

export function articlePlainText(result: GraphQLArticleResult | null | undefined): string {
  if (!result) return ""
  const normalized = normalizeArticleResult(result)
  const title = normalized.title?.trim() ?? ""
  const body = flattenArticleBlocks(normalized)
  if (body) return [title, body].filter(Boolean).join("\n\n")
  const preview = normalized.preview_text?.trim() ?? ""
  const summary = normalized.summary_text?.trim() ?? ""
  return [title, preview || summary].filter(Boolean).join("\n\n")
}

export function articleCoverUrl(result: GraphQLArticleResult | null | undefined): string | null {
  return asString(result?.cover_media?.media_info?.original_img_url)
}

export function articleMediaUrls(result: GraphQLArticleResult | null | undefined): string[] {
  const urls: string[] = []
  const cover = articleCoverUrl(result)
  if (cover) urls.push(cover)
  for (const entity of result?.media_entities ?? []) {
    const url = asString(entity?.media_info?.original_img_url)
    if (url && !urls.includes(url)) urls.push(url)
  }
  return urls
}

export function isArticleWrapper(tweet: unknown): boolean {
  return articleRestId(articleResultFromTweet(tweet)) != null
}

export function contentTypeOfTweet(tweet: unknown): ContentType {
  return isArticleWrapper(tweet) ? "article" : "post"
}

export function derivePostFormat(tweet: unknown): PostFormat {
  const obj = asRecord(tweet)
  if (!obj) return "original"
  const legacy = asRecord(obj.legacy) ?? obj
  if (legacy.self_thread != null || obj.self_thread != null) return "thread"
  if (
    asString(legacy.in_reply_to_status_id_str) ||
    asString(obj.in_reply_to_tweet_id) ||
    asString(obj.in_reply_to_status_id_str)
  ) {
    return "reply"
  }
  if (
    asString(legacy.retweeted_status_id_str) ||
    asRecord(obj.retweeted_status_result) ||
    asRecord(legacy.retweeted_status_result)
  ) {
    return "repost"
  }
  if (
    asString(legacy.quoted_status_id_str) ||
    asString(obj.quoted_status_id_str) ||
    asString(obj.quoted_tweet_id_str) ||
    asRecord(obj.quoted_status_result) ||
    asRecord(obj.quoted_ref_result)
  ) {
    return "quote"
  }
  return "original"
}

export function findArticleResults(value: unknown, depth = 0): GraphQLArticleResult[] {
  const found: GraphQLArticleResult[] = []
  const seen = new Set<unknown>()

  function walk(node: unknown, level: number): void {
    if (!node || typeof node !== "object" || level > 14 || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) walk(item, level + 1)
      return
    }
    const record = node as Record<string, unknown>
    const nested = asRecord(asRecord(record.article_results)?.result)
    const direct = articleResultFromUnknown(nested ?? record)
    if (direct && (direct.title || direct.rest_id || hasArticleBody(direct))) {
      if (
        nested ||
        record.content_state ||
        record.contentState ||
        record.preview_text ||
        record.plain_text ||
        record.plaintext ||
        record.body_text ||
        record.extracted_html
      ) {
        found.push(direct)
      }
    }
    for (const child of Object.values(record)) walk(child, level + 1)
  }

  walk(value, depth)
  const unique = new Map<string, GraphQLArticleResult>()
  for (const article of found) {
    const key = articleRestId(article) ?? article.title ?? JSON.stringify(article.title)
    const prev = unique.get(key)
    if (!prev || articleBodyLength(article) > articleBodyLength(prev)) {
      unique.set(key, article)
    }
  }
  return [...unique.values()]
}

export function findHydratedArticleResult(value: unknown): GraphQLArticleResult | null {
  const found = findArticleResults(value)
  const full = found.filter((article) => hasFullArticleBody(article))
  const candidates = full.length > 0 ? full : found.filter((article) => hasArticleBody(article))
  const picked = [...candidates].sort(
    (a, b) => articleBodyLength(b) - articleBodyLength(a),
  )[0]
  if (!picked) return null
  return picked.hydration_source ? picked : { ...picked, hydration_source: "graphql" }
}

export function isRicherArticlePayload(incoming: unknown, existing: unknown): boolean {
  if (articleRawFrom(incoming) != null && articleRawFrom(existing) == null) return true
  const incomingArticle =
    articleResultFromTweet(incoming) ?? findHydratedArticleResult(incoming)
  if (!incomingArticle || !hasArticleBody(incomingArticle)) return false
  const existingArticle =
    articleResultFromTweet(existing) ?? findHydratedArticleResult(existing)
  const incomingLen = articleBodyLength(incomingArticle)
  const existingLen = articleBodyLength(existingArticle)
  if (existingLen === 0) return true
  return incomingLen > existingLen + 40
}

export function mergeArticleResults(
  existing: GraphQLArticleResult | null | undefined,
  incoming: GraphQLArticleResult,
): GraphQLArticleResult {
  const current = existing ? normalizeArticleResult(existing) : incoming
  const next = normalizeArticleResult(incoming)
  const takeIncomingBody = articleBodyLength(next) > articleBodyLength(current)
  return {
    ...current,
    ...next,
    title: next.title || current.title,
    preview_text: next.preview_text || current.preview_text,
    summary_text: next.summary_text || current.summary_text,
    rest_id: next.rest_id || current.rest_id,
    content_state: takeIncomingBody
      ? (next.content_state ?? current.content_state)
      : (current.content_state ?? next.content_state),
    extracted_html: takeIncomingBody
      ? (next.extracted_html || current.extracted_html)
      : (current.extracted_html || next.extracted_html),
    plain_text: takeIncomingBody
      ? (next.plain_text || current.plain_text)
      : (current.plain_text || next.plain_text),
    hydration_source: takeIncomingBody
      ? (next.hydration_source ?? current.hydration_source)
      : (current.hydration_source ?? next.hydration_source),
    cover_media: next.cover_media ?? current.cover_media,
    media_entities:
      (next.media_entities?.length ?? 0) > 0
        ? next.media_entities
        : current.media_entities,
  }
}

export function mergeArticleIntoTweet(
  tweet: unknown,
  article: GraphQLArticleResult,
): Record<string, unknown> {
  const base = asRecord(tweet) ? { ...(tweet as Record<string, unknown>) } : {}
  const existingArticle = asRecord(base.article) ?? {}
  const existingResults = asRecord(existingArticle.article_results) ?? {}
  const existingResult = articleResultFromUnknown(existingResults.result)
  base.article = {
    ...existingArticle,
    article_results: {
      ...existingResults,
      result: mergeArticleResults(existingResult, article),
    },
  }
  const incomingRaw = articleRawFrom(tweet) ?? articleRawFrom(article)
  if (incomingRaw != null && articleRawFrom(base) == null) {
    base[ARTICLE_RAW_KEY] = incomingRaw
  }
  return base
}

export function hasCompleteArticleRaw(value: unknown): boolean {
  const article =
    findHydratedArticleResult(value) ?? articleResultFromTweet(value)
  if (hasFullArticleBody(article)) return true
  const stamped = articleRawFrom(value)
  if (stamped == null) return false
  return hasFullArticleBody(
    findHydratedArticleResult(stamped) ?? articleResultFromUnknown(stamped),
  )
}

export function isPendingArticleRaw(rawJson: string, contentType?: string): boolean {
  if (contentType && contentType !== "article") return false
  try {
    const parsed = JSON.parse(rawJson) as unknown
    if (!isArticleWrapper(parsed) && contentType !== "article") return false
    return !hasCompleteArticleRaw(parsed)
  } catch {
    return contentType === "article"
  }
}

export interface PendingArticleRef {
  tweetId: string
  articleId: string
  url: string
  refetch?: boolean
}

export function pendingArticleFromRaw(
  tweetId: string,
  rawJson: string,
  url: string | null,
  opts?: { refetch?: boolean },
): PendingArticleRef | null {
  try {
    const parsed = JSON.parse(rawJson) as unknown
    const article = articleResultFromTweet(parsed)
    const articleId = articleRestId(article)
    if (!articleId) return null
    if (hasCompleteArticleRaw(parsed)) return null
    return {
      tweetId,
      articleId,
      url: url && url.includes("/i/article/") ? url : articleUrl(articleId),
      ...(opts?.refetch ? { refetch: true } : {}),
    }
  } catch {
    return null
  }
}

const UNAVAILABLE_DOCUMENT_PHRASES = [
  "this article is not supported or the owner removed",
  "owner removed the article",
  "unable to show this content",
  "content may be private, deleted",
] as const

const UNSUPPORTED_CLIENT_PHRASES = [
  "latest version of x",
  "visit the author's profile",
  "visit the author’s profile",
] as const

export function isUnsupportedClientDocument(
  root: { innerText?: string } | null | undefined,
): boolean {
  const text = (root?.innerText ?? "").toLowerCase()
  if (!text) return false
  return UNSUPPORTED_CLIENT_PHRASES.some((phrase) => text.includes(phrase))
}

export function isArticleUnavailableDocument(
  root: { innerText?: string } | null | undefined,
): boolean {
  const text = (root?.innerText ?? "").toLowerCase()
  if (!text) return false
  if (isUnsupportedClientDocument({ innerText: text })) return false
  return UNAVAILABLE_DOCUMENT_PHRASES.some((phrase) => text.includes(phrase))
}

export function isArticleUnavailablePayload(value: unknown): boolean {
  const seen = new Set<unknown>()

  function walk(node: unknown, depth: number): boolean {
    if (!node || typeof node !== "object" || depth > 16 || seen.has(node)) return false
    seen.add(node)

    if (Array.isArray(node)) {
      return node.some((item) => walk(item, depth + 1))
    }

    const record = node as Record<string, unknown>
    const typename = asString(record.__typename)?.toLowerCase() ?? ""
    if (
      typename.includes("unavailable") ||
      typename.includes("notfound") ||
      typename.includes("not_found")
    ) {
      return true
    }

    const reason = asString(record.reason)?.toLowerCase() ?? ""
    if (reason && /(unavailable|deleted|removed|not.?found|private)/.test(reason)) {
      return true
    }

    const message = asString(record.message)?.toLowerCase() ?? ""
    if (
      message &&
      /(owner removed|unable to show this content|private, deleted)/.test(message)
    ) {
      return true
    }

    const title = asString(record.title)?.toLowerCase() ?? ""
    if (title.includes("unable to show this content")) return true

    return Object.values(record).some((child) => walk(child, depth + 1))
  }

  return walk(value, 0)
}
