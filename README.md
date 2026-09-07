# Bookmark Processor

Turborepo app that imports X bookmark export v2 JSON, stores normalized tweets + authors in SQLite, and runs a 3-stage processing pipeline (entities, LLM understanding, categorization).

## Setup

```bash
pnpm install
# pnpm 10 ignores native install scripts by default — allow sqlite bindings:
pnpm approve-builds
cp .env.example apps/web/.env.local
pnpm db:push
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). Upload a `bookmarks.json` from `@repo/import` capture, then click Process.

## Packages

| Package | Role |
|---------|------|
| [`packages/import`](packages/import) | Bookmarklet v2 capture scripts + `parseExportV2()` |
| [`packages/db`](packages/db) | Drizzle schema + SQLite client |
| [`apps/web`](apps/web) | Next.js UI, import API, processing pipeline |
