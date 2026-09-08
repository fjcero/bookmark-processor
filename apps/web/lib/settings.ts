import { eq } from 'drizzle-orm'
import { db, settings } from '@repo/db'
import { DEFAULT_IMPORT_PREFS, DEFAULT_ITEM_SORT, type ImportPrefs, type ItemSort, type ViewMode } from './import-prefs'

export type { ImportPrefs, ItemSort, ViewMode } from './import-prefs'
export { DEFAULT_IMPORT_PREFS, DEFAULT_ITEM_SORT } from './import-prefs'

export interface AppSettings {
  import: ImportPrefs
  view: ViewMode
  sort: ItemSort
}

const IMPORT_KEY = 'importPrefs'
const VIEW_KEY = 'viewMode'
const SORT_KEY = 'itemSort'

function parsePrefs(raw: string | undefined): ImportPrefs {
  if (!raw) return { ...DEFAULT_IMPORT_PREFS }
  try {
    const parsed = JSON.parse(raw) as Partial<ImportPrefs>
    return {
      entities: parsed.entities ?? DEFAULT_IMPORT_PREFS.entities,
      understanding: parsed.understanding ?? DEFAULT_IMPORT_PREFS.understanding,
      categorize: parsed.categorize ?? DEFAULT_IMPORT_PREFS.categorize,
    }
  } catch {
    return { ...DEFAULT_IMPORT_PREFS }
  }
}

function parseView(raw: string | undefined): ViewMode {
  if (raw === 'list') return 'list'
  if (raw === 'grid') return 'grid'
  return 'grid'
}

function parseSort(raw: string | undefined): ItemSort {
  if (raw === 'imported' || raw === 'saved' || raw === 'published') return raw
  return DEFAULT_ITEM_SORT
}

async function getSetting(key: string): Promise<string | undefined> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1)
  return row?.value
}

async function putSetting(key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value },
    })
}

export async function getImportPrefs(): Promise<ImportPrefs> {
  return parsePrefs(await getSetting(IMPORT_KEY))
}

export async function setImportPrefs(prefs: ImportPrefs): Promise<ImportPrefs> {
  await putSetting(IMPORT_KEY, JSON.stringify(prefs))
  return prefs
}

export async function getViewMode(): Promise<ViewMode> {
  return parseView(await getSetting(VIEW_KEY))
}

export async function setViewMode(view: ViewMode): Promise<ViewMode> {
  await putSetting(VIEW_KEY, view)
  return view
}

export async function getItemSort(): Promise<ItemSort> {
  return parseSort(await getSetting(SORT_KEY))
}

export async function setItemSort(sort: ItemSort): Promise<ItemSort> {
  await putSetting(SORT_KEY, sort)
  return sort
}

export async function getAppSettings(): Promise<AppSettings> {
  const [importPrefs, view, sort] = await Promise.all([
    getImportPrefs(),
    getViewMode(),
    getItemSort(),
  ])
  return { import: importPrefs, view, sort }
}

export function selectedStages(prefs: ImportPrefs): Array<'entities' | 'understanding' | 'categorize'> {
  const stages: Array<'entities' | 'understanding' | 'categorize'> = []
  if (prefs.entities) stages.push('entities')
  if (prefs.understanding) stages.push('understanding')
  if (prefs.categorize) stages.push('categorize')
  return stages
}
