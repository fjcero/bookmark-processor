import { NextRequest, NextResponse } from 'next/server'
import { getItems } from '@/lib/queries'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0), 0)
  const uncategorized = url.searchParams.get('uncategorized') === 'true'
  const rows = await getItems(limit, offset, uncategorized)
  return NextResponse.json({ items: rows })
}
