/**
 * C7 — credential resolution and provider selection.
 *
 * This module decides *which* path runs. It parses nothing, calls no network client, and
 * reads no environment of its own: the env object and both providers are injected, which is
 * what keeps the tests pure and keeps `process.env` out of module scope.
 *
 * The resolution order is the contract:
 *
 *   1. `x-llm-key` header — the user's own key, for this one request only
 *   2. `ANTHROPIC_API_KEY` from the injected env — for self-hosting
 *   3. the deterministic template provider — must work with no credentials at all
 *
 * Step 3 is load-bearing, not a courtesy. The demo has to run on a judge's machine with no
 * key, so every way the LLM path can go wrong ends at the template rather than at an error.
 *
 * The user's key is handled as if it were radioactive: it lives in the returned
 * `ResolvedCredential` and in the argument to `deps.llm`, and nowhere else. It is never
 * logged, never persisted, never attached to an error, and never present in a
 * `MilestonesResult`. The catch below is deliberately blind — it does not read the error's
 * message, because an HTTP client's error can quote the request headers it just sent.
 */

import { PROVIDERS } from '@/lib/models/registry'
import type {
  BriefInput,
  Credential,
  MilestoneDraft,
  MilestoneProvider,
  MilestonesResult,
  ResolvedCredential,
} from '@/lib/ai/types'
import type { CheckKind } from '@/lib/verify/types'

/** The per-request header. Matched case-insensitively; HTTP header names are not case-sensitive. */
export const LLM_KEY_HEADER = 'x-llm-key'

/** The self-hosting fallback. Read off the injected env, never off `process.env` directly. */
export const LLM_KEY_ENV = 'ANTHROPIC_API_KEY'

/**
 * The slice of `Headers` this module needs.
 *
 * `forEach` is optional so a bare `{ get }` stub still satisfies the type, but when it is
 * present it is used to make the lookup genuinely case-insensitive even for a Headers-like
 * whose `get` is a literal key lookup on a plain object.
 */
export type HeadersLike = {
  get(name: string): string | null | undefined
  forEach?(callback: (value: string, key: string) => void): void
}

/** `process.env`-shaped, but injected — so a test never has to mutate the real one. */
export type EnvLike = { readonly [key: string]: string | undefined }

/**
 * Why a request fell back to the template.
 *
 * A closed set of strings rather than the underlying error: an enum is structurally incapable
 * of carrying the user's key, so a caller that logs this cannot leak it by accident.
 */
export type FallbackEvent = { reason: 'llm-error' | 'llm-invalid-output' }

/**
 * Injected collaborators.
 *
 * `llm` is a factory rather than a provider so the credential is passed at call time and this
 * file never holds one. `template` is a plain provider because it needs nothing.
 */
export type ProviderDeps = {
  template: MilestoneProvider
  llm(credential: Credential): MilestoneProvider
  /** Optional observability hook. Receives a reason code only — never the error, never the key. */
  onFallback?(event: FallbackEvent): void
}

/**
 * A header or env var that is present but blank is not a credential.
 *
 * A user who opened the key field and then cleared it should get the template, not a 400.
 * The failure mode we are avoiding is an empty string reaching an SDK and coming back as an
 * authentication error on a page that had a perfectly good offline path available.
 */
