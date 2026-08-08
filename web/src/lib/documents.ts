/**
 * Where the C3/C4/C5 documents live until Convex exists.
 *
 * The contract commits to criteria, evidence and reports **by keccak hash** and stores none of
 * the JSON. Something has to hold the preimage or nobody — including the verifier — can check
 * anything. `web/CONVEX.md` plans the real store; this is the browser-local stand-in, written
 * to the same shape so the Convex adapter drops in behind the same two functions.
 *
 * **Content-addressed on purpose.** The key is the document's own hash, not
 * `(escrow, milestone)`. That makes "store a different criteria for milestone 2" inexpressible
 * in the key space rather than merely discouraged, and it means a document that does not match
 * its on-chain hash can never be filed under that hash to begin with.
 *
 * Three things it deliberately is not:
 *
 *   - **not on the listing path.** Nothing here is imported by the job list or by any action
 *     button. `architecture.test.ts` fails if that changes, which is the executable form of
 *     C8's rule that the chain, not a store, is the source of truth for what exists.
 *   - **not shared.** `localStorage` is one browser. The client who created a job has the
 *     criteria; the freelancer opening the link does not. That is a real limitation and the UI
 *     says so plainly instead of showing an empty panel — see `WorkPanel`.
 *   - **not authoritative.** A stored document is only meaningful if it re-hashes to the hash
 *     on chain, so `get` re-hashes before returning and refuses a mismatch. A consumer cannot
 *     forget the check because it is not a separate step.
 */

import { hashJson } from '@/lib/verify/report'

const PREFIX = 'monescrow:doc:'

export type DocumentLookup<T> =
  /** Found, and it re-hashes to the hash asked for. */
  | { status: 'found'; document: T }
  /** Nothing is stored under that hash here. Not the same as "it does not exist". */
  | { status: 'absent' }
  /**
   * Something is stored but it does not match. Either the file was edited or the milestone was
   * superseded. Never render this as though it were the agreement.
   */
  | { status: 'mismatch' }
  /** No storage at all — server render, private mode, quota. Ours, not the user's. */
  | { status: 'unavailable' }

const memory = new Map<string, string>()

/** `localStorage` throws in private mode and does not exist during SSR. Degrade, never throw. */
function backing(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    // Touch it: Safari private mode has the object and throws on write.
    window.localStorage.setItem(PREFIX + 'probe', '1')
    window.localStorage.removeItem(PREFIX + 'probe')
    return window.localStorage
  } catch {
    return memory as unknown as Pick<Storage, 'getItem' | 'setItem'>
  }
}

/**
 * Store a document under its own hash and return that hash.
 *
 * The hash is computed here rather than accepted from the caller, so the key and the content
 * cannot disagree.
 */
export function putDocument(document: unknown): `0x${string}` {
  const hash = hashJson(document)
  const store = backing()
  try {
    store?.setItem(PREFIX + hash.toLowerCase(), JSON.stringify(document))
  } catch {
    // Quota. The document is still usable in this tab via the return value; losing the cache
    // is a degraded experience, not a failure worth interrupting a transaction for.
  }
  return hash
}

/** Look a document up by the hash the chain committed to, re-hashing before it is trusted. */
export function getDocument<T>(hash: string | null | undefined): DocumentLookup<T> {
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return { status: 'absent' }

  const store = backing()
  if (!store) return { status: 'unavailable' }

  const raw = store.getItem(PREFIX + hash.toLowerCase())
  if (raw === null) return { status: 'absent' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'mismatch' }
  }

  // The whole point. A document that does not re-hash to the hash on chain is not the
  // agreement, whatever it says about itself.
  if (hashJson(parsed).toLowerCase() !== hash.toLowerCase()) return { status: 'mismatch' }

  return { status: 'found', document: parsed as T }
}

/**
 * Accept a document somebody pasted, for the hash the chain names.
 *
 * The freelancer opening a shared link has no local copy of the criteria the client wrote, and
 * until there is a shared store that is simply true. Pasting is the honest escape hatch, and it
 * is safe precisely because the hash decides: a wrong paste is rejected rather than believed.
 */
export function acceptPastedDocument(hash: string, json: string): DocumentLookup<unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { status: 'mismatch' }
  }
  if (hashJson(parsed).toLowerCase() !== hash.toLowerCase()) return { status: 'mismatch' }
  putDocument(parsed)
  return { status: 'found', document: parsed }
}
