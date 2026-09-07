export type ExportSource = 'bookmark' | 'like'

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
  meta: { exportVersion: 2; source: ExportSource; exportedAt: string }
  users: NormalizedUser[]
  tweets: NormalizedTweet[]
  responses: unknown[]
}

export interface NormalizedUser {
  id: string
  handle: string
  name: string
  avatarUrl: string | null
  rawJson: string
}

export interface NormalizedTweet {
  id: string
  authorId: string
  text: string
  createdAt: Date | null
  source: ExportSource
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
      result?: { title?: string; content?: string }
    }
  }
}
