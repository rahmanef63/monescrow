import { describe, expect, it, vi } from 'vitest'
import { PROVIDERS, isKnownProvider } from './registry'
import { ModelResolutionError, normaliseRef, parseRef, resolveModel } from './resolve'
import { configuredProviders, memoryCredentialStore, requestCredentialStore } from './store'
import { createTransport, type FetchLike } from './call'
import type { ResolvedModel } from './resolve'

/**
 * A stub that behaves like the real `Headers`: lookup is case-insensitive, per the spec.
 *
 * Written this way deliberately. A stub that matched only the exact spelling would let the
 * store pass while relying on guesswork the real interface makes unnecessary — the test would
 * be measuring the stub rather than the code.
 */
const headers = (h: Record<string, string>) => {
  const lower = new Map(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
  return { get: (n: string) => lower.get(n.toLowerCase()) ?? null }
}
const KEY = 'sk-user-supplied-key-value'

describe('parseRef', () => {
  // OpenRouter model ids contain slashes. Splitting anywhere but the first one resolves the
  // wrong provider — and with host-gating that means sending the key to the wrong company.
  it('splits on the first slash only', () => {
    expect(parseRef('openrouter/anthropic/claude-sonnet-5')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-5',
    })
  })

  it('rejects anything that is not provider/model', () => {
    for (const bad of ['', 'openai', '/gpt-4o', 'openai/', '   ']) {
      expect(() => parseRef(bad)).toThrow(ModelResolutionError)
    }
  })
})

describe('normaliseRef', () => {
  it('expands a bare provider slug to its default model', () => {
    expect(normaliseRef('openai')).toBe('openai/' + PROVIDERS.openai.defaultModel)
    expect(normaliseRef('OpenAI')).toBe('openai/' + PROVIDERS.openai.defaultModel)
  })

  it('defaults to anthropic when nothing was asked for', () => {
    expect(normaliseRef(null)).toBe('anthropic/' + PROVIDERS.anthropic.defaultModel)
    expect(normaliseRef('  ')).toBe('anthropic/' + PROVIDERS.anthropic.defaultModel)
  })

  it('leaves a full reference alone', () => {
    expect(normaliseRef('groq/llama-3.3-70b-versatile')).toBe('groq/llama-3.3-70b-versatile')
  })
})

describe('resolveModel — the host gate', () => {
  const store = memoryCredentialStore({ anthropic: KEY, openai: KEY, madeup: KEY })

  /**
   * THE security test. A caller controls both the key and, if we let them, the URL. Sending
   * provider "anthropic" with their own baseUrl would have our server post the key to them.
   */
  it('ignores a caller baseUrl for a known provider', async () => {
    const m = await resolveModel('anthropic/claude-sonnet-5', {
      store,
      baseUrl: 'https://attacker.example/v1',
    })
    expect(m.baseUrl).toBe(PROVIDERS.anthropic.baseUrl)
    expect(m.baseUrl).not.toContain('attacker')
    expect(m.baseUrlOverridden).toBe(true) // recorded, so the route can say it was ignored
  })

  it('pins every registry provider to its own endpoint', async () => {
    for (const slug of Object.keys(PROVIDERS)) {
      const m = await resolveModel(slug + '/whatever', {
        store: memoryCredentialStore({ [slug]: KEY }),
        baseUrl: 'https://attacker.example/v1',
      })
      expect(m.baseUrl, slug + ' was redirectable').toBe(PROVIDERS[slug].baseUrl)
    }
  })

  // The only case an override is honoured: a provider we do not know, which cannot resolve
  // without one. The caller is naming their own endpoint for their own key.
  it('honours a baseUrl for an unknown provider', async () => {
    const m = await resolveModel('madeup/some-model', { store, baseUrl: 'https://self.hosted/v1' })
    expect(m.baseUrl).toBe('https://self.hosted/v1')
    expect(m.protocol).toBe('openai')
    expect(m.baseUrlOverridden).toBe(false)
  })

  it('refuses an unknown provider with no baseUrl', async () => {
    await expect(resolveModel('madeup/m', { store })).rejects.toMatchObject({
      info: { reason: 'unknown-provider' },
    })
  })

  it('refuses when there is no credential', async () => {
    await expect(
      resolveModel('openai/gpt-4o', { store: memoryCredentialStore({}) }),
    ).rejects.toMatchObject({ info: { reason: 'no-credential' } })
  })

  it('never puts the key in an error message', async () => {
    const noisy = memoryCredentialStore({ openai: KEY })
    try {
      await resolveModel('nope/x', { store: noisy })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as Error).message).not.toContain(KEY)
    }
  })
})

