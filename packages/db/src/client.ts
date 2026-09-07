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

export const db = drizzle(sqlite, { schema })
export { sqlite }
