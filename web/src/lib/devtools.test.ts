/**
 * The presenter panel's two promises, made executable.
 *
 * **1. The latch behaves like a latch.** Wrong string stays shut, right string opens, `lock`
 * closes it again, and with no session storage at all it reports shut rather than throwing.
 *
 * **2. The fixtures cannot lie about money.** `Escrow`'s constructor reverts
 * `FundingMismatch(sum, msg.value)` on a one-wei difference — *after* the transaction is signed
 * and the gas is paid. A demo fixture whose split does not add to its stated total is therefore
 * a guaranteed on-stage failure, so the sum is asserted here, in wei, with the app's own parser
 * checking the MON column against it.
 *
 * There is also a source-level assertion that this module reaches nothing: no `fetch`, no
 * `process.env`, no server. That property is the whole justification for a password that lives
 * in a public bundle, and a property that load-bearing should be checked rather than promised.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseMon } from '@/components/MilestoneEditor'
import {
  DEMO_ADDRESSES,
  DEMO_BRIEF,
  DEMO_CRITERIA,
  DEMO_EVIDENCE,
  DEMO_MILESTONES,
  DEMO_TOTAL_MON,
  DEMO_TOTAL_WEI,
  DEVTOOLS_PASSPHRASE,
  escrowFromPath,
  isUnlocked,
  lock,
  slowEquals,
  unlock,
} from '@/lib/devtools'

/* ------------------------------------------------------------------ a stand-in for the tab */

/**
 * Installed with `defineProperty` rather than assignment.
 *
 * `globalThis.sessionStorage` is typed as the DOM `Storage`, whose `[name: string]: any` index
 * signature nothing hand-written satisfies — assigning would need a cast, and a cast to silence
 * the compiler is exactly what this codebase does not do. `defineProperty` sidesteps the whole
 * question, and `deleteProperty` puts the environment back the way it was found.
 */
function installSession(): Map<string, string> {
  const cells = new Map<string, string>()
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string): string | null => cells.get(key) ?? null,
      setItem: (key: string, value: string): void => void cells.set(key, value),
      removeItem: (key: string): void => void cells.delete(key),
    },
  })
  return cells
}

function removeSession(): void {
  Reflect.deleteProperty(globalThis, 'sessionStorage')
}

afterEach(removeSession)

/* ------------------------------------------------------------------ the latch */

describe('the latch', () => {
  it('does not open for the wrong string', () => {
    installSession()
    for (const wrong of ['', 'rahman', 'rahmannn', 'Rahmann', 'RAHMANN', ' rahmann', 'rahmann ']) {
      expect(unlock(wrong), `"${wrong}" must not open the panel`).toBe(false)
      expect(isUnlocked()).toBe(false)
    }
  })

  it('opens for the right string and stays open for the tab', () => {
    installSession()
    expect(isUnlocked()).toBe(false)
    expect(unlock(DEVTOOLS_PASSPHRASE)).toBe(true)
    expect(isUnlocked()).toBe(true)
    // Still open on a second read — the latch is stored, not a one-shot return value.
    expect(isUnlocked()).toBe(true)
  })

  it('lock() clears it', () => {
    const cells = installSession()
    unlock(DEVTOOLS_PASSPHRASE)
    expect(isUnlocked()).toBe(true)

    lock()

    expect(isUnlocked()).toBe(false)
    // Cleared, not merely overwritten with a falsy marker — nothing is left behind in the tab.
    expect(cells.size).toBe(0)
  })

  it('holds the latch in session storage, so it dies with the tab', () => {
    const cells = installSession()
    unlock(DEVTOOLS_PASSPHRASE)
    expect(cells.size).toBe(1)

    // A fresh tab is a fresh store. The same module then reports shut.
    installSession()
    expect(isUnlocked()).toBe(false)
  })

  it('reports shut, rather than throwing, where there is no session storage', () => {
    removeSession()
    expect(isUnlocked()).toBe(false)
    // `unlock` still answers truthfully about the string; it simply cannot remember the answer.
    expect(unlock('wrong')).toBe(false)
    expect(unlock(DEVTOOLS_PASSPHRASE)).toBe(true)
    expect(isUnlocked()).toBe(false)
    expect(() => lock()).not.toThrow()
  })

  it('reports shut when reading storage throws, which some browsers do', () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get(): never {
        throw new Error('storage is disabled for this origin')
      },
    })
    expect(isUnlocked()).toBe(false)
    expect(() => unlock(DEVTOOLS_PASSPHRASE)).not.toThrow()
    expect(() => lock()).not.toThrow()
  })
})

