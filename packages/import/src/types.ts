export type ItemKind = 'bookmark' | 'like' | 'history'
export type ExportSource = ItemKind

export const X_SOURCE = 'x'

export interface ExportV2 {
  exportVersion: 2
  exportedAt?: string
  source?: string
  origin?: string
  page?: { url?: string; pathname?: string }
  stats?: { tweetCount?: number; responseCount?: number }
  tweets?: Record<string, unknown>
  responses?: unknown[]
}

export interface ParsedExport {
  meta: { exportVersion: 2; kind: ItemKind; exportedAt: string }
  users: NormalizedUser[]
  items: NormalizedItem[]
  responses: unknown[]
}

export interface NormalizedUser {
  id: string
  handle: string
  name: string
  avatarUrl: string | null
}

export type ContentType = 'post' | 'article'
export type PostFormat = 'original' | 'reply' | 'quote' | 'repost' | 'thread'

export interface NormalizedItem {
  id: string
  authorId: string
  text: string
  createdAt: Date | null
  source: string
  kind: ItemKind
  contentType: ContentType
  url: string | null
  sortIndex: string | null
  rawJson: string
}

export interface GraphQLUser {
  __typename?: string
  rest_id?: string
  core?: {
    screen_name?: string
    name?: string
    created_at?: string
  }
  legacy?: {
    screen_name?: string
    name?: string
    profile_image_url_https?: string
  }
  avatar?: { image_url?: string }
}

export interface GraphQLTweet {
  __typename?: string
  rest_id?: string
  tweet?: GraphQLTweet
  legacy?: {
    full_text?: string
    created_at?: string
    user_id_str?: string
    in_reply_to_status_id_str?: string
    quoted_status_id_str?: string
    self_thread?: unknown
    entities?: unknown
    extended_entities?: unknown
  }
  core?: {
    user_results?: {
      result?: GraphQLUser
    }
  }
  note_tweet?: { note_tweet_results?: { result?: { text?: string } } }
  article?: {
    article_results?: {
      result?: GraphQLArticleResult
    }
  }
}

export interface GraphQLArticleResult {
  id?: string
  rest_id?: string
  title?: string
  preview_text?: string
  summary_text?: string
  content?: string
  plain_text?: string
  plaintext?: string
  content_state?: {
    blocks?: Array<{ text?: string; type?: string }>
    entityMap?: unknown
  }
  cover_media?: { media_info?: { original_img_url?: string } }
  media_entities?: Array<{ media_info?: { original_img_url?: string } }>
  metadata?: { first_published_at_secs?: number }
  extracted_html?: string
  hydration_source?: "graphql" | "html"
}
