import { completePrompt, extractJsonArray } from './llm'
import type { ExtractedEntities } from './entities'

export interface Understanding {
  summary: string
  tags: string[]
  sentiment: string
  people: string[]
  companies: string[]
}

export const EMPTY_UNDERSTANDING: Understanding = {
  summary: '',
  tags: [],
  sentiment: 'neutral',
  people: [],
  companies: [],
}

export interface ItemForUnderstanding {
  tweetId: string
  text: string
  entities?: ExtractedEntities | null
}

interface UnderstandingResult {
  tweetId: string
  understanding: Understanding
}

const BATCH_SIZE = 12

function buildUnderstandingPrompt(items: ItemForUnderstanding[]): string {
  const payload = items.map((item) => {
    const entry: Record<string, unknown> = {
      tweetId: item.tweetId,
      text: item.text.slice(0, 500),
    }
    if (item.entities?.hashtags?.length) entry.hashtags = item.entities.hashtags.slice(0, 8)
    if (item.entities?.tools?.length) entry.tools = item.entities.tools
    if (item.entities?.mentions?.length) entry.mentions = item.entities.mentions.slice(0, 5)
    if (item.entities?.tweetType) entry.tweetType = item.entities.tweetType
    return entry
  })

  return `Generate a short understanding of each Twitter/X bookmark.

For each item return:
- tweetId: the same id you received
- summary: one sentence, max 20 words
- tags: 10-15 specific semantic search tags (2-5 words each). No generic terms like "twitter post" or "social media"
- sentiment: one of "positive", "negative", "neutral", "humorous", "controversial"
- people: named people mentioned (max 5)
- companies: company/product/tool names explicitly referenced (max 8)

Return ONLY valid JSON, no markdown:
[{"tweetId":"...","summary":"...","tags":[...],"sentiment":"...","people":[...],"companies":[...]}]

BOOKMARKS:
${JSON.stringify(payload, null, 1)}`
}

function parseUnderstanding(text: string): UnderstandingResult[] {
  const parsed = extractJsonArray(text)
  return parsed.map((raw) => {
    const item = raw as Record<string, unknown>
    const tags = Array.isArray(item.tags) ? item.tags.map((t) => String(t)).filter(Boolean).slice(0, 15) : []
    const people = Array.isArray(item.people) ? item.people.map((p) => String(p)).filter(Boolean).slice(0, 5) : []
    const companies = Array.isArray(item.companies)
      ? item.companies.map((c) => String(c)).filter(Boolean).slice(0, 8)
      : []
    return {
      tweetId: String(item.tweetId ?? ''),
      understanding: {
        summary: String(item.summary ?? '').slice(0, 280),
        tags,
        sentiment: String(item.sentiment ?? 'neutral'),
        people,
        companies,
      },
    }
  })
}

export async function understandBatch(items: ItemForUnderstanding[]): Promise<UnderstandingResult[]> {
  if (items.length === 0) return []
  const text = await completePrompt(buildUnderstandingPrompt(items), { maxTokens: 4096, timeoutMs: 90_000 })
  return parseUnderstanding(text)
}

export { BATCH_SIZE as UNDERSTANDING_BATCH_SIZE }