describe('slowEquals', () => {
  it('agrees with === on equality', () => {
    const pairs: readonly (readonly [string, string])[] = [
      ['', ''],
      ['a', 'a'],
      ['rahmann', 'rahmann'],
      ['', 'a'],
      ['a', ''],
      ['rahmann', 'rahmanm'],
      ['rahmann', 'rahmann '],
      ['rahmann', 'Rahmann'],
      ['ab', 'ba'],
    ]
    for (const [a, b] of pairs) {
      expect(slowEquals(a, b), `${JSON.stringify([a, b])}`).toBe(a === b)
    }
  })

  it('is not fooled by a shared prefix of a different length', () => {
    expect(slowEquals('rahmann', 'rahmannn')).toBe(false)
    expect(slowEquals('rahmannn', 'rahmann')).toBe(false)
  })

  it('reads a NUL character as a character, not as a missing one', () => {
    // charCodeAt past the end is NaN and folds in as 0; a real NUL is also 0. The length seed
    // is what keeps those two apart, and this is the case that proves it.
    expect(slowEquals('a\0', 'a')).toBe(false)
    expect(slowEquals('a', 'a\0')).toBe(false)
    expect(slowEquals('a\0', 'a\0')).toBe(true)
  })
})

/* ------------------------------------------------------------------ the money */

describe('the demo split', () => {
  it('sums to the stated total, exactly, in wei', () => {
    let sum = 0n
    for (const milestone of DEMO_MILESTONES) sum += BigInt(milestone.amountWei)
    expect(sum).toBe(BigInt(DEMO_TOTAL_WEI))
  })

  it('states the same amounts in MON and in wei', () => {
    for (const milestone of DEMO_MILESTONES) {
      const parsed = parseMon(milestone.amountMon)
      expect(parsed.ok, `${milestone.title}: "${milestone.amountMon}" must parse`).toBe(true)
      if (!parsed.ok) continue
      expect(parsed.wei.toString(), milestone.title).toBe(milestone.amountWei)
    }

    const total = parseMon(DEMO_TOTAL_MON)
    expect(total.ok).toBe(true)
    if (total.ok) expect(total.wei.toString()).toBe(DEMO_TOTAL_WEI)
  })

  it('has no milestone the contract would reject on its amount', () => {
    expect(DEMO_MILESTONES.length).toBeGreaterThan(0)
    // `Escrow` reverts ZeroMilestoneAmount, and MAX_MILESTONES is 20.
    expect(DEMO_MILESTONES.length).toBeLessThanOrEqual(20)
    for (const milestone of DEMO_MILESTONES) {
      expect(BigInt(milestone.amountWei) > 0n, milestone.title).toBe(true)
    }
  })
})

/* ------------------------------------------------------------------ the documents */

describe('the criteria fixtures', () => {
  it('cover all three check kinds, each carrying only its own block', () => {
    expect(Object.keys(DEMO_CRITERIA).sort()).toEqual(['clientApproval', 'github', 'http'])

    expect(DEMO_CRITERIA.clientApproval.http).toBeUndefined()
    expect(DEMO_CRITERIA.clientApproval.github).toBeUndefined()

    expect(DEMO_CRITERIA.http.http).toBeDefined()
    expect(DEMO_CRITERIA.http.github).toBeUndefined()

    expect(DEMO_CRITERIA.github.github).toBeDefined()
    expect(DEMO_CRITERIA.github.http).toBeUndefined()
  })

  it('keeps every milestone’s criteria block in step with its check kind', () => {
    for (const milestone of DEMO_MILESTONES) {
      expect(milestone.criteria.check, milestone.title).toBe(milestone.check)
      expect(milestone.criteria.title.length, milestone.title).toBeGreaterThan(0)
      if (milestone.check === 'http') {
        expect(milestone.criteria.http, milestone.title).toBeDefined()
        expect(milestone.criteria.github, milestone.title).toBeUndefined()
      }
      if (milestone.check === 'github') {
        expect(milestone.criteria.github, milestone.title).toBeDefined()
        expect(milestone.criteria.http, milestone.title).toBeUndefined()
      }
      if (milestone.check === 'clientApproval') {
        expect(milestone.criteria.http, milestone.title).toBeUndefined()
        expect(milestone.criteria.github, milestone.title).toBeUndefined()
      }
    }
  })

  it('has an evidence object with a frozen timestamp, so two runs hash the same', () => {
    expect(DEMO_EVIDENCE.v).toBe(1)
    expect(DEMO_EVIDENCE.submittedAt).toBe(1_760_000_000)
    expect(JSON.stringify(DEMO_EVIDENCE)).toBe(JSON.stringify(DEMO_EVIDENCE))
  })
})

