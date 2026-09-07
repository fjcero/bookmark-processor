'use client'

import { useCallback, useRef, useState } from 'react'

export interface Stats {
  users: number
  items: number
  entities: { done: number; pending: number }
  understanding: { done: number; pending: number }
  categorized: { done: number; pending: number }
}

interface ImportResult {
  filename: string
  parsed: { users: number; tweets: number }
  users: { imported: number; skipped: number }
  items: { imported: number; skipped: number }
}

interface ProcessState {
  status: 'idle' | 'running' | 'stopping'
  stage: 'entities' | 'understanding' | 'categorize' | null
  done: number
  total: number
  stageCounts: { entities: number; understanding: number; categorized: number }
  lastError: string | null
  error: string | null
}

export interface ClientItem {
  id: string
  tweetId: string
  text: string
  source: string
  tweetCreatedAt: string | null
  entitiesAt: string | null
  understandingAt: string | null
  categorizedAt: string | null
  understanding: string | null
  handle: string
  name: string
  avatarUrl: string | null
  categories: { slug: string; name: string; color: string; confidence: number }[]
}

const STAGE_LABEL: Record<NonNullable<ProcessState['stage']>, string> = {
  entities: 'Extracting entities',
  understanding: 'LLM understanding',
  categorize: 'Categorizing',
}

export default function HomeClient({
  initialStats,
  initialItems,
}: {
  initialStats: Stats
  initialItems: ClientItem[]
}) {
  const [stats, setStats] = useState<Stats>(initialStats)
  const [items, setItems] = useState<ClientItem[]>(initialItems)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [processState, setProcessState] = useState<ProcessState | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    const [statsRes, itemsRes] = await Promise.all([fetch('/api/stats'), fetch('/api/items?limit=40')])
    if (statsRes.ok) setStats(await statsRes.json())
    if (itemsRes.ok) {
      const data = (await itemsRes.json()) as { items: ClientItem[] }
      setItems(data.items)
    }
  }, [])

  async function uploadFile(file: File) {
    setUploading(true)
    setImportError(null)
    setImportResult(null)
    const form = new FormData()
    form.append('file', file)
    try {
      const res = await fetch('/api/import', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) {
        setImportError(data.error ?? 'Import failed')
        return
      }
      setImportResult(data as ImportResult)
      await refresh()
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setUploading(false)
    }
  }

  async function startProcess(force = false) {
    const res = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setProcessState((prev) => ({
        ...(prev ?? {
          status: 'idle',
          stage: null,
          done: 0,
          total: 0,
          stageCounts: { entities: 0, understanding: 0, categorized: 0 },
          lastError: null,
          error: null,
        }),
        error: data.error ?? 'Failed to start',
      }))
      return
    }

    const source = new EventSource('/api/process')
    source.onmessage = (event) => {
      const state = JSON.parse(event.data) as ProcessState
      setProcessState(state)
      if (state.status === 'idle') {
        source.close()
        void refresh()
      }
    }
    source.onerror = () => {
      source.close()
      void refresh()
    }
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-10">
        <p className="font-mono text-xs tracking-[0.2em] text-zinc-500 uppercase">X export v2</p>
        <h1 className="mt-2 text-3xl font-medium tracking-tight">Bookmark Processor</h1>
        <p className="mt-2 max-w-xl text-sm text-zinc-400">
          Upload a bookmarks.json capture, normalize tweets and authors into SQLite, then run entities,
          cheap LLM understanding, and categorization.
        </p>
      </header>

      <section
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const file = e.dataTransfer.files[0]
          if (file) void uploadFile(file)
        }}
        className={`mb-8 rounded-xl border border-dashed px-6 py-10 text-center transition ${
          dragOver ? 'border-violet-400 bg-violet-500/10' : 'border-zinc-700 bg-zinc-900/40'
        }`}
      >
        <p className="text-sm text-zinc-300">Drop export JSON here, or</p>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="mt-3 rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-50"
        >
          {uploading ? 'Importing…' : 'Choose file'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void uploadFile(file)
          }}
        />
        {importResult && (
          <p className="mt-4 font-mono text-xs text-emerald-400">
            {importResult.filename}: {importResult.items.imported} tweets imported,{' '}
            {importResult.items.skipped} skipped · {importResult.users.imported} users imported,{' '}
            {importResult.users.skipped} refreshed
          </p>
        )}
        {importError && <p className="mt-4 text-sm text-red-400">{importError}</p>}
      </section>

      <section className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Items" value={stats.items} />
          <Stat label="Users" value={stats.users} />
          <Stat label="Entities" value={`${stats.entities.done}/${stats.items}`} />
          <Stat label="Understanding" value={`${stats.understanding.done}/${stats.items}`} />
          <Stat label="Categorized" value={`${stats.categorized.done}/${stats.items}`} />
        </section>

      <section className="mb-8 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void startProcess(false)}
          disabled={processState?.status === 'running'}
          className="rounded-md bg-violet-500 px-4 py-2 text-sm font-medium text-white hover:bg-violet-400 disabled:opacity-50"
        >
          {processState?.status === 'running' ? 'Processing…' : 'Process pending'}
        </button>
        <button
          type="button"
          onClick={() => void startProcess(true)}
          disabled={processState?.status === 'running'}
          className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
        >
          Re-run all
        </button>
        {processState?.status === 'running' && processState.stage && (
          <p className="font-mono text-xs text-zinc-400">
            {STAGE_LABEL[processState.stage]} · {processState.done}/{processState.total}
          </p>
        )}
        {processState?.error && <p className="text-sm text-red-400">{processState.error}</p>}
        {processState?.lastError && !processState.error && (
          <p className="text-sm text-amber-400">{processState.lastError}</p>
        )}
      </section>

      <section className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-900/80 font-mono text-[11px] tracking-wide text-zinc-500 uppercase">
            <tr>
              <th className="px-4 py-3 font-medium">Author</th>
              <th className="px-4 py-3 font-medium">Text</th>
              <th className="px-4 py-3 font-medium">Stages</th>
              <th className="px-4 py-3 font-medium">Categories</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-zinc-500">
                  No items yet. Upload an export to get started.
                </td>
              </tr>
            )}
            {items.map((item) => (
              <tr key={item.id} className="border-t border-zinc-800 align-top">
                <td className="px-4 py-3 whitespace-nowrap">
                  <div className="font-medium">{item.name}</div>
                  <div className="font-mono text-xs text-zinc-500">@{item.handle}</div>
                </td>
                <td className="px-4 py-3 text-zinc-300">
                  <p className="line-clamp-3 max-w-xl">{item.text || '(empty)'}</p>
                </td>
                <td className="px-4 py-3 font-mono text-xs">
                  <StageDot done={Boolean(item.entitiesAt)} label="E" />
                  <StageDot done={Boolean(item.understandingAt)} label="U" />
                  <StageDot done={Boolean(item.categorizedAt)} label="C" />
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {item.categories.map((c) => (
                      <span
                        key={c.slug}
                        className="rounded-full px-2 py-0.5 text-[11px]"
                        style={{ background: `${c.color}22`, color: c.color }}
                      >
                        {c.name}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
      <div className="font-mono text-[11px] tracking-wide text-zinc-500 uppercase">{label}</div>
      <div className="mt-1 text-xl font-medium">{value}</div>
    </div>
  )
}

function StageDot({ done, label }: { done: boolean; label: string }) {
  return (
    <span className={`mr-2 ${done ? 'text-emerald-400' : 'text-zinc-600'}`}>
      {label}
      {done ? '✓' : '·'}
    </span>
  )
}
