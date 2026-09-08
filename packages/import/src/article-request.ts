export function isArticleApiUrl(url: string): boolean {
  const value = url.toLowerCase()
  return (
    value.includes("/graphql/") ||
    value.includes("/i/api/") ||
    value.includes("/2/articles") ||
    value.includes("articleentity")
  )
}

export function requestMentionsArticle(
  url: string,
  body: string | undefined,
  articleId: string,
): boolean {
  if (articleId && (url.includes(articleId) || Boolean(body?.includes(articleId)))) {
    return true
  }
  return /ArticleEntityResultByRestId|ArticleByRestId/i.test(url)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function enableBodyToggles(toggles: Record<string, unknown>): void {
  toggles.withArticlePlainText = true
  toggles.withArticleRichContentState = true
}

function looksLikeFieldToggles(record: Record<string, unknown>): boolean {
  return (
    "withArticlePlainText" in record ||
    "withArticleRichContentState" in record ||
    "withGrokAnalyze" in record
  )
}

export function enableArticleBodyFieldToggles(value: unknown): void {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) enableArticleBodyFieldToggles(item)
    return
  }
  const record = value as Record<string, unknown>
  if (looksLikeFieldToggles(record)) enableBodyToggles(record)

  const nestedToggles = asRecord(record.fieldToggles)
  if (nestedToggles) {
    enableBodyToggles(nestedToggles)
  } else if (asRecord(record.variables) != null) {
    record.fieldToggles = {
      withArticlePlainText: true,
      withArticleRichContentState: true,
    }
  }

  for (const child of Object.values(record)) {
    if (child && typeof child === "object") enableArticleBodyFieldToggles(child)
  }
}

const ARTICLE_FIELD_TOGGLES = JSON.stringify({
  withArticlePlainText: true,
  withArticleRichContentState: true,
})

export function withArticleBodyToggles(
  url: string,
  body?: string,
): { url: string; body?: string } {
  const next = new URL(url)
	for (const [key, raw] of Array.from(next.searchParams.entries())) {
    if (!raw.startsWith("{") && !raw.startsWith("[")) continue
    try {
      const parsed = JSON.parse(raw) as unknown
      enableArticleBodyFieldToggles(parsed)
      next.searchParams.set(key, JSON.stringify(parsed))
    } catch {
      /* keep original param */
    }
  }
  if (next.searchParams.has("variables") && !next.searchParams.has("fieldToggles")) {
    next.searchParams.set("fieldToggles", ARTICLE_FIELD_TOGGLES)
  }
  let nextBody = body
  if (nextBody) {
    try {
      const parsed = JSON.parse(nextBody) as unknown
      enableArticleBodyFieldToggles(parsed)
      const record = asRecord(parsed)
      if (record && asRecord(record.variables) && !asRecord(record.fieldToggles)) {
        record.fieldToggles = {
          withArticlePlainText: true,
          withArticleRichContentState: true,
        }
      }
      nextBody = JSON.stringify(parsed)
    } catch {
      /* keep original body */
    }
  }
  return { url: next.toString(), body: nextBody }
}