describe('the demo addresses', () => {
  it('are four distinct, well-formed addresses', () => {
    expect(DEMO_ADDRESSES.length).toBe(4)
    const seen = new Set<string>()
    for (const party of DEMO_ADDRESSES) {
      expect(party.address, party.role).toMatch(/^0x[0-9a-fA-F]{40}$/)
      seen.add(party.address.toLowerCase())
    }
    expect(seen.size).toBe(4)
  })

  it('never puts the client and the freelancer on the same wallet', () => {
    // `Escrow` reverts ClientIsFreelancer, which would make the demo fail at the create step.
    const client = DEMO_ADDRESSES.find((p) => p.role === 'Client')
    const freelancer = DEMO_ADDRESSES.find((p) => p.role === 'Freelancer')
    expect(client).toBeDefined()
    expect(freelancer).toBeDefined()
    expect(client?.address.toLowerCase()).not.toBe(freelancer?.address.toLowerCase())
  })
})

describe('the brief', () => {
  it('is long enough to be worth splitting and short enough to read on stage', () => {
    expect(DEMO_BRIEF.length).toBeGreaterThan(120)
    expect(DEMO_BRIEF.length).toBeLessThan(600)
  })
})

/* ------------------------------------------------------------------ escrowFromPath */

describe('escrowFromPath', () => {
  const escrow = '0x1111111111111111111111111111111111111111'

  it('finds the escrow on a job route', () => {
    expect(escrowFromPath(`/job/${escrow}`)).toBe(escrow)
    expect(escrowFromPath(`/job/${escrow}/`)).toBe(escrow)
  })

  it('preserves the case it was given, because addresses are checksummed', () => {
    const mixed = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
    expect(escrowFromPath(`/job/${mixed}`)).toBe(mixed)
  })

  it('finds nothing anywhere else', () => {
    for (const path of [
      '/',
      '/new',
      '/actions',
      '/wallet',
      '/progress',
      '/job',
      '/job/',
      '/job/not-an-address',
      `/job/${escrow.slice(0, -1)}`,
      `/jobs/${escrow}`,
      `/x/job/${escrow}`,
    ]) {
      expect(escrowFromPath(path), path).toBeNull()
    }
  })
})

/* ------------------------------------------------------------------ the standing promise */

/**
 * The panel's password is in a public bundle. That is only acceptable while the panel grants no
 * capability its user does not already have — which in turn is only true while this module
 * reaches nothing. So: read its own source and check.
 *
 * Source-level rather than behavioural on purpose. A behavioural test proves the paths it
 * happens to run; this proves the tokens are not in the file at all, which is the claim the
 * header actually makes.
 */
describe('devtools.ts reaches nothing', () => {
  const source = readFileSync(join(__dirname, 'devtools.ts'), 'utf8')

  /** Comments talk about `fetch` and `process.env`, so scan the code with the prose removed. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('never reads the environment', () => {
    expect(code).not.toMatch(/process\s*\.\s*env/)
    expect(code).not.toMatch(/\bprocess\b/)
  })

  it('never reaches the network', () => {
    for (const forbidden of [
      /\bfetch\s*\(/,
      /XMLHttpRequest/,
      /sendBeacon/,
      /WebSocket/,
      /EventSource/,
      /navigator\s*\.\s*(?!clipboard)/,
      /import\s*\(/,
      /require\s*\(/,
    ]) {
      expect(code, `${forbidden} must not appear in devtools.ts`).not.toMatch(forbidden)
    }
  })

  it('imports only types and nothing that could', () => {
    const imports = [...code.matchAll(/^import\s+([\s\S]*?)\s+from\s+'([^']+)'/gm)]
    expect(imports.length).toBe(1)
    expect(imports[0][1].startsWith('type ')).toBe(true)
    expect(imports[0][2]).toBe('@/lib/verify/types')
  })

  it('is deterministic — no clock and no randomness', () => {
    expect(code).not.toMatch(/Date\s*\.\s*now/)
    expect(code).not.toMatch(/new\s+Date\b/)
    expect(code).not.toMatch(/Math\s*\.\s*random/)
    expect(code).not.toMatch(/crypto\s*\./)
  })

  it('signs nothing and sends nothing', () => {
    for (const forbidden of [
      /privateKey/i,
      /\bsignMessage\b/,
      /signTypedData/,
      /sendTransaction/,
      /writeContract/,
      /walletClient/i,
    ]) {
      expect(code, `${forbidden} must not appear in devtools.ts`).not.toMatch(forbidden)
    }
  })
})
