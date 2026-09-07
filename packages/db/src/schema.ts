import { relations } from 'drizzle-orm'
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  handle: text('handle').notNull(),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  rawJson: text('raw_json').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    tweetId: text('tweet_id').notNull(),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id),
    text: text('text').notNull(),
    tweetCreatedAt: integer('tweet_created_at', { mode: 'timestamp' }),
    source: text('source').notNull(),
    rawJson: text('raw_json').notNull(),
    entities: text('entities'),
    understanding: text('understanding'),
    importedAt: integer('imported_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    entitiesAt: integer('entities_at', { mode: 'timestamp' }),
    understandingAt: integer('understanding_at', { mode: 'timestamp' }),
    categorizedAt: integer('categorized_at', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('items_tweet_id_unique').on(table.tweetId),
    index('items_author_id_idx').on(table.authorId),
  ],
)

export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  color: text('color').notNull(),
  description: text('description').notNull(),
})

export const itemCategories = sqliteTable(
  'item_categories',
  {
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    confidence: real('confidence').notNull(),
  },
  (table) => [primaryKey({ columns: [table.itemId, table.categoryId] })],
)

export const imports = sqliteTable('imports', {
  id: text('id').primaryKey(),
  filename: text('filename').notNull(),
  usersImported: integer('users_imported').notNull().default(0),
  itemsImported: integer('items_imported').notNull().default(0),
  usersSkipped: integer('users_skipped').notNull().default(0),
  itemsSkipped: integer('items_skipped').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export const usersRelations = relations(users, ({ many }) => ({
  items: many(items),
}))

export const itemsRelations = relations(items, ({ one, many }) => ({
  author: one(users, { fields: [items.authorId], references: [users.id] }),
  categories: many(itemCategories),
}))

export const categoriesRelations = relations(categories, ({ many }) => ({
  items: many(itemCategories),
}))

export const itemCategoriesRelations = relations(itemCategories, ({ one }) => ({
  item: one(items, { fields: [itemCategories.itemId], references: [items.id] }),
  category: one(categories, { fields: [itemCategories.categoryId], references: [categories.id] }),
}))

export const schema = {
  users,
  items,
  categories,
  itemCategories,
  imports,
}
