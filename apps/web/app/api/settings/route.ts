import { NextRequest, NextResponse } from 'next/server'
import { getAppSettings, getImportPrefs, setImportPrefs, setItemSort, setViewMode, type ImportPrefs, type ItemSort, type ViewMode } from '@/lib/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(await getAppSettings())
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  let body: { import?: Partial<ImportPrefs>; view?: ViewMode; sort?: ItemSort } = {}
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (body.import) {
    const current = await getImportPrefs()
    await setImportPrefs({
      entities: typeof body.import.entities === 'boolean' ? body.import.entities : current.entities,
      understanding:
        typeof body.import.understanding === 'boolean' ? body.import.understanding : current.understanding,
      categorize: typeof body.import.categorize === 'boolean' ? body.import.categorize : current.categorize,
    })
  }
  if (body.view === 'list' || body.view === 'grid') {
    await setViewMode(body.view)
  }
  if (body.sort === 'published' || body.sort === 'imported' || body.sort === 'saved') {
    await setItemSort(body.sort)
  }

  return NextResponse.json(await getAppSettings())
}
