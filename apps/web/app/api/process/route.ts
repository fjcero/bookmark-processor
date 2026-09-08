import { NextRequest, NextResponse } from 'next/server'
import { requestArticleRefetch } from '@/lib/queries'
import { getProcessState, requestStop, startProcess } from '@/lib/processor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STAGES = ['entities', 'understanding', 'categorize'] as const
const MODELS = ['haiku', 'sonnet', 'opus'] as const

export async function POST(request: NextRequest): Promise<NextResponse> {
  let force = false
  let refetch = false
  let stagesProvided = false
  let stages: Array<(typeof STAGES)[number]> | undefined
  let itemIds: string[] | undefined
  let model: (typeof MODELS)[number] | undefined
  try {
    const body = (await request.json()) as {
      force?: boolean
      refetch?: boolean
      stages?: string[]
      itemIds?: string[]
      model?: string
    }
    force = Boolean(body.force)
    refetch = Boolean(body.refetch)
    if (Array.isArray(body.stages)) {
      stagesProvided = true
      stages = body.stages.filter((s): s is (typeof STAGES)[number] =>
        (STAGES as readonly string[]).includes(s),
      )
    }
    if (Array.isArray(body.itemIds)) {
      itemIds = body.itemIds.filter((id) => typeof id === 'string' && id.length > 0)
    }
    if (body.model && (MODELS as readonly string[]).includes(body.model)) {
      model = body.model as (typeof MODELS)[number]
    }
  } catch {
    force = false
    refetch = false
  }

  let refetchQueued = 0
  if (refetch) {
    const result = await requestArticleRefetch({
      itemIds: itemIds && itemIds.length > 0 ? itemIds : undefined,
      all: !(itemIds && itemIds.length > 0) && force,
    })
    refetchQueued = result.queued
  }

  const refetchOnly = refetch && stagesProvided && (stages?.length ?? 0) === 0
  if (refetchOnly) {
    return NextResponse.json({ ok: true, refetchQueued })
  }

  const current = getProcessState()
  if (current.status === 'running') {
    return NextResponse.json(
      { ...current, error: 'Processing is already running', refetchQueued },
      { status: 409 },
    )
  }

  void startProcess({ force, stages, itemIds, model })
  return NextResponse.json({ ok: true, status: 'running', refetchQueued })
}

export async function GET(request: NextRequest): Promise<Response> {
  const wantsStream = request.headers.get('accept')?.includes('text/event-stream')
  if (!wantsStream) {
    return NextResponse.json(getProcessState())
  }

  const encoder = new TextEncoder()
  let last = ''
  let intervalId: ReturnType<typeof setInterval> | undefined
  let closed = false

  const stream = new ReadableStream({
    start(controller) {
      const close = () => {
        if (closed) return
        closed = true
        if (intervalId) clearInterval(intervalId)
        try {
          controller.close()
        } catch {
          /* client may have already disconnected */
        }
      }

      const send = () => {
        if (closed) return
        try {
          const payload = JSON.stringify(getProcessState())
          if (payload === last) return
          last = payload
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`))
        } catch {
          close()
        }
      }

      send()
      intervalId = setInterval(() => {
        send()
        if (getProcessState().status === 'idle') {
          send()
          close()
        }
      }, 400)
    },
    cancel() {
      closed = true
      if (intervalId) clearInterval(intervalId)
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