function asCredentialValue(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Case-insensitive header read.
 *
 * A real `Headers` already folds case, so the direct `get` handles the common path. The
 * `forEach` scan exists for the object-backed stubs that show up in tests and in adapters,
 * where `get('x-llm-key')` would miss a stored `X-LLM-Key` and silently downgrade the user to
 * the template when they did supply a key.
 */
function readHeader(headers: HeadersLike, name: string): string | null {
  const wanted = name.toLowerCase()

  const direct = headers.get(wanted)
  if (typeof direct === 'string') return direct

  if (typeof headers.forEach !== 'function') return null

  // Held in a box because TypeScript does not track assignments made inside a callback.
  const found: { value: string | null } = { value: null }
  headers.forEach((value, key) => {
    if (found.value === null && typeof key === 'string' && key.toLowerCase() === wanted) {
      found.value = typeof value === 'string' ? value : null
    }
  })
  return found.value
}

/**
 * The C7 order, exactly: header, then env, then nothing.
 *
 * Returning `{ source: 'none' }` is a normal outcome, not a failure — it is how the
 * no-credential demo works.
 */
export function resolveCredential(headers: HeadersLike, env: EnvLike): ResolvedCredential {
  const fromHeader = asCredentialValue(readHeader(headers, LLM_KEY_HEADER))
  if (fromHeader !== null) {
    return { source: 'header', credential: { kind: 'api-key', value: fromHeader } }
  }

  // Any provider's key, not just Anthropic's.
  //
  // This read `ANTHROPIC_API_KEY` and nothing else, so a deployment with a perfectly good
  // `OPENROUTER_API_KEY` set was told it had no credential and fell back to the template — the
  // assistant reporting "unavailable" while the key sat in the environment two lines away.
  // The provider registry has always known each provider's env vars; the resolver simply never
  // asked it. Two credential resolvers existed, one provider-aware and unused, one
  // Anthropic-only and live.
  //
  // `ANTHROPIC_API_KEY` is still tried first so nothing that worked before changes, then the
  // registry order. `provider` comes back so the caller can send the request to the vendor the
  // key actually belongs to — routing an OpenRouter key to Anthropic is the same mistake in the
  // other direction.
  const direct = asCredentialValue(env[LLM_KEY_ENV])
  if (direct !== null) {
    return { source: 'env', provider: 'anthropic', credential: { kind: 'api-key', value: direct } }
  }

  for (const [slug, conn] of Object.entries(PROVIDERS)) {
    for (const name of conn.envVars) {
      const value = asCredentialValue(env[name])
      if (value !== null) {
        return { source: 'env', provider: slug, credential: { kind: 'api-key', value } }
      }
    }
  }

  return { source: 'none' }
}

/**
 * Credential present means the LLM provider; no credential means the template.
 *
 * Both arrive through `deps`, so this file never imports a network client and the tests never
 * need one.
 */
export function selectProvider(resolved: ResolvedCredential, deps: ProviderDeps): MilestoneProvider {
  if (resolved.source === 'none') return deps.template
  return deps.llm(resolved.credential)
}

const CHECK_KINDS: readonly CheckKind[] = ['http', 'github', 'clientApproval']

/** wei as a decimal string, no sign, no exponent, no leading zeros. */
const WEI_DECIMAL = /^(0|[1-9][0-9]*)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCheckKind(value: unknown): value is CheckKind {
  return typeof value === 'string' && (CHECK_KINDS as readonly string[]).includes(value)
}

/**
 * Is this actually a list of drafts?
 *
 * A model can return prose, an empty array, an object where an array belongs, or an amount as
 * a JSON number that has already lost precision — `6000000000000000000` does not survive a
 * round trip through a float. Anything that is not recognisably a `MilestoneDraft[]` is
 * treated as a failed LLM call, and the template answers instead.
 *
 * This is a shape guard, not an arithmetic one. Whether the amounts sum to exactly
 * `totalAmount` is checked where the split is built and again in the UI before signing; a
 * provider that decides which path runs is the wrong place to own that invariant.
 */
function isMilestoneDraftArray(value: unknown): value is MilestoneDraft[] {
  if (!Array.isArray(value) || value.length === 0) return false

  return value.every((draft): boolean => {
    if (!isRecord(draft)) return false
    if (typeof draft.title !== 'string' || draft.title.trim().length === 0) return false
    // A number here would already be wrong: 6 MON exceeds Number.MAX_SAFE_INTEGER.
    if (typeof draft.amount !== 'string' || !WEI_DECIMAL.test(draft.amount)) return false
    if (!isCheckKind(draft.check)) return false
    if (typeof draft.rationale !== 'string') return false

    const criteria = draft.criteria
    if (!isRecord(criteria)) return false
    if (criteria.v !== 1) return false
    if (typeof criteria.title !== 'string') return false
    // The draft's `check` is a mirror of the criteria's. If they disagree, the UI would show
    // one kind of promise while the verifier is later asked to check another.
    if (criteria.check !== draft.check) return false
    if (draft.check === 'http' && !isRecord(criteria.http)) return false
    if (draft.check === 'github' && !isRecord(criteria.github)) return false

    return true
  })
}

function notify(deps: ProviderDeps, reason: FallbackEvent['reason']): void {
  if (typeof deps.onFallback !== 'function') return
  try {
    deps.onFallback({ reason })
  } catch {
    // An observability hook must never be able to turn a working page into a 500.
  }
}

/**
 * Run the LLM path, or return `null` if it did not produce usable drafts for any reason.
 *
 * "Any reason" is meant literally: an expired key, a rate limit, a timeout, a network error, a
 * malformed response, or a factory that throws while constructing a client. All of them are a
 * degraded result, never an error page.
 */
async function tryLlm(
  input: BriefInput,
  resolved: ResolvedCredential,
  deps: ProviderDeps,
): Promise<MilestonesResult | null> {
  try {
    const provider = selectProvider(resolved, deps)
    const drafts = await provider.propose(input)
    if (!isMilestoneDraftArray(drafts)) {
      notify(deps, 'llm-invalid-output')
      return null
    }
    // `provider.name`, not a hardcoded 'llm': the label has to describe what actually ran.
    return { milestones: drafts, source: provider.name }
  } catch {
    // The error is discarded unread and unlogged. An SDK error can echo the request headers,
    // and the user's key is in them — so there is no safe way to inspect or report it here.
    notify(deps, 'llm-error')
    return null
  }
}

/**
 * The single entry point the route calls.
 *
 * Guaranteed to resolve with milestones whenever the template provider works, which is the
 * whole promise of rule 3.
 */
export async function proposeMilestones(
  input: BriefInput,
  resolved: ResolvedCredential,
  deps: ProviderDeps,
): Promise<MilestonesResult> {
  if (resolved.source !== 'none') {
    const attempt = await tryLlm(input, resolved, deps)
    if (attempt !== null) return attempt
  }

  // Outside the try on purpose: if the template itself is broken that is a real bug in our own
  // code, and swallowing it would leave the route returning an empty page with no explanation.
  const milestones = await deps.template.propose(input)
  return { milestones, source: 'template' }
}
