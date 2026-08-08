/**
 * Canonical JSON — the single serialiser behind every hash in C3, C4 and C5.
 *
 * The hash is the whole point: `criteriaHash` and `evidenceHash` are committed on-chain and
 * neither party can change what they point at afterwards. That only holds if both sides
 * serialise identically, so this is the one implementation and nothing hand-rolls its own.
 *
 * **Deviation from C3, raised deliberately.** C3 says "keys in the order above". That is not
 * implementable without a per-schema order table that has to be kept in step with every
 * future field, and a table that drifts changes the hash silently — which is exactly the
 * failure this hash exists to prevent. Keys are therefore sorted lexicographically at every
 * level, the rule used by RFC 8785 / JCS. Nothing is lost: the only two consumers are the
 * frontend that writes the criteria and the verifier that reads them, both of which call
 * this function.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

/**
 * Deterministic JSON: sorted keys, no whitespace, `undefined` members dropped.
 *
 * `undefined` is dropped rather than encoded because C3's optional blocks are expressed by
 * omission — an object carrying `github: undefined` must hash the same as one that never
 * mentioned github at all, or an http-only criteria set would hash differently depending on
 * which form built it.
 */
export function canonicalJson(value: unknown): string {
  return stringify(value)
}

function stringify(value: unknown): string {
  if (value === null) return 'null'

  const t = typeof value
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'string') return JSON.stringify(value)

  if (t === 'number') {
    // NaN and Infinity have no JSON form; JSON.stringify would emit `null` and two different
    // broken values would hash the same. Refuse instead.
    if (!Number.isFinite(value as number)) {
      throw new TypeError(`canonicalJson: ${String(value)} has no JSON representation`)
    }
    return JSON.stringify(value)
  }

  if (t === 'bigint') {
    // Amounts are wei and travel as decimal strings (C7). Serialising a bigint silently as a
    // number would lose precision above 2^53, so make the caller choose.
    throw new TypeError('canonicalJson: bigint must be converted to a decimal string first')
  }

  if (Array.isArray(value)) {
    // Array order is meaningful and is preserved. `undefined` cannot be dropped from an
    // array without shifting every later index, so it becomes null, as JSON.stringify does.
    return `[${value.map((v) => (v === undefined ? 'null' : stringify(v))).join(',')}]`
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>
    const parts: string[] = []
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key]
      if (v === undefined) continue
      parts.push(`${JSON.stringify(key)}:${stringify(v)}`)
    }
    return `{${parts.join(',')}}`
  }

  throw new TypeError(`canonicalJson: cannot serialise ${t}`)
}

export type { Json }
