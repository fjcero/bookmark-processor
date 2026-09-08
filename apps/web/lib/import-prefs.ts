export interface ImportPrefs {
  entities: boolean
  understanding: boolean
  categorize: boolean
}

export const DEFAULT_IMPORT_PREFS: ImportPrefs = {
  entities: true,
  understanding: false,
  categorize: false,
}

export type ViewMode = 'list' | 'grid'
export type ItemSort = 'published' | 'imported' | 'saved'

export const DEFAULT_ITEM_SORT: ItemSort = 'published'