describe('requestCredentialStore', () => {
  it('prefers the header over env, for any provider named', async () => {
    const s = requestCredentialStore(headers({ 'x-llm-key': KEY }), {
      ANTHROPIC_API_KEY: 'env-key',
    })
    expect(await s.getKey('anthropic')).toBe(KEY)
    expect(s.lastSource()).toBe('header')
  })

  it('matches the header name case-insensitively', async () => {
    const s = requestCredentialStore(headers({ 'X-LLM-Key': KEY }), {})
    expect(await s.getKey('openai')).toBe(KEY)
  })

  // A user who opened the key field and cleared it should get the fallback, not an error.
  it('treats a blank header as absent', async () => {
    const s = requestCredentialStore(headers({ 'x-llm-key': '   ' }), { OPENAI_API_KEY: 'env-key' })
    expect(await s.getKey('openai')).toBe('env-key')
    expect(s.lastSource()).toBe('env')
  })

  // An OpenAI key must not be handed to Anthropic just because it happens to be set.
  it('keys env lookups by provider', async () => {
    const s = requestCredentialStore(headers({}), { OPENAI_API_KEY: 'openai-only' })
    expect(await s.getKey('openai')).toBe('openai-only')
    expect(await s.getKey('anthropic')).toBeNull()
  })

  it('walks a provider env chain in order', async () => {
    const s = requestCredentialStore(headers({}), { GOOGLE_API_KEY: 'second' })
    expect(await s.getKey('google')).toBe('second')
  })

  it('returns null rather than throwing when nothing is configured', async () => {
    const s = requestCredentialStore(headers({}), {})
    expect(await s.getKey('anthropic')).toBeNull()
    expect(s.lastSource()).toBe('none')
  })
})

describe('configuredProviders', () => {
  it('lists slugs only, never values', () => {
    const list = configuredProviders({ ANTHROPIC_API_KEY: 'secret-a', GROQ_API_KEY: 'secret-b' })
    expect(list.sort()).toEqual(['anthropic', 'groq'])
    expect(JSON.stringify(list)).not.toContain('secret-')
  })

  it('ignores blank env vars', () => {
    expect(configuredProviders({ ANTHROPIC_API_KEY: '  ' })).toEqual([])
  })
})

