import { NextRequest, NextResponse } from 'next/server'
import { inArray, sql } from 'drizzle-orm'
import { parseExportV2 } from '@repo/import'
import { db, imports, items, users } from '@repo/db'
import { createId } from '@/lib/ids'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData()
  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file' }, { status: 400 })
  }

  const text = await file.text()
  let parsed
  try {
    parsed = parseExportV2(text)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to parse export'
    return NextResponse.json({ error: msg }, { status: 400 })
  }

  const now = new Date()
  const userIds = parsed.users.map((u) => u.id)
  const existingUsers =
    userIds.length > 0
      ? await db.select({ id: users.id }).from(users).where(inArray(users.id, userIds))
      : []
  const existingUserIds = new Set(existingUsers.map((u) => u.id))

  if (parsed.users.length > 0) {
    const CHUNK = 200
    for (let i = 0; i < parsed.users.length; i += CHUNK) {
      const slice = parsed.users.slice(i, i + CHUNK)
      await db
        .insert(users)
        .values(
          slice.map((u) => ({
            id: u.id,
            handle: u.handle,
            name: u.name,
            avatarUrl: u.avatarUrl,
            rawJson: u.rawJson,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: users.id,
          set: {
            handle: sql`excluded.handle`,
            name: sql`excluded.name`,
            avatarUrl: sql`excluded.avatar_url`,
            rawJson: sql`excluded.raw_json`,
            updatedAt: now,
          },
        })
    }
  }

  const tweetIds = parsed.tweets.map((t) => t.id)
  const existingItems =
    tweetIds.length > 0
      ? await db.select({ tweetId: items.tweetId }).from(items).where(inArray(items.tweetId, tweetIds))
      : []
  const existingTweetIds = new Set(existingItems.map((i) => i.tweetId))

  const newTweets = parsed.tweets.filter((t) => !existingTweetIds.has(t.id))
  if (newTweets.length > 0) {
    const CHUNK = 200
    for (let i = 0; i < newTweets.length; i += CHUNK) {
      const slice = newTweets.slice(i, i + CHUNK)
      await db
        .insert(items)
        .values(
          slice.map((t) => ({
            id: createId(),
            tweetId: t.id,
            authorId: t.authorId,
            text: t.text,
            tweetCreatedAt: t.createdAt,
            source: t.source,
            rawJson: t.rawJson,
            importedAt: now,
          })),
        )
        .onConflictDoNothing({ target: items.tweetId })
    }
  }

  const usersImported = parsed.users.filter((u) => !existingUserIds.has(u.id)).length
  const usersSkipped = parsed.users.length - usersImported
  const itemsImported = newTweets.length
  const itemsSkipped = parsed.tweets.length - itemsImported

  await db.insert(imports).values({
    id: createId(),
    filename: file.name,
    usersImported,
    itemsImported,
    usersSkipped,
    itemsSkipped,
  })

  return NextResponse.json({
    filename: file.name,
    parsed: { users: parsed.users.length, tweets: parsed.tweets.length },
    users: { imported: usersImported, skipped: usersSkipped },
    items: { imported: itemsImported, skipped: itemsSkipped },
  })
}
