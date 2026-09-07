import { and, count, eq, gt, isNull } from 'drizzle-orm'
import { db, itemCategories, items } from '@repo/db'
import { extractEntities, type ExtractedEntities } from './entities'
import { categorizeBatch, CATEGORIZE_BATCH_SIZE, mapItemForCategorization, seedDefaultCategories, writeCategoryResults } from './categorizer'
import {
  EMPTY_UNDERSTANDING,
  UNDERSTANDING_BATCH_SIZE,
  understandBatch,
  type ItemForUnderstanding,
} from './understanding'

export type Stage = 'entities' | 'understanding' | 'categorize'

export interface ProcessState {
  status: 'idle' | 'running' | 'stopping'
  stage: Stage | null
  done: number
  total: number
  stageCounts: {
    entities: number
    understanding: number
    categorized: number
  }
  lastError: string | null
  error: string | null
}

const globalState = globalThis as unknown as {
  processState: ProcessState
  processAbort: boolean
  processRunning: boolean
}

if (!globalState.processState) {
  globalState.processState = {
    status: 'idle',
    stage: null,
    done: 0,
    total: 0,
    stageCounts: { entities: 0, understanding: 0, categorized: 0 },
    lastError: null,
    error: null,
  }
}
if (globalState.processAbort === undefined) globalState.processAbort = false
if (globalState.processRunning === undefined) globalState.processRunning = false

export function getProcessState(): ProcessState {
  return { ...globalState.processState }
}

function setState(update: Partial<ProcessState>): void {
  globalState.processState = { ...globalState.processState, ...update }
}

function shouldAbort(): boolean {
  return globalState.processAbort
}

export function requestStop(): void {
  globalState.processAbort = true
  setState({ status: 'stopping' })
}

async function runEntities(onProgress: (done: number) => void): Promise<number> {
  const CHUNK = 100
  let processed = 0
  let cursor: string | undefined

  while (true) {
    if (shouldAbort()) break
    const rows = await db
      .select({ id: items.id, rawJson: items.rawJson })
      .from(items)
      .where(cursor ? and(isNull(items.entitiesAt), gt(items.id, cursor)) : isNull(items.entitiesAt))
      .orderBy(items.id)
      .limit(CHUNK)

    if (rows.length === 0) break
    cursor = rows[rows.length - 1].id

    for (const row of rows) {
      const entities = extractEntities(row.rawJson)
      await db
        .update(items)
        .set({ entities: JSON.stringify(entities), entitiesAt: new Date() })
        .where(eq(items.id, row.id))
      processed++
      onProgress(processed)
    }

    if (rows.length < CHUNK) break
  }

  return processed
}

