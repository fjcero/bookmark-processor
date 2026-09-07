import { NextRequest, NextResponse } from 'next/server'
import { getProcessState, requestStop, startProcess } from '@/lib/processor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest): Promise<NextResponse> {
  let force = false
  try {
    const body = (await request.json()) as { force?: boolean }
    force = Boolean(body.force)
  } catch {
    force = false
  }

  const current = getProcessState()
  if (current.status === 'running') {
    return NextResponse.json({ ...current, error: 'Processing is already running' }, { status: 409 })
  }

  void startProcess(force)
  return NextResponse.json({ ok: true, status: 'running' })
}

export async function GET(request: NextRequest): Promise<Response> {
  const wantsStream = request.headers.get('accept')?.includes('text/event-stream')
  if (!wantsStream) {
    return NextResponse.json(getProcessState())
  }

  const encoder = new TextEncoder()
  let last = ''
  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        const payload = JSON.stringify(getProcessState())
        if (payload === last) return
        last = payload
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`))
      }
      send()
      const id = setInterval(() => {
        send()
        const state = getProcessState()
        if (state.status === 'idle') {
          send()
          clearInterval(id)
          controller.close()
        }
      }, 400)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}

export async function DELETE(): Promise<NextResponse> {
  requestStop()
  return NextResponse.json({ ok: true })
}
