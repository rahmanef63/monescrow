import { describe, expect, it } from 'vitest'
import { canonicalJson } from './canonicalJson'

describe('canonicalJson', () => {
  // The hash is only meaningful if two parties who typed the same agreement in a different
  // order produce the same bytes.
  it('is independent of key insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('sorts nested keys too', () => {
    expect(canonicalJson({ z: { d: 1, c: 2 } })).toBe('{"z":{"c":2,"d":1}}')
  })

  // C3's optional blocks are expressed by omission, so the two ways of writing "no github
  // block" must hash the same or an http-only criteria set gets two different hashes.
  it('drops undefined members so omission and explicit-undefined agree', () => {
    expect(canonicalJson({ http: 1, github: undefined })).toBe(canonicalJson({ http: 1 }))
  })

  // Array position is data, not ordering noise: mustContain[0] is not interchangeable.
  it('preserves array order', () => {
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]')
  })

  it('emits no whitespace', () => {
    expect(canonicalJson({ a: [1, 2], b: 'x' })).toBe('{"a":[1,2],"b":"x"}')
  })

  // JSON.stringify turns these into null, so two different broken values would hash alike.
  it('refuses values with no JSON form rather than coercing them', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow(/no JSON representation/)
    expect(() => canonicalJson({ a: Infinity })).toThrow(/no JSON representation/)
    expect(() => canonicalJson({ a: 1n })).toThrow(/decimal string/)
  })
})
