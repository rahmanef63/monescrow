/**
 * C7 — brief to milestones, bring-your-own-key.
 *
 * The shared seam for `provider.ts`, `template.ts`, `anthropic.ts` and the route. Nothing
 * here redeclares a shape and nothing here reads the environment.
 */

import type { Criteria } from '@/lib/verify/types'

/**
 * One proposed milestone. Everything in it is **advisory** — the UI must let both parties
 * edit every amount and every criterion before anything is signed, and the sum is re-checked
 * client-side against the total. A model's arithmetic is never trusted.
 */
export type MilestoneDraft = {
  title: string
  /** wei, as a decimal string. Never a number: 6 MON is 6e18 and exceeds 2^53. */
  amount: string
  check: Criteria['check']
  /** C3 shape, minus the hash — the hash is computed when the escrow is created. */
  criteria: Criteria
  /** Shown to both parties before they sign, so neither is agreeing to a black box. */
  rationale: string
}

export type MilestoneSource = 'llm' | 'template'

export type MilestonesResult = {
  milestones: MilestoneDraft[]
  source: MilestoneSource
}

export type BriefInput = {
  brief: string
  /** wei, decimal string. The drafts must sum to exactly this. */
  totalAmount: string
  currency: 'MON'
}

/**
 * A resolved credential.
 *
 * `kind` exists so a provider offering OAuth can slot in without touching call sites — it is
 * an extension point, not a v1 feature. Do not stub a fake OAuth flow behind it.
 */
export type Credential = { kind: 'api-key' | 'oauth'; value: string }

/**
 * Where a credential came from. Returned for the caller's benefit and for tests; the value
 * itself must never be logged, persisted, or echoed in a response.
 */
export type CredentialSource = 'header' | 'env' | 'none'

export type ResolvedCredential =
  | { source: 'header' | 'env'; credential: Credential }
  | { source: 'none' }

/**
 * A provider turns a brief into drafts. `template` is one of these too, which is what keeps
 * the no-credential path on the same code path as the LLM one rather than bolted beside it.
 */
export type MilestoneProvider = {
  name: MilestoneSource
  propose(input: BriefInput): Promise<MilestoneDraft[]>
}