async function runUnderstanding(onProgress: (done: number) => void): Promise<number> {
  let processed = 0
  let cursor: string | undefined

  while (true) {
    if (shouldAbort()) break
    const rows = await db
      .select({
        id: items.id,
        tweetId: items.tweetId,
        text: items.text,
        entities: items.entities,
      })
      .from(items)
      .where(
        cursor
          ? and(isNull(items.understandingAt), gt(items.id, cursor))
          : isNull(items.understandingAt),
      )
      .orderBy(items.id)
      .limit(UNDERSTANDING_BATCH_SIZE)

    if (rows.length === 0) break
    cursor = rows[rows.length - 1].id

    const trivial = rows.filter((r) => r.text.trim().length < 20)
    const toEnrich = rows.filter((r) => r.text.trim().length >= 20)

    for (const row of trivial) {
      await db
        .update(items)
        .set({ understanding: JSON.stringify(EMPTY_UNDERSTANDING), understandingAt: new Date() })
        .where(eq(items.id, row.id))
      processed++
    }

    if (toEnrich.length > 0) {
      const batch: ItemForUnderstanding[] = toEnrich.map((row) => {
        let entities: ExtractedEntities | null = null
        if (row.entities) {
          try {
            entities = JSON.parse(row.entities) as ExtractedEntities
          } catch {
            entities = null
          }
        }
        return { tweetId: row.tweetId, text: row.text, entities }
      })

      try {
        const results = await understandBatch(batch)
        const byTweetId = new Map(results.map((r) => [r.tweetId, r.understanding]))
        for (const row of toEnrich) {
          const understanding = byTweetId.get(row.tweetId) ?? EMPTY_UNDERSTANDING
          await db
            .update(items)
            .set({ understanding: JSON.stringify(understanding), understandingAt: new Date() })
            .where(eq(items.id, row.id))
          processed++
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[understanding] batch failed:', msg)
        setState({ lastError: msg })
      }
    }

    onProgress(processed)
    if (rows.length < UNDERSTANDING_BATCH_SIZE) break
  }

  return processed
}

async function runCategorize(onProgress: (done: number) => void): Promise<number> {
  await seedDefaultCategories()
  let processed = 0
  let cursor: string | undefined

  while (true) {
    if (shouldAbort()) break
    const rows = await db
      .select({
        id: items.id,
        tweetId: items.tweetId,
        text: items.text,
        entities: items.entities,
        understanding: items.understanding,
      })
      .from(items)
      .where(
        cursor
          ? and(isNull(items.categorizedAt), gt(items.id, cursor))
          : isNull(items.categorizedAt),
      )
      .orderBy(items.id)
      .limit(CATEGORIZE_BATCH_SIZE)

    if (rows.length === 0) break
    cursor = rows[rows.length - 1].id

    try {
      const batch = rows.map(mapItemForCategorization)
      const results = await categorizeBatch(batch)
      await writeCategoryResults(results)
      const categorizedIds = new Set(results.filter((r) => r.assignments.length > 0).map((r) => r.tweetId))
      for (const row of rows) {
        if (!categorizedIds.has(row.tweetId)) {
          await db.update(items).set({ categorizedAt: new Date() }).where(eq(items.id, row.id))
        }
      }
      processed += rows.length
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[categorize] batch failed:', msg)
      setState({ lastError: msg })
    }

    onProgress(processed)
    if (rows.length < CATEGORIZE_BATCH_SIZE) break
  }

  return processed
}

export async function startProcess(force = false): Promise<void> {
  if (globalState.processRunning) {
    throw new Error('Processing is already running')
  }

  globalState.processRunning = true
  globalState.processAbort = false
  setState({
    status: 'running',
    stage: null,
    done: 0,
    total: 0,
    stageCounts: { entities: 0, understanding: 0, categorized: 0 },
    lastError: null,
    error: null,
  })

  try {
    if (force) {
      await db.update(items).set({
        entitiesAt: null,
        understandingAt: null,
        categorizedAt: null,
      })
      await db.delete(itemCategories)
    }

    const [entitiesPending] = await db.select({ n: count() }).from(items).where(isNull(items.entitiesAt))
    const [understandingPending] = await db
      .select({ n: count() })
      .from(items)
      .where(isNull(items.understandingAt))
    const [categorizePending] = await db.select({ n: count() }).from(items).where(isNull(items.categorizedAt))

    const total = entitiesPending.n + understandingPending.n + categorizePending.n
    setState({ total })

    let done = 0

    setState({ stage: 'entities', done })
    const entitiesCount = await runEntities((n) => {
      setState({
        done: done + n,
        stageCounts: { ...globalState.processState.stageCounts, entities: n },
      })
    })
    done += entitiesCount
    setState({ done, stageCounts: { ...globalState.processState.stageCounts, entities: entitiesCount } })

    if (!shouldAbort()) {
      setState({ stage: 'understanding' })
      const understandingCount = await runUnderstanding((n) => {
        setState({
          done: done + n,
          stageCounts: { ...globalState.processState.stageCounts, understanding: n },
        })
      })
      done += understandingCount
      setState({
        done,
        stageCounts: { ...globalState.processState.stageCounts, understanding: understandingCount },
      })
    }

    if (!shouldAbort()) {
      setState({ stage: 'categorize' })
      const categorizedCount = await runCategorize((n) => {
        setState({
          done: done + n,
          stageCounts: { ...globalState.processState.stageCounts, categorized: n },
        })
      })
      done += categorizedCount
      setState({
        done,
        stageCounts: { ...globalState.processState.stageCounts, categorized: categorizedCount },
      })
    }

    setState({ status: 'idle', stage: null, done: total })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    setState({ status: 'idle', error: msg, lastError: msg })
  } finally {
    globalState.processRunning = false
    globalState.processAbort = false
  }
}
