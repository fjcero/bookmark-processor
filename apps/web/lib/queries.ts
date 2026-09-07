import { count, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { categories, db, itemCategories, items, users } from '@repo/db'

export interface Stats {
  users: number
  items: number
  entities: { done: number; pending: number }
  understanding: { done: number; pending: number }
  categorized: { done: number; pending: number }
}

export interface ItemRow {
  id: string
  tweetId: string
  text: string
  source: string
  tweetCreatedAt: Date | null
  importedAt: Date
  entitiesAt: Date | null
  understandingAt: Date | null
  categorizedAt: Date | null
  understanding: string | null
  handle: string
  name: string
  avatarUrl: string | null
  categories: { slug: string; name: string; color: string; confidence: number }[]
}

export async function getStats(): Promise<Stats> {
  const [total] = await db.select({ n: count() }).from(items)
  const [userCount] = await db.select({ n: count() }).from(users)
  const [entitiesDone] = await db.select({ n: count() }).from(items).where(isNotNull(items.entitiesAt))
  const [understandingDone] = await db
    .select({ n: count() })
    .from(items)
    .where(isNotNull(items.understandingAt))
  const [categorizedDone] = await db.select({ n: count() }).from(items).where(isNotNull(items.categorizedAt))
  const [pending] = await db.select({ n: count() }).from(items).where(isNull(items.categorizedAt))

  return {
    users: userCount.n,
    items: total.n,
    entities: { done: entitiesDone.n, pending: total.n - entitiesDone.n },
    understanding: { done: understandingDone.n, pending: total.n - understandingDone.n },
    categorized: { done: categorizedDone.n, pending: pending.n },
  }
}

export async function getItems(limit = 40, offset = 0, uncategorized = false): Promise<ItemRow[]> {
  const query = db
    .select({
      id: items.id,
      tweetId: items.tweetId,
      text: items.text,
      source: items.source,
      tweetCreatedAt: items.tweetCreatedAt,
      importedAt: items.importedAt,
      entitiesAt: items.entitiesAt,
      understandingAt: items.understandingAt,
      categorizedAt: items.categorizedAt,
      understanding: items.understanding,
      handle: users.handle,
      name: users.name,
      avatarUrl: users.avatarUrl,
    })
    .from(items)
    .innerJoin(users, eq(items.authorId, users.id))

  const rows = await (uncategorized ? query.where(isNull(items.categorizedAt)) : query)
    .orderBy(desc(items.importedAt))
    .limit(limit)
    .offset(offset)

  const itemIds = rows.map((r) => r.id)
  const catRows =
    itemIds.length === 0
      ? []
      : await db
          .select({
            itemId: itemCategories.itemId,
            slug: categories.slug,
            name: categories.name,
            color: categories.color,
            confidence: itemCategories.confidence,
          })
          .from(itemCategories)
          .innerJoin(categories, eq(itemCategories.categoryId, categories.id))
          .where(inArray(itemCategories.itemId, itemIds))

  const catsByItem = new Map<string, ItemRow['categories']>()
  for (const row of catRows) {
    const list = catsByItem.get(row.itemId) ?? []
    list.push({ slug: row.slug, name: row.name, color: row.color, confidence: row.confidence })
    catsByItem.set(row.itemId, list)
  }

  return rows.map((r) => ({
    ...r,
    categories: catsByItem.get(r.id) ?? [],
  }))
}
