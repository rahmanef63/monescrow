import { describe, expect, it } from 'vitest'
import { formatDuration, formatMon, sameAddress, shortAddress, withGasPadding } from './chain'

describe('formatDuration', () => {
  // The four presets /new offers (D-3). The 90-second one is the demo setting and used to
  // render as "0 hours per milestone" on the screen the camera is pointed at.
  it.each([
    [90, '1 minute 30 seconds'],
    [86_400, '1 day'],   // the 24h preset reads naturally as a day
    [259_200, '3 days'],
    [604_800, '7 days'],
  ])('renders the %i-second preset as %s', (secs, expected) => {
    expect(formatDuration(secs)).toBe(expected)
  })

  // The bounds the contract enforces (D-7). Neither end may render as zero of anything.
  it('renders both contract bounds without collapsing to zero', () => {
    expect(formatDuration(60)).toBe('1 minute')
    expect(formatDuration(2_592_000)).toBe('30 days')
  })

  it('never renders a leading zero unit', () => {
    for (let s = 1; s <= 3600; s += 7) expect(formatDuration(s)).not.toMatch(/^0 /)
    for (const s of [59, 61, 3599, 3601, 86_399, 86_401]) expect(formatDuration(s)).not.toMatch(/^0 /)
  })

  it('singularises', () => {
    expect(formatDuration(1)).toBe('1 second')
    expect(formatDuration(3600)).toBe('1 hour')
    expect(formatDuration(86_400)).toBe('1 day')
    expect(formatDuration(90_000)).toBe('1 day 1 hour')
  })

  it('clamps nonsense rather than printing it', () => {
    expect(formatDuration(0)).toBe('0 seconds')
    expect(formatDuration(-5)).toBe('0 seconds')
  })
})

describe('formatMon', () => {
  it('renders whole and fractional MON without floating point', () => {
    expect(formatMon(10n ** 18n)).toBe('1')
    expect(formatMon(6n * 10n ** 18n)).toBe('6')
    expect(formatMon('1500000000000000000')).toBe('1.5')
    expect(formatMon(1n)).toBe('0')
  })
})

describe('withGasPadding', () => {
  // On Monad the user pays the gas limit, so the padding is money. It must be a real increase
  // and it must never overflow into a number type.
  it('pads by 20 percent and stays a bigint', () => {
    expect(withGasPadding(100_000n)).toBe(120_000n)
    expect(withGasPadding(0n)).toBe(0n)
    expect(typeof withGasPadding(1n)).toBe('bigint')
  })
})

describe('address helpers', () => {
  it('compares case-insensitively, because checksums differ by source', () => {
    expect(sameAddress('0xAbC0000000000000000000000000000000000001', '0xabc0000000000000000000000000000000000001')).toBe(true)
    expect(sameAddress(undefined, '0x1')).toBe(false)
    expect(sameAddress(null, null)).toBe(false)
  })

  it('shortens to something that fits a phone', () => {
    expect(shortAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678')
    expect(shortAddress(undefined)).toBe('')
  })
})
