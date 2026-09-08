import type { ExportSource } from './types.ts'

/** Page-derived capture kind: bookmarks, likes, or your own replies/quotes. */
export function captureSourceFromPath(pathname: string): ExportSource {
  const path = pathname.toLowerCase()
  if (path.includes('/likes')) return 'like'
  if (path.includes('/with_replies')) return 'own'
  return 'bookmark'
}

export function captureLabel(source: ExportSource): string {
  if (source === 'like') return 'likes'
  if (source === 'own') return 'own replies'
  return 'bookmarks'
}

const KIND_RANK: Record<ExportSource, number> = {
  own: 0,
  like: 1,
  bookmark: 2,
}

/** Higher rank wins when the same tweet is seen on multiple capture pages. */
export function shouldPromoteKind(
  existing: ExportSource,
  incoming: ExportSource,
): boolean {
  return KIND_RANK[incoming] > KIND_RANK[existing]
}

export function resolveItemKind(incoming: unknown): ExportSource {
  if (incoming === 'like') return 'like'
  if (incoming === 'own') return 'own'
  // Legacy exports tagged browsing history as bookmark captures.
  if (incoming === 'history') return 'bookmark'
  return 'bookmark'
}
