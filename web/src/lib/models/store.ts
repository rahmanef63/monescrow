/**
 * `CredentialStore` — the one seam every key lookup goes through.
 *
 * The point of routing everything through `getKey(provider)` is that where keys live becomes a
 * swap rather than a rewrite. Here there are exactly two places and one order, fixed by C7:
 *
 *   1. the `x-llm-key` header the user supplied for this one request — memory only
 *   2. the server's own env, for a self-hoster
 *   3. neither, which is a normal outcome and never an error
 *
 * There is no third implementation and no persistence on purpose. A hackathon judge pasting a
 * key into a box has not consented to us storing it, and a store we do not have cannot leak.
 *
 * The tenant argument the upstream project carries is deliberately absent: this app has no
 * accounts, and a parameter that is always `undefined` is a lie about what the code does.
 */

import { PROVIDERS } from './registry'

export type CredentialSource = 'header' | 'env' | 'none'

export type CredentialStore = {
  /** The key for a provider, or null. Never throws — absence is an answer. */
  getKey(provider: string): Promise<string | null>
  /** Where the last successful lookup came from. For telling the user, never the key itself. */
  lastSource(): CredentialSource
}

export type EnvLike = Record<string, string | undefined>

export type HeaderLike = { get(name: string): string | null }

/** A header present but blank is not a credential — fall through rather than fail the request. */
function clean(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim()
  return v.length > 0 ? v : null
}

/**
 * Read a header by its lowercase name, and only that.
 *
 * The WHATIS `Headers` interface is case-insensitive by specification, so `get('x-llm-key')`
 * finds a header the client sent as `X-LLM-Key`. An earlier version of this function also
 * tried an upper-case and a title-case spelling "to be safe"; that guessed at three of the
 * many possible spellings, could never cover them all, and made a stub that was *not*
 * case-insensitive look like it worked. Anything passed here must behave like `Headers` —
 * which the tests now assert by using a stub that does.
 */
function headerValue(headers: HeaderLike, name: string): string | null {
  return clean(headers.get(name))
}

/**
 * The store the routes use.
 *
 * `provider` is honoured on the env side — an OpenAI key must not be handed to Anthropic just
 * because it happens to be set. On the header side the user pasted one key and named one
 * provider, so it is used for whatever they named and nothing else.
 */
export function requestCredentialStore(headers: HeaderLike, env: EnvLike): CredentialStore {
  let source: CredentialSource = 'none'
  const fromHeader = headerValue(headers, 'x-llm-key')

  return {
    async getKey(provider: string) {
      if (fromHeader) {
        source = 'header'
        return fromHeader
      }
      const vars = PROVIDERS[provider]?.envVars ?? [`${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`]
      for (const name of vars) {
        const v = clean(env[name])
        if (v) {
          source = 'env'
          return v
        }
      }
      source = 'none'
      return null
    },
    lastSource: () => source,
  }
}

/** Tests. Nothing reads the environment and nothing reads a header. */
export function memoryCredentialStore(keys: Record<string, string>): CredentialStore {
  let source: CredentialSource = 'none'
  return {
    async getKey(provider: string) {
      const v = clean(keys[provider])
      source = v ? 'header' : 'none'
      return v
    },
    lastSource: () => source,
  }
}

/**
 * Which providers this server could serve with no user key at all.
 *
 * Used to tell somebody *why* the assistant is unavailable — "no key configured" is actionable,
 * a blank panel is not. Returns slugs only; a value never leaves this module.
 */
export function configuredProviders(env: EnvLike): string[] {
  return Object.entries(PROVIDERS)
    .filter(([, conn]) => conn.envVars.some((n) => clean(env[n])))
    .map(([slug]) => slug)
}
