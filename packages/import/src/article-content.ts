import {
  articleCoverUrl,
  articleResultFromTweet,
  findHydratedArticleResult,
  type GraphQLArticleResult,
} from './article.ts'

export type ArticleContentNode =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; text: string; level: 2 | 3 }
  | { type: 'image'; url: string }
  | { type: 'tweet'; tweetId: string; url: string }

export interface ParsedArticleContent {
  coverUrl: string | null
  nodes: ArticleContentNode[]
}

interface DraftBlock {
  text?: string
  type?: string
  entityRanges?: Array<{ key?: number | string; offset?: number; length?: number }>
  inlineStyleRanges?: Array<{ offset?: number; length?: number; style?: string }>
}

interface DraftEntity {
  type?: string
  data?: {
    tweetId?: string
    mediaItems?: Array<{ mediaId?: string }>
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function entityMapLookup(entityMap: unknown): Map<string, DraftEntity> {
  const map = new Map<string, DraftEntity>()
  if (Array.isArray(entityMap)) {
    for (const entry of entityMap) {
      const record = asRecord(entry)
      const key = record?.key
      const value = record?.value
      if (key == null || !value || typeof value !== 'object') continue
      map.set(String(key), value as DraftEntity)
    }
    return map
  }
  const record = asRecord(entityMap)
  if (!record) return map
  for (const [key, value] of Object.entries(record)) {
    if (value && typeof value === 'object') {
      map.set(key, value as DraftEntity)
    }
  }
  return map
}

function mediaUrlForEntity(
  entity: DraftEntity,
  article: GraphQLArticleResult,
): string | null {
  const mediaId = entity.data?.mediaItems?.[0]?.mediaId
  if (!mediaId) return null
  for (const item of article.media_entities ?? []) {
    if (item.media_id === mediaId) {
      return asString(item.media_info?.original_img_url)
    }
  }
  return null
}

function headingLevel(block: DraftBlock): 2 | 3 | null {
  if (block.type === 'header-two') return 2
  if (block.type === 'header-three') return 3
  return null
}

function nodesFromAtomicBlock(
  block: DraftBlock,
  entities: Map<string, DraftEntity>,
  article: GraphQLArticleResult,
): ArticleContentNode[] {
  const nodes: ArticleContentNode[] = []
  for (const range of block.entityRanges ?? []) {
    const entity = entities.get(String(range.key))
    if (!entity) continue
    if (entity.type === 'MEDIA') {
      const url = mediaUrlForEntity(entity, article)
      if (url) nodes.push({ type: 'image', url })
      continue
    }
    if (entity.type === 'TWEET') {
      const tweetId = asString(entity.data?.tweetId)
      if (!tweetId) continue
      nodes.push({
        type: 'tweet',
        tweetId,
        url: `https://x.com/i/status/${tweetId}`,
      })
    }
  }
  return nodes
}

export function parseArticleContent(
  article: GraphQLArticleResult | null | undefined,
): ParsedArticleContent | null {
  if (!article) return null
  const blocks = article.content_state?.blocks
  if (!Array.isArray(blocks) || blocks.length === 0) return null

  const entities = entityMapLookup(article.content_state?.entityMap)
  const nodes: ArticleContentNode[] = []
  const inlineImageUrls = new Set<string>()

  for (const block of blocks as DraftBlock[]) {
    const level = headingLevel(block)
    if (level) {
      const text = (block.text ?? '').trim()
      if (text) nodes.push({ type: 'heading', text, level })
      continue
    }

    if (block.type === 'atomic') {
      for (const node of nodesFromAtomicBlock(block, entities, article)) {
        nodes.push(node)
        if (node.type === 'image') inlineImageUrls.add(node.url)
      }
      continue
    }

    const text = (block.text ?? '').trim()
    if (text) nodes.push({ type: 'paragraph', text })
  }

  const coverUrl = articleCoverUrl(article)
  return {
    coverUrl:
      coverUrl && !inlineImageUrls.has(coverUrl) ? coverUrl : null,
    nodes,
  }
}

export function parseArticleContentFromRaw(
  rawJson: string,
): ParsedArticleContent | null {
  if (!rawJson) return null
  try {
    const parsed = JSON.parse(rawJson) as unknown
    const article =
      articleResultFromTweet(parsed) ?? findHydratedArticleResult(parsed)
    return parseArticleContent(article)
  } catch {
    return null
  }
}
