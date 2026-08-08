import { beforeEach, describe, expect, it } from 'vitest'
import { acceptPastedDocument, getDocument, putDocument } from './documents'
import { hashJson } from '@/lib/verify/report'
import type { Criteria } from '@/lib/verify/types'

/**
 * A `localStorage` stand-in. `documents.ts` degrades to an in-memory map when the real one
 * throws, so exercising it through a working store is the path that actually ships.
 */
function installStorage() {
  const map = new Map<string, string>()
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: storage },
    configurable: true,
    writable: true,
  })
  return map
}

const CRITERIA: Criteria = {
  v: 1,
  title: 'Deployed and reachable',
  check: 'http',
  http: {
    url: 'https://demo.example.com',
    expectStatus: 200,
    mustContain: ['Sign in with Google'],
    mustNotContain: [],
    timeoutMs: 15000,
  },
}

describe('the document cache', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = installStorage()
  })

  it('stores under the document’s own hash and reads it back', () => {
    const hash = putDocument(CRITERIA)
    expect(hash).toBe(hashJson(CRITERIA))
    expect(getDocument<Criteria>(hash)).toEqual({ status: 'found', document: CRITERIA })
  })

  // Key insertion order must not produce a second copy under a second key, or the same
  // agreement would be two different documents depending on who typed it.
  it('is content-addressed, so a reordered object is the same entry', () => {
    putDocument(CRITERIA)
    const reordered = { check: CRITERIA.check, http: CRITERIA.http, title: CRITERIA.title, v: CRITERIA.v }
    expect(putDocument(reordered)).toBe(hashJson(CRITERIA))
    expect(store.size).toBe(1)
  })

  /**
   * The property the whole file exists for. The chain names a hash; anything stored under it
   * that does not re-hash to it is not the agreement, whatever it claims. Returning it as
   * `found` would render an edited document as though both parties had signed it.
   */
  it('refuses a document that does not re-hash to the hash asked for', () => {
    const hash = putDocument(CRITERIA)
    const tampered = { ...CRITERIA, title: 'Deployed and reachable (revised)' }
    store.set('monescrow:doc:' + hash.toLowerCase(), JSON.stringify(tampered))

    expect(getDocument(hash)).toEqual({ status: 'mismatch' })
  })

  it('reports stored-nothing and stored-garbage as different facts', () => {
    expect(getDocument(hashJson(CRITERIA))).toEqual({ status: 'absent' })

    const hash = putDocument(CRITERIA)
    store.set('monescrow:doc:' + hash.toLowerCase(), 'not json at all')
    expect(getDocument(hash)).toEqual({ status: 'mismatch' })
  })

  it('treats a missing or malformed hash as absent rather than throwing', () => {
    for (const bad of [null, undefined, '', '0x', 'deadbeef', '0x' + 'z'.repeat(64)]) {
      expect(getDocument(bad)).toEqual({ status: 'absent' })
    }
  })

  it('is case-insensitive about the hash, because sources disagree on casing', () => {
    const hash = putDocument(CRITERIA)
    expect(getDocument(hash.toUpperCase().replace('0X', '0x')).status).toBe('found')
  })
})

describe('accepting a pasted document', () => {
  beforeEach(() => {
    installStorage()
  })

  // The freelancer opening a shared link has no local copy. Pasting is the honest escape
  // hatch, and it is safe only because the hash decides rather than the person pasting.
  it('accepts a paste that matches the hash on chain', () => {
    const hash = hashJson(CRITERIA)
    expect(acceptPastedDocument(hash, JSON.stringify(CRITERIA))).toEqual({
      status: 'found',
      document: CRITERIA,
    })
    expect(getDocument<Criteria>(hash).status).toBe('found')
  })

  it('rejects a paste that does not, and stores nothing', () => {
    const hash = hashJson(CRITERIA)
    const other = { ...CRITERIA, title: 'Something else entirely' }

    expect(acceptPastedDocument(hash, JSON.stringify(other))).toEqual({ status: 'mismatch' })
    expect(getDocument(hash)).toEqual({ status: 'absent' })
  })

  it('rejects a paste that is not JSON', () => {
    expect(acceptPastedDocument(hashJson(CRITERIA), '{ nope')).toEqual({ status: 'mismatch' })
  })
})
