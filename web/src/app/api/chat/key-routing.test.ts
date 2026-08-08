/**
 * Regression test for a live P0: the server's own API key being routed to another vendor.
 *
 * # The bug, because the shape of it is the lesson
 *
 * `POST /api/chat` forwarded the caller's `x-llm-model` header into the transport
 * unconditionally, while the credential was resolved separately — and with no `x-llm-key`,
 * that resolution falls back to the server's `ANTHROPIC_API_KEY`. So an anonymous request:
 *
 *     POST /api/chat
 *     x-llm-model: deepseek
 *     (no x-llm-key)
 *
 * resolved **our** Anthropic key and posted it to `api.deepseek.com` as a bearer token. Same
 * for groq, xai, mistral, openrouter, google and github-models. One request per vendor is
 * enough to burn the key.
 *
 * # Why the host gate did not catch it, which is the part worth remembering
 *
 * `resolveModel` pins every known provider to its registry endpoint, so a key can never be
 * sent to an attacker-controlled URL. That defence was working exactly as designed and was
 * irrelevant here: `api.deepseek.com` **is** a legitimate registry host. The gate answers
 * "may this key go to this URL", and the question that mattered was "**whose** key is this".
 * A host gate pins hosts. It does not decide ownership.
 *
 * So the rule is about consent, not about URLs: a caller may choose the vendor only when the
 * credential being spent is the caller's own.
 */
import { describe, expect, it } from 'vitest'
import { callerModelRef, MODEL_HEADER } from './route'
import { LLM_KEY_HEADER } from '@/lib/ai/provider'
import { normaliseRef } from '@/lib/models/resolve'
import { PROVIDERS } from '@/lib/models/registry'

/** Behaves like the real `Headers`: case-insensitive lookup, null when absent. */
const headers = (h: Record<string, string>) => {
  const lower = new Map(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
  return { get: (n: string) => lower.get(n.toLowerCase()) ?? null }
}

/** Every registry provider that is not the one the server's env key belongs to. */
const OTHER_VENDORS = Object.keys(PROVIDERS).filter((p) => p !== 'anthropic')

describe('a caller may not choose where the server’s key is spent', () => {
  /**
   * THE regression. Without a key of their own, the caller gets no say in the vendor, and the
   * empty ref resolves to Anthropic — the provider the env key actually belongs to.
   */
  it.each(OTHER_VENDORS)('ignores x-llm-model: %s when the caller brought no key', (vendor) => {
    const ref = callerModelRef(headers({ [MODEL_HEADER]: vendor }))

    expect(ref, `${vendor} was allowed to redirect the server key`).toBe('')
    expect(normaliseRef(ref)).toBe(`anthropic/${PROVIDERS.anthropic.defaultModel}`)
  })

  it('ignores a fully qualified ref just as firmly as a bare slug', () => {
    expect(callerModelRef(headers({ [MODEL_HEADER]: 'groq/llama-3.3-70b-versatile' }))).toBe('')
  })

  // A header present but blank is not a key. Treating whitespace as consent would reopen the
  // hole to anyone who sends `x-llm-key: ` — which is what an empty form field posts.
  it.each(['', '   ', '\t'])('treats a blank key header (%j) as no key at all', (blank) => {
    const ref = callerModelRef(headers({ [LLM_KEY_HEADER]: blank, [MODEL_HEADER]: 'deepseek' }))
    expect(ref).toBe('')
  })

  /**
   * The positive control. Without this the test above is satisfied by a function that always
   * returns '' — which would pass every assertion here while silently breaking BYOK, the
   * feature this header exists for.
   */
  it('honours the caller’s model when the caller brought their own key', () => {
    const ref = callerModelRef(
      headers({ [LLM_KEY_HEADER]: 'sk-caller-own-key', [MODEL_HEADER]: 'deepseek' }),
    )
    expect(ref).toBe('deepseek')
    expect(normaliseRef(ref)).toBe(`deepseek/${PROVIDERS.deepseek.defaultModel}`)
  })

  it('lets a BYOK caller name a full provider/model reference', () => {
    const ref = callerModelRef(
      headers({ [LLM_KEY_HEADER]: 'sk-caller-own-key', [MODEL_HEADER]: 'openrouter/anthropic/claude-sonnet-5' }),
    )
    expect(ref).toBe('openrouter/anthropic/claude-sonnet-5')
  })

  it('falls back to Anthropic when a BYOK caller names no model', () => {
    const ref = callerModelRef(headers({ [LLM_KEY_HEADER]: 'sk-caller-own-key' }))
    expect(ref).toBe('')
    expect(normaliseRef(ref)).toBe(`anthropic/${PROVIDERS.anthropic.defaultModel}`)
  })

  it('reads both headers case-insensitively, as Headers does', () => {
    const ref = callerModelRef(headers({ 'X-LLM-Key': 'sk-caller', 'X-LLM-Model': 'groq' }))
    expect(ref).toBe('groq')
  })
})
