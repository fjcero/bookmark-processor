import type { DraftJsBlock, GraphQLArticleResult } from "./article"

const CHROME_EXACT = new Set([
  "home",
  "explore",
  "notifications",
  "messages",
  "grok",
  "premium",
  "communities",
  "lists",
  "bookmarks",
  "jobs",
  "profile",
  "more",
  "post",
  "posts",
  "replies",
  "highlights",
  "articles",
  "article",
  "media",
  "likes",
  "follow",
  "following",
  "followers",
  "subscribe",
  "reply",
  "repost",
  "quote",
  "share",
  "bookmark",
  "bookmarked",
  "copy link",
  "read more",
  "show more",
  "relevant people",
  "who to follow",
  "trending",
  "back",
  "new posts",
  "log in",
  "sign up",
])

export interface ArticlePageContent {
  articleId: string
  innerText: string
  html?: string
  imageUrls?: string[]
}

function isChromeLine(line: string): boolean {
  const normalized = line.trim().toLowerCase()
  if (!normalized) return true
  if (CHROME_EXACT.has(normalized)) return true
  if (/^\d+(\.\d+)?[kmb]?$/.test(normalized)) return true
  if (/^·$/.test(normalized)) return true
  if (/^\d+[smhd]$/.test(normalized)) return true
  if (/^\d+ (seconds?|minutes?|hours?|days?) ago$/i.test(normalized)) return true
  return false
}

function isBylineLine(line: string): boolean {
  if (line.startsWith("@") && !line.includes(" ")) return true
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(line)) {
    return true
  }
  if (/^\w{3,9} \d{1,2}(, \d{4})?$/.test(line)) return true
  if (line.length <= 42 && !/[.?!]/.test(line) && !line.includes("http")) {
    return true
  }
  return false
}

export function isSubstantialArticleBody(
  title: string,
  paragraphs: string[],
): boolean {
  const body = paragraphs.join("\n\n").trim()
  if (body.length >= 400) return true
  const longParas = paragraphs.filter((paragraph) => paragraph.length >= 40)
  return longParas.length >= 2 && body.length >= 120
}

export function splitArticlePageText(innerText: string): {
  title: string
  paragraphs: string[]
} {
  const lines = innerText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isChromeLine(line))

  let index = 0
  if (lines[0] && /^(article|articles)$/i.test(lines[0])) index += 1
  const title = lines[index] ?? ""
  if (title) index += 1
  while (index < lines.length && isBylineLine(lines[index]!)) index += 1
  return { title, paragraphs: lines.slice(index) }
}

function isArticleImage(src: string): boolean {
  if (!src || src.startsWith("data:")) return false
  if (src.includes("profile_images") || src.includes("emoji/v2")) return false
  if (src.includes("hashflag") || src.includes("/css/")) return false
  return (
    /pbs\.twimg\.com/i.test(src) ||
    /twimg\.com\/media/i.test(src) ||
    /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(src)
  )
}

function uniqueUrls(urls: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const url of urls) {
    const trimmed = url.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function sanitizeArticleHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, "")
    .trim()
}

export function articleFromPageContent(
  input: ArticlePageContent,
): GraphQLArticleResult | null {
  const { title, paragraphs } = splitArticlePageText(input.innerText)
  if (!isSubstantialArticleBody(title, paragraphs)) return null

  const blocks: DraftJsBlock[] = paragraphs.map((text) => ({
    text,
    type: "unstyled",
  }))
  const images = uniqueUrls((input.imageUrls ?? []).filter(isArticleImage))
  const cover = images[0]
  const body = paragraphs.join("\n\n")

  return {
    rest_id: input.articleId,
    title: title || undefined,
    preview_text: body.slice(0, 200),
    content_state: { blocks },
    cover_media: cover
      ? { media_info: { original_img_url: cover } }
      : undefined,
    media_entities: images.slice(cover ? 1 : 0).map((url) => ({
      media_info: { original_img_url: url },
    })),
    extracted_html: input.html ? sanitizeArticleHtml(input.html) : undefined,
    hydration_source: "html",
  }
}

export interface ArticleDocumentLike {
  body?: { innerText?: string } | null
  querySelector: (selector: string) => Element | null
}

function elementText(node: Element | null): string {
  if (!node) return ""
  const htmlNode = node as HTMLElement
  return (htmlNode.innerText ?? node.textContent ?? "").trim()
}

function imageUrlsFrom(root: Element): string[] {
  return Array.from(root.querySelectorAll("img"))
    .map((img) => {
      const el = img as HTMLImageElement
      return el.currentSrc || el.src || img.getAttribute("src") || ""
    })
    .filter(Boolean)
}

export function articleFromDocument(
  doc: ArticleDocumentLike,
  articleId: string,
): GraphQLArticleResult | null {
  const column =
    doc.querySelector('[data-testid="primaryColumn"]') ??
    doc.querySelector("main") ??
    (doc.body as Element | null)
  if (!column) return null
  return articleFromPageContent({
    articleId,
    innerText: elementText(column),
    html: (column as HTMLElement).innerHTML,
    imageUrls: imageUrlsFrom(column),
  })
}
