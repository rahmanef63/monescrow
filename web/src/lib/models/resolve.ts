/**
 * Turn a `provider/model` reference plus a credential source into something callable.
 *
 * # The security property, which is the reason this file exists at all
 *
 * **A provider's key is pinned to that provider's endpoint.** Both AI routes accept a key from
 * a request header, so if a caller could also supply the `baseUrl`, they could send
 * `provider: "anthropic"` with a URL they control and have our server post somebody's key
 * straight to them. The key would leave the building, from our IP, over our TLS, and nothing
 * in the request would look unusual.
 *
 * So: a provider in the registry is **always** reached at its registry `baseUrl`, and any
 * caller-supplied override is discarded. An override is honoured only for providers we do not
 * know, which cannot be resolved without one — there the caller is necessarily naming their
 * own endpoint and their own key, and there is nothing to redirect.
 *
 * This is the same shape as the binding check in `verify/bind.ts`: the dangerous input is the
 * one the caller supplies and the server would otherwise trust.
 */

import { PROVIDERS, hostOf, isKnownProvider, type WireProtocol } from './registry'
import type { CredentialStore } from './store'

export type ResolvedModel = {
  ref: string
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  protocol: WireProtocol
  /** True when the caller's `baseUrl` was ignored because the provider is registry-pinned. */
  baseUrlOverridden: boolean
}

export type ResolveError =
  | { reason: 'bad-ref'; detail: string }
  | { reason: 'unknown-provider'; detail: string }
  | { reason: 'no-credential'; detail: string }

export class ModelResolutionError extends Error {
  readonly info: ResolveError
  constructor(info: ResolveError) {
    // The message never contains a key: `detail` is built from the provider slug and the ref.
    super(info.detail)
    this.name = 'ModelResolutionError'
    this.info = info
  }
}

/**
 * Split on the **first** slash, not the last and not all of them.
 *
 * OpenRouter model ids contain slashes — `openrouter/anthropic/claude-sonnet-5` is provider
 * `openrouter`, model `anthropic/claude-sonnet-5`. Splitting anywhere else silently resolves
 * the wrong provider, which with host-gating in place means the key goes to the wrong company.
 */
export function parseRef(ref: string): { provider: string; model: string } {
  const trimmed = ref.trim()
  const i = trimmed.indexOf('/')
  if (i < 1 || i === trimmed.length - 1) {
    throw new ModelResolutionError({
      reason: 'bad-ref',
      detail: `model reference "${trimmed}" is not "provider/model"`,
    })
  }
  return { provider: trimmed.slice(0, i).toLowerCase(), model: trimmed.slice(i + 1) }
}

/**
 * A bare provider slug means "that provider's default model", so `x-llm-model: openai` works
 * and a user who does not know model ids still gets something.
 */
export function normaliseRef(input: string | null | undefined, fallback = 'anthropic'): string {
  const raw = (input ?? '').trim()
  if (!raw) return `${fallback}/${PROVIDERS[fallback].defaultModel}`
  if (!raw.includes('/')) {
    const slug = raw.toLowerCase()
    if (isKnownProvider(slug)) return `${slug}/${PROVIDERS[slug].defaultModel}`
  }
  return raw
}

export async function resolveModel(
  ref: string,
  opts: { store: CredentialStore; baseUrl?: string },
): Promise<ResolvedModel> {
  const { provider, model } = parseRef(ref)
  const conn = PROVIDERS[provider]

  if (!conn && !opts.baseUrl) {
    throw new ModelResolutionError({
      reason: 'unknown-provider',
      detail: `unknown provider "${provider}" — pass a baseUrl or use one of: ${Object.keys(PROVIDERS).join(', ')}`,
    })
  }

  const apiKey = await opts.store.getKey(provider)
  if (!apiKey) {
    throw new ModelResolutionError({
      reason: 'no-credential',
      detail: `no API key available for provider "${provider}"`,
    })
  }

  // THE HOST GATE. A known provider is reached at its registry URL, full stop.
  const pinned = Boolean(conn)
  const baseUrl = conn ? conn.baseUrl : (opts.baseUrl as string)

  return {
    ref: `${provider}/${model}`,
    provider,
    model,
    baseUrl,
    apiKey,
    protocol: conn?.protocol ?? 'openai',
    baseUrlOverridden: pinned && !!opts.baseUrl && hostOf(opts.baseUrl) !== hostOf(baseUrl),
  }
}
