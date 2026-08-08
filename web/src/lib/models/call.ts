/**
 * One transport, two wire protocols.
 *
 * The chat route thinks in Anthropic's block vocabulary — `text`, `tool_use`, `tool_result` —
 * because that is what it was written against. Rather than rewrite the route and its tests,
 * this file makes that vocabulary the *internal* one and translates at the edge. Anthropic is
 * close to a pass-through; OpenAI-compatible providers are a real translation, and everything
 * else worth having (OpenRouter, Groq, DeepSeek, xAI, Mistral, Gemini's compat endpoint) is
 * OpenAI-compatible, so two adapters cover the field.
 *
 * The translation is not cosmetic. Anthropic carries tool results as a `tool_result` block in
 * a **user** turn; OpenAI carries them as their own `role: "tool"` message keyed by
 * `tool_call_id`. Get that wrong and the model silently loses the result of every tool it
 * called, which reads as the assistant ignoring what it just looked up.
 */

import type { ResolvedModel } from './resolve'

/* ------------------------------------------------------------------ the internal vocabulary */

export type TextBlock = { type: 'text'; text: string }
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }
export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type AssistantContentBlock = TextBlock | ToolUseBlock
export type WireContentBlock = TextBlock | ToolUseBlock | ToolResultBlock
export type WireMessage = { role: 'user' | 'assistant'; content: string | WireContentBlock[] }

export type ToolDefinition = { name: string; description: string; input_schema: object }

export type TransportRequest = {
  system: string
  messages: WireMessage[]
  tools: readonly ToolDefinition[]
  maxTokens: number
}

export type TransportReply = { content: AssistantContentBlock[]; stopReason?: string }

export type Transport = (req: TransportRequest) => Promise<TransportReply>

/** Injected so no test touches the network. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export class LlmCallError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'LlmCallError'
    this.status = status
  }
}

/* ------------------------------------------------------------------ shared helpers */

const asBlocks = (content: string | WireContentBlock[]): WireContentBlock[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : content

/**
 * Upstream errors are summarised, never echoed.
 *
 * Provider error bodies routinely quote the request — including headers — so passing one
 * through would put the user's own key in a response or a log. The status is the actionable
 * part anyway: 401 means the key is wrong, 429 means wait.
 */
function fail(provider: string, status: number): never {
  throw new LlmCallError(`${provider} returned HTTP ${status}`, status)
}

async function parseJson(res: { text(): Promise<string> }, provider: string): Promise<unknown> {
  const raw = await res.text()
  try {
    return JSON.parse(raw)
  } catch {
    throw new LlmCallError(`${provider} returned a body that is not JSON`, null)
  }
}

/* ------------------------------------------------------------------ anthropic */

function anthropicTransport(m: ResolvedModel, fetchImpl: FetchLike): Transport {
  return async (req) => {
    const res = await fetchImpl(`${m.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': m.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: m.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages,
        tools: req.tools,
      }),
    })
    if (!res.ok) fail(m.provider, res.status)

    const body = (await parseJson(res, m.provider)) as {
      content?: unknown
      stop_reason?: string
    }
    const blocks = Array.isArray(body.content) ? body.content : []
    const content: AssistantContentBlock[] = []
    for (const b of blocks) {
      const block = b as Record<string, unknown>
      if (block.type === 'text' && typeof block.text === 'string') {
        content.push({ type: 'text', text: block.text })
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        content.push({
          type: 'tool_use',
          id: String(block.id ?? ''),
          name: block.name,
          input: block.input ?? {},
        })
      }
    }
    return { content, stopReason: body.stop_reason }
  }
}

/* ------------------------------------------------------------------ openai-compatible */

type OpenAiMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

/**
 * Anthropic blocks -> OpenAI messages.
 *
 * The asymmetry that matters: one Anthropic user turn can carry several `tool_result` blocks,
 * and each becomes its own `role: "tool"` message. Flattening them into one would drop every
 * result but the first.
 */
function toOpenAiMessages(system: string, messages: WireMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: system }]

  for (const msg of messages) {
    const blocks = asBlocks(msg.content)
    const text = blocks
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use')
    const toolResults = blocks.filter((b): b is ToolResultBlock => b.type === 'tool_result')

    if (msg.role === 'assistant') {
      if (toolUses.length > 0) {
        out.push({
          role: 'assistant',
          content: text || null,
          tool_calls: toolUses.map((t) => ({
            id: t.id,
            type: 'function',
            function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
          })),
        })
      } else if (text) {
        out.push({ role: 'assistant', content: text })
      }
      continue
    }

    // A user turn carrying tool results becomes one `tool` message per result, and any prose
    // alongside them stays a separate user turn so it is not attributed to a tool.
    for (const r of toolResults) {
      out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: r.content })
    }
    if (text) out.push({ role: 'user', content: text })
  }

  return out
}

function openAiTransport(m: ResolvedModel, fetchImpl: FetchLike): Transport {
  return async (req) => {
    const res = await fetchImpl(`${m.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${m.apiKey}`,
      },
      body: JSON.stringify({
        model: m.model,
        max_tokens: req.maxTokens,
        messages: toOpenAiMessages(req.system, req.messages),
        tools: req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        })),
      }),
    })
    if (!res.ok) fail(m.provider, res.status)

    const body = (await parseJson(res, m.provider)) as {
      choices?: { message?: Record<string, unknown>; finish_reason?: string }[]
    }
    const choice = body.choices?.[0]
    const message = choice?.message ?? {}
    const content: AssistantContentBlock[] = []

    if (typeof message.content === 'string' && message.content.trim()) {
      content.push({ type: 'text', text: message.content })
    }

    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    for (const c of calls) {
      const call = c as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
      const name = call.function?.name
      if (typeof name !== 'string') continue
      // Arguments arrive as a JSON *string*. A model that emits malformed JSON is common
      // enough that throwing here would kill the turn; an empty object lets the tool layer
      // reject it with a message the model can read and retry against.
      let input: unknown = {}
      if (typeof call.function?.arguments === 'string' && call.function.arguments.trim()) {
        try {
          input = JSON.parse(call.function.arguments)
        } catch {
          input = {}
        }
      }
      content.push({ type: 'tool_use', id: String(call.id ?? name), name, input })
    }

    return { content, stopReason: choice?.finish_reason }
  }
}

/* ------------------------------------------------------------------ entry point */

export function createTransport(m: ResolvedModel, fetchImpl: FetchLike): Transport {
  return m.protocol === 'anthropic' ? anthropicTransport(m, fetchImpl) : openAiTransport(m, fetchImpl)
}
