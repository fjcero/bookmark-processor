import Anthropic from '@anthropic-ai/sdk'
import {
  claudePrompt,
  getCliAvailability,
  modelNameToCliAlias,
  resolveAnthropicClient,
} from './claude-cli-auth'

export const DEFAULT_MODEL = 'claude-haiku-4-5'

export const PROCESS_MODELS = [
  { id: 'haiku', label: 'Haiku', model: 'claude-haiku-4-5' },
  { id: 'sonnet', label: 'Sonnet', model: 'claude-sonnet-4-5' },
  { id: 'opus', label: 'Opus', model: 'claude-opus-4-6' },
] as const

export type ProcessModelId = (typeof PROCESS_MODELS)[number]['id']

let activeModel = DEFAULT_MODEL

export function setActiveModel(modelId: ProcessModelId | string): string {
  const match = PROCESS_MODELS.find((entry) => entry.id === modelId || entry.model === modelId)
  activeModel = match?.model ?? DEFAULT_MODEL
  return activeModel
}

export function resolveModelName(modelId?: string): string {
  if (!modelId) return activeModel
  return (
    PROCESS_MODELS.find((entry) => entry.id === modelId || entry.model === modelId)?.model ??
    activeModel
  )
}

export async function completePrompt(
  prompt: string,
  options: { maxTokens?: number; timeoutMs?: number; model?: string } = {},
): Promise<string> {
  const { maxTokens = 4096, timeoutMs = 90_000 } = options
  const model = resolveModelName(options.model)

  if (await getCliAvailability()) {
    const result = await claudePrompt(prompt, {
      model: modelNameToCliAlias(model),
      timeoutMs,
    })
    if (result.success && result.data) return result.data
    console.warn('[llm] CLI failed, falling back to SDK:', result.error)
  }

  let client: Anthropic
  try {
    client = resolveAnthropicClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(msg)
  }

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')

  if (!text) throw new Error('No text content in AI response')
  return text
}

export function extractJsonArray(text: string): unknown[] {
  const jsonMatch = text.match(/\[[\s\S]*\]/)
  if (!jsonMatch) throw new Error('No JSON array found in AI response')
  const parsed: unknown = JSON.parse(jsonMatch[0])
  if (!Array.isArray(parsed)) throw new Error('AI response is not an array')
  return parsed
}