describe('createTransport', () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })

  const resolved = (over: Partial<ResolvedModel> = {}): ResolvedModel => ({
    ref: 'anthropic/claude-sonnet-5',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    baseUrl: PROVIDERS.anthropic.baseUrl,
    apiKey: KEY,
    protocol: 'anthropic',
    baseUrlOverridden: false,
    ...over,
  })

  const REQ = {
    system: 'be honest',
    messages: [{ role: 'user' as const, content: 'hello' }],
    tools: [{ name: 'get_job', description: 'read', input_schema: { type: 'object' } }],
    maxTokens: 512,
  }

  it('speaks the anthropic wire and reads its blocks back', async () => {
    const f = vi.fn(async () =>
      ok({
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 't1', name: 'get_job', input: { a: 1 } },
        ],
      }),
    )
    const reply = await createTransport(resolved(), f as unknown as FetchLike)(REQ)

    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.headers['x-api-key']).toBe(KEY)
    expect(init.headers['anthropic-version']).toBe('2023-06-01')
    expect(reply.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 't1', name: 'get_job', input: { a: 1 } },
    ])
  })

  it('speaks the openai wire and translates tool calls back into blocks', async () => {
    const f = vi.fn(async () =>
      ok({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: 'looking',
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'get_job', arguments: '{"a":1}' } },
              ],
            },
          },
        ],
      }),
    )
    const m = resolved({
      provider: 'openai',
      protocol: 'openai',
      baseUrl: PROVIDERS.openai.baseUrl,
      model: 'gpt-4o',
    })
    const reply = await createTransport(m, f as unknown as FetchLike)(REQ)

    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(init.headers.authorization).toBe('Bearer ' + KEY)
    expect(reply.content).toEqual([
      { type: 'text', text: 'looking' },
      { type: 'tool_use', id: 'c1', name: 'get_job', input: { a: 1 } },
    ])
  })

  /**
   * The translation that actually breaks things if it is wrong. Anthropic carries several
   * tool results in one user turn; OpenAI needs one role "tool" message each. Flattening
   * loses every result but the first, and the model silently ignores what it looked up.
   */
  it('gives every tool result its own openai message', async () => {
    const f = vi.fn(async () => ok({ choices: [{ message: { content: 'done' } }] }))
    const m = resolved({ provider: 'openai', protocol: 'openai', baseUrl: PROVIDERS.openai.baseUrl })
    await createTransport(m, f as unknown as FetchLike)({
      ...REQ,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'a', name: 'get_job', input: {} },
            { type: 'tool_use', id: 'b', name: 'get_milestone', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'a', content: 'A' },
            { type: 'tool_result', tool_use_id: 'b', content: 'B' },
          ],
        },
      ],
    })

    const body = (f.mock.calls[0] as unknown as [string, { body: string }])[1].body
    const sent = JSON.parse(body) as { messages: { role: string; tool_call_id?: string }[] }
    const toolMsgs = sent.messages.filter((x) => x.role === 'tool')
    expect(toolMsgs).toHaveLength(2)
    expect(toolMsgs.map((x) => x.tool_call_id)).toEqual(['a', 'b'])
    expect(sent.messages[0].role).toBe('system')
  })

  it('survives a model that emits malformed tool arguments', async () => {
    const f = vi.fn(async () =>
      ok({
        choices: [
          { message: { tool_calls: [{ id: 'c', function: { name: 'get_job', arguments: '{oops' } }] } },
        ],
      }),
    )
    const m = resolved({ provider: 'openai', protocol: 'openai', baseUrl: PROVIDERS.openai.baseUrl })
    const reply = await createTransport(m, f as unknown as FetchLike)(REQ)
    expect(reply.content).toEqual([{ type: 'tool_use', id: 'c', name: 'get_job', input: {} }])
  })

  // Provider error bodies quote the request, headers included. Summarise, never echo.
  it('never leaks the key through an upstream error', async () => {
    const f = async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized for key ' + KEY,
    })
    let caught: Error | null = null
    try {
      await createTransport(resolved(), f as unknown as FetchLike)(REQ)
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught?.message).not.toContain(KEY)
    expect(caught?.message).toContain('401')
  })
})

describe('registry', () => {
  it('knows its own providers and rejects the rest', () => {
    expect(isKnownProvider('anthropic')).toBe(true)
    expect(isKnownProvider('definitely-not')).toBe(false)
  })

  it('gives every provider a reachable https endpoint and a default model', () => {
    for (const [slug, c] of Object.entries(PROVIDERS)) {
      expect(c.baseUrl, slug).toMatch(/^https:\/\//)
      expect(c.defaultModel, slug).toBeTruthy()
      expect(c.envVars.length, slug).toBeGreaterThan(0)
    }
  })
})
