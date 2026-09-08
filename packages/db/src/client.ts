import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

function resolveDbPath(): string {
  const raw = process.env.DATABASE_URL ?? 'file:./data/processor.db'
  const file = raw.replace(/^file:/, '')
  if (path.isAbsolute(file)) return file
  return path.resolve(process.cwd(), file)
}

const dbPath = resolveDbPath()
fs.mkdirSync(path.dirname(dbPath), { recursive: true })

const sqlite = new Database(dbPath)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')
migrateItems(sqlite)

function migrateItems(database: InstanceType<typeof Database>): void {
  const table = database
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'`)
    .get() as { name?: string } | undefined
  if (!table) return
  const cols = database
    .prepare(`PRAGMA table_info(items)`)
    .all() as Array<{ name: string }>
  const names = new Set(cols.map((col) => col.name))
  if (!names.has('sort_index')) {
    database.exec(`ALTER TABLE items ADD COLUMN sort_index TEXT`)
  }
  if (!names.has('hydrate_requested_at')) {
    database.exec(`ALTER TABLE items ADD COLUMN hydrate_requested_at INTEGER`)
  }
  if (!names.has('capture_unavailable_at')) {
    database.exec(`ALTER TABLE items ADD COLUMN capture_unavailable_at INTEGER`)
  }
  database.exec(`CREATE INDEX IF NOT EXISTS items_sort_index_idx ON items(sort_index)`)
  database.exec(
    `CREATE INDEX IF NOT EXISTS items_hydrate_requested_at_idx ON items(hydrate_requested_at)`,
  )
  database.exec(
    `CREATE INDEX IF NOT EXISTS items_capture_unavailable_at_idx ON items(capture_unavailable_at)`,
  )
  database.exec(`
    UPDATE items
    SET sort_index = json_extract(raw_json, '$._sortIndex')
    WHERE sort_index IS NULL
      AND json_extract(raw_json, '$._sortIndex') IS NOT NULL
  `)
  database.exec(`
    UPDATE items
    SET content_type = 'article'
    WHERE content_type = 'post'
      AND json_extract(raw_json, '$.article.article_results.result.rest_id') IS NOT NULL
  `)
  database.exec(`
    UPDATE items
    SET url = 'https://x.com/i/article/' || json_extract(raw_json, '$.article.article_results.result.rest_id')
    WHERE content_type = 'article'
      AND json_extract(raw_json, '$.article.article_results.result.rest_id') IS NOT NULL
      AND (url IS NULL OR url NOT LIKE '%/i/article/%')
  `)
  database.exec(`
    UPDATE items
    SET text = trim(
      json_extract(raw_json, '$.article.article_results.result.title')
      || char(10) || char(10)
      || coalesce(json_extract(raw_json, '$.article.article_results.result.preview_text'), '')
    )
    WHERE content_type = 'article'
      AND json_extract(raw_json, '$.article.article_results.result.content_state.blocks[0].text') IS NULL
      AND json_extract(raw_json, '$.article.article_results.result.title') IS NOT NULL
      AND text = json_extract(raw_json, '$.article.article_results.result.title')
      AND json_extract(raw_json, '$.article.article_results.result.preview_text') IS NOT NULL
  `)
  migrateImportQueue(database)
}

function migrateImportQueue(database: InstanceType<typeof Database>): void {
  const table = database
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'import_queue'`)
    .get() as { name?: string } | undefined
  if (!table) {
    database.exec(`
      CREATE TABLE import_queue (
        id TEXT PRIMARY KEY NOT NULL,
        source TEXT NOT NULL DEFAULT 'x',
        kind TEXT NOT NULL DEFAULT 'bookmark',
        external_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        origin TEXT NOT NULL,
        payload_json TEXT,
        last_error TEXT,
        item_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX import_queue_source_external_unique ON import_queue(source, external_id);
      CREATE INDEX import_queue_status_idx ON import_queue(status);
      CREATE INDEX import_queue_created_at_idx ON import_queue(created_at);
    `)
  }
}

export const db = drizzle(sqlite, { schema })
export { sqlite }
