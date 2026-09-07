import { defineConfig } from 'drizzle-kit'

const raw = process.env.DATABASE_URL ?? 'file:../../data/processor.db'
const url = raw.replace(/^file:/, '')

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url },
})
