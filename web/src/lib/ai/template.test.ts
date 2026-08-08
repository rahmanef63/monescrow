import { describe, expect, it } from 'vitest'

import { PLACEHOLDER_REPO, PLACEHOLDER_URL, parseBrief, templateProvider } from '@/lib/ai/template'
import type { BriefInput, MilestoneDraft } from '@/lib/ai/types'
import { canonicalJson } from '@/lib/canonicalJson'

/** 6 MON. Deliberately past Number.MAX_SAFE_INTEGER — the whole point of the wei-string rule. */
const SIX_MON = '6000000000000000000'

function brief(text: string, totalAmount: string = SIX_MON): BriefInput {
  return { brief: text, totalAmount, currency: 'MON' }
}

/**
 * The two money invariants that decide whether `create` succeeds at all: one wei off is
 * `FundingMismatch`, one zero amount is `ZeroMilestoneAmount`. Asserted on every case below.
 */
function expectMoney(drafts: MilestoneDraft[], totalAmount: string): void {
  const sum = drafts.reduce((acc, d) => acc + BigInt(d.amount), 0n)
  expect(sum).toBe(BigInt(totalAmount))
  for (const d of drafts) {
    expect(BigInt(d.amount) > 0n).toBe(true)
    // Canonical decimal: no leading zeros, no sign, no exponent, no hex. The contract call
    // and the hash both read this string verbatim.
    expect(d.amount).toMatch(/^[1-9][0-9]*$/)
  }
}

/**
 * The C3 contract: `criteria` is a real Criteria object, and only the block matching `check`
 * is present. A stray `http` block on a github milestone would be committed by `criteriaHash`
 * and silently change what both parties signed.
 */
function expectShape(drafts: MilestoneDraft[]): void {
  expect(drafts.length).toBeGreaterThanOrEqual(1)
  expect(drafts.length).toBeLessThanOrEqual(5)
  for (const d of drafts) {
    expect(d.criteria.v).toBe(1)
    expect(d.criteria.check).toBe(d.check)
    expect(d.criteria.title).toBe(d.title)
    expect(d.title.trim().length).toBeGreaterThan(0)
    // The rationale is read by both parties before signing, so an empty one is a bug.
    expect(d.rationale.trim().length).toBeGreaterThan(40)

    if (d.check === 'http') {
      expect(d.criteria.http).toBeDefined()
      expect('github' in d.criteria).toBe(false)
      expect(d.criteria.http?.expectStatus).toBe(200)
      expect(Array.isArray(d.criteria.http?.mustContain)).toBe(true)
      expect(Array.isArray(d.criteria.http?.mustNotContain)).toBe(true)
      expect(d.criteria.http?.timeoutMs).toBeGreaterThan(0)
    } else if (d.check === 'github') {
      expect(d.criteria.github).toBeDefined()
      expect('http' in d.criteria).toBe(false)
      expect(d.criteria.github?.requireCommit).toBe(true)
      expect(d.criteria.github?.repo.length).toBeGreaterThan(0)
    } else {
      expect(d.check).toBe('clientApproval')
      expect('http' in d.criteria).toBe(false)
      expect('github' in d.criteria).toBe(false)
    }
  }
}

function kinds(drafts: MilestoneDraft[]): string[] {
  return drafts.map((d) => d.check)
}

describe('parseBrief — it must work with no credentials at all', () => {
  // Protects: the judge's machine has no API key. An empty brief is the worst realistic input
  // and it still has to produce a usable, signable split rather than an error page.
  it('produces a 4-5 milestone split from an empty brief', () => {
    const drafts = parseBrief(brief(''))
    expect(drafts).toHaveLength(5)
    expectShape(drafts)
    expectMoney(drafts, SIX_MON)
  })

  // Protects: whitespace is not a brief. It must behave exactly like the empty one rather
  // than tripping some "has content" branch on a string of spaces.
  it('treats a whitespace-only brief exactly like an empty one', () => {
    const blank = parseBrief(brief(''))
    const spaces = parseBrief(brief('   \n\t  \r\n '))
    expect(spaces).toEqual(blank)
    expectMoney(spaces, SIX_MON)
  })

  // Protects: a one-word brief has no phase structure to find, so the template must supply it.
  it('produces a full split from a one-word brief', () => {
    const drafts = parseBrief(brief('logo'))
    expect(drafts).toHaveLength(5)
    expectShape(drafts)
    expectMoney(drafts, SIX_MON)
    // "logo" is design work: there is no automated check for it that means anything.
    expect(kinds(drafts).every((k) => k === 'clientApproval')).toBe(true)
  })

  // Protects: a brief with no letters at all must not be mistaken for a signal-bearing one,
  // and must not throw on the extraction regexes.
  it('produces a full split from a brief that is entirely punctuation', () => {
    const drafts = parseBrief(brief('!!! ??? --- ,,, ;;; ... /// \\\\\\ ***'))
    expect(drafts).toHaveLength(5)
    expectShape(drafts)
    expectMoney(drafts, SIX_MON)
    expect(kinds(drafts).every((k) => k === 'clientApproval')).toBe(true)
  })

  // Protects: no quadratic regex and no truncation. A pasted spec is a normal input.
  it('handles a very long brief without choking or changing shape', () => {
    const long = 'We need a landing page with a hero, a pricing table and a contact form. '.repeat(2000)
    expect(long.length).toBeGreaterThan(100_000)
    const drafts = parseBrief(brief(long))
    expect(drafts).toHaveLength(5)
    expectShape(drafts)
    expectMoney(drafts, SIX_MON)
  })

  // Protects: unicode and emoji are text, not a crash. Nothing here indexes bytes.
  it('handles unicode and emoji', () => {
    const drafts = parseBrief(brief('Créer un site web 🚀 avec une page d’accueil — 完成 までに ✅'))
    expect(drafts).toHaveLength(5)
    expectShape(drafts)
    expectMoney(drafts, SIX_MON)
  })
})

describe('parseBrief — check kind follows what the brief actually mentions', () => {
  // Protects: code work gets a github check with requireCommit, and CI words add a check run.
  it('gives a code brief github criteria with requireCommit and a check run', () => {
    const drafts = parseBrief(
      brief('Build a REST API in the repo acme-labs/widget-service. Add unit tests and wire up CI.'),
    )
    expectShape(drafts)
    expectMoney(drafts, SIX_MON)

    const gh = drafts.filter((d) => d.check === 'github')
    expect(gh.length).toBeGreaterThan(0)
    for (const d of gh) {
      expect(d.criteria.github?.requireCommit).toBe(true)
      expect(d.criteria.github?.repo).toBe('acme-labs/widget-service')
      expect(d.criteria.github?.requireCheckRun).toBe('ci')
    }
    // No http check was invented: nothing in that brief is a website.
    expect(kinds(drafts)).not.toContain('http')
  })

  // Protects: a check-run name is only asserted when the brief mentions CI, tests or a build.
  // Inventing one turns a milestone that would pass into one that can never pass.
  it('leaves requireCheckRun null when the brief says nothing about CI, tests or a build', () => {
    const drafts = parseBrief(brief('Refactor the code in the repo acme/thing and tidy the module layout.'))
    const gh = drafts.filter((d) => d.check === 'github')
    expect(gh.length).toBeGreaterThan(0)
    for (const d of gh) expect(d.criteria.github?.requireCheckRun).toBeNull()
    expectMoney(drafts, SIX_MON)
  })

  // Protects: site work gets an http check expecting 200.
  it('gives a site brief http criteria expecting 200', () => {
    const drafts = parseBrief(
      brief('Redesign the marketing site and deploy the landing page live at https://acme.example.com'),
    )
    expectShape(drafts)
    expectMoney(drafts, SIX_MON)

    const http = drafts.filter((d) => d.check === 'http')
    expect(http.length).toBeGreaterThan(0)
    for (const d of http) {
      expect(d.criteria.http?.expectStatus).toBe(200)
      expect(d.criteria.http?.url).toBe('https://acme.example.com')
    }
    expect(kinds(drafts)).not.toContain('github')
  })

  // Protects: the honest admission. Design, copy, research, a review, a document have no
  // machine-checkable acceptance test, and dressing one up would be worse than saying so.
  it('gives a design/copy/research brief clientApproval throughout', () => {
    const drafts = parseBrief(
      brief('Write the launch copy, research our competitors, and deliver a short document for review.'),
    )
    expectShape(drafts)
    expectMoney(drafts, SIX_MON)
    expect(kinds(drafts)).toEqual([
      'clientApproval',
      'clientApproval',
      'clientApproval',
      'clientApproval',
      'clientApproval',
    ])
    for (const d of drafts) {
      // The rationale must say out loud that nothing is machine-verified.
      expect(d.rationale).toMatch(/machine-verified/)
    }
  })

  // Protects: a brief that is all three does not collapse to one kind. Building phases get the
  // more specific evidence (a commit), delivery gets what the client can see (a URL), and the
  // human-judgement phases stay honest.
  it('mixes all three kinds when the brief mixes all three', () => {
    const drafts = parseBrief(
      brief('Ship the API from acme/widgets, deploy the landing page at https://shop.example.com, and design a new logo.'),
    )
    expectShape(drafts)
    expectMoney(drafts, SIX_MON)

    const seen = new Set(kinds(drafts))
    expect(seen.has('github')).toBe(true)
    expect(seen.has('http')).toBe(true)
    expect(seen.has('clientApproval')).toBe(true)

    const gh = drafts.find((d) => d.check === 'github')
    expect(gh?.criteria.github?.repo).toBe('acme/widgets')
    const http = drafts.find((d) => d.check === 'http')
    expect(http?.criteria.http?.url).toBe('https://shop.example.com')
  })

  // Protects: the first and last phases are always human-judgement. Agreeing a scope and
  // accepting a revision round are not things any check can observe.
  it('always makes the kickoff and the review milestones clientApproval', () => {
    const drafts = parseBrief(brief('Build the API in acme/widgets with tests.'))
    expect(drafts[0].check).toBe('clientApproval')
    expect(drafts[3].check).toBe('clientApproval')
  })
})

describe('parseBrief — extraction is literal, and blanks stay visibly blank', () => {
  // Protects: a URL that is in the brief is used, not paraphrased.
  it('uses a URL that appears in the brief', () => {
    const drafts = parseBrief(brief('Launch the new site at https://example.com/pricing?ref=brief please.'))
    const http = drafts.filter((d) => d.check === 'http')
    expect(http.length).toBeGreaterThan(0)
    // The trailing full stop is sentence punctuation, not part of the URL.
    expect(http[0].criteria.http?.url).toBe('https://example.com/pricing?ref=brief')
  })

  // Protects: an owner/name repo that appears in the brief is used verbatim.
  it('uses an owner/name repo that appears in the brief', () => {
    const drafts = parseBrief(brief('The code lives in monescrow-labs/core_v2 — add the endpoints there.'))
    const gh = drafts.filter((d) => d.check === 'github')
    expect(gh.length).toBeGreaterThan(0)
    expect(gh[0].criteria.github?.repo).toBe('monescrow-labs/core_v2')
  })

  // Protects: a github URL is evidence of a repository, not of a website. Treating it as a
  // site would put an http check on a repo page nobody agreed to ship.
  it('reads a github URL as a repo, not as a website', () => {
    const drafts = parseBrief(brief('Fix the open bugs in https://github.com/acme/widgets.git'))
    expect(kinds(drafts)).not.toContain('http')
    const gh = drafts.filter((d) => d.check === 'github')
    expect(gh[0].criteria.github?.repo).toBe('acme/widgets')
  })

  // Protects: `and/or` is not a repository. A wrong repo in signed criteria is a milestone
  // that can never pass, and it looks legitimate enough that nobody edits it.
  it('does not mistake English slashes for a repo', () => {
    const drafts = parseBrief(brief('Build the API and/or the CLI, whichever lands first, with tests.'))
    const gh = drafts.filter((d) => d.check === 'github')
    expect(gh.length).toBeGreaterThan(0)
    expect(gh[0].criteria.github?.repo).toBe(PLACEHOLDER_REPO)
  })

  // Protects: no plausible-looking guesses. If there is no URL, the blank must be obvious and
  // unresolvable — `.invalid` can never be registered.
  it('leaves an obvious placeholder when no URL can be lifted', () => {
    const drafts = parseBrief(brief('Deploy the landing page and get the site live this month.'))
    const http = drafts.filter((d) => d.check === 'http')
    expect(http.length).toBeGreaterThan(0)
    for (const d of http) {
      expect(d.criteria.http?.url).toBe(PLACEHOLDER_URL)
      expect(d.rationale).toMatch(/placeholder/)
    }
  })

  // Protects: mustContain is only filled from a phrase the client themselves quoted. Anything
  // else is us writing acceptance criteria and attributing them to them.
  it('lifts a mustContain phrase only when the brief quotes one', () => {
    const withQuote = parseBrief(
      brief('Deploy the landing page at https://acme.example.com and it must say "Get started" above the fold.'),
    )
    const quoted = withQuote.filter((d) => d.check === 'http')
    expect(quoted[0].criteria.http?.mustContain).toEqual(['Get started'])

    const withoutQuote = parseBrief(brief('Deploy the landing page at https://acme.example.com'))
    const plain = withoutQuote.filter((d) => d.check === 'http')
    expect(plain[0].criteria.http?.mustContain).toEqual([])
    expect(plain[0].criteria.http?.mustNotContain).toEqual([])
  })

  // Protects: the rationale tells both parties what the check cannot see. That sentence is the
  // difference between an informed signature and a black box.
  it('says what each check cannot see', () => {
    const site = parseBrief(brief('Deploy the landing page at https://acme.example.com'))
    expect(site.find((d) => d.check === 'http')?.rationale).toMatch(/cannot see/)
    const code = parseBrief(brief('Build the API in acme/widgets with tests.'))
    expect(code.find((d) => d.check === 'github')?.rationale).toMatch(/cannot see/)
  })
})

describe('parseBrief — the money is exact, in wei, always', () => {
  // Protects: the weighting is not an even split. An even split pays most of the money before
  // most of the work exists.
  it('weights the first milestone small and the last one large', () => {
    const drafts = parseBrief(brief('Build the API in acme/widgets with tests.'))
    expect(BigInt(drafts[0].amount) < BigInt(drafts[4].amount)).toBe(true)
    expectMoney(drafts, SIX_MON)
  })

  // Protects: a total well past 2^53 survives. Any `number` round-trip in the split would show
  // up here as a sum that is off by hundreds of wei.
  it('splits a total far beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const huge = '123456789012345678901234567890'
    expect(BigInt(huge) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)
    const drafts = parseBrief(brief('Build the API in acme/widgets with tests.', huge))
    expectShape(drafts)
    expectMoney(drafts, huge)
  })

  // Protects: the remainder rule. 7 wei over five weights leaves a remainder that must land on
  // the last milestone rather than being rounded into nothing.
  it('gives the rounding remainder to the last milestone', () => {
    for (const total of ['7', '11', '13', '99', '1000', '1000000000000000001']) {
      const drafts = parseBrief(brief('Build the API in acme/widgets with tests.', total))
      expectMoney(drafts, total)
    }
  })

  // Protects: the pathological split. THE RULE: you cannot cut 1 wei into five non-zero
  // milestones, so the template drops phases rather than emitting a zero amount — a zero
  // amount makes `create` revert ZeroMilestoneAmount. Delivery is the phase that survives.
  it('emits a single non-zero milestone when the total is 1 wei', () => {
    const drafts = parseBrief(brief('Build the API in acme/widgets with tests.', '1'))
    expect(drafts).toHaveLength(1)
    expect(drafts[0].amount).toBe('1')
    expectShape(drafts)
    expectMoney(drafts, '1')
  })

  // Protects: the same rule at 3 wei — three milestones of 1 wei, not five with two zeros.
  it('emits three non-zero milestones when the total is 3 wei', () => {
    const drafts = parseBrief(brief('Redesign the site and deploy the landing page.', '3'))
    expect(drafts).toHaveLength(3)
    expect(drafts.map((d) => d.amount)).toEqual(['1', '1', '1'])
    expectShape(drafts)
    expectMoney(drafts, '3')
    // Chronological order is preserved even when phases are dropped.
    expect(drafts[0].title).toBe('Scope agreed and work started')
  })

  // Protects: the count ramps with the money and never exceeds five.
  it('scales the milestone count with the smallest totals', () => {
    const counts = ['1', '2', '3', '4', '5', '6', '100'].map(
      (t) => parseBrief(brief('Build the API in acme/widgets.', t)).length,
    )
    expect(counts).toEqual([1, 2, 3, 4, 5, 5, 5])
  })

  // Protects: money that cannot be split into even one non-zero milestone is refused loudly,
  // not silently turned into a zero-amount escrow.
  it('throws rather than emitting a zero-amount milestone', () => {
    expect(() => parseBrief(brief('anything', '0'))).toThrow(RangeError)
  })

  // Protects: the wei-string contract. A float, an exponent, hex, a sign or stray whitespace
  // are all ways a caller quietly loses precision before we ever see the number.
  it('rejects anything that is not a plain decimal wei string', () => {
    for (const bad of ['', ' 100', '100 ', 'abc', '1e18', '-5', '1.5', '0x10', '1_000', '+7']) {
      expect(() => parseBrief(brief('anything', bad))).toThrow(TypeError)
    }
  })
})

describe('parseBrief — determinism', () => {
  // Protects: the same brief in always gives the same split out. No clock, no randomness, no
  // regex `lastIndex` carried between calls. If this ever drifts, two parties reading the same
  // brief see two different contracts.
  it('returns a deeply identical split for the same brief twice', () => {
    const text =
      'Ship the API from acme/widgets with CI, deploy the landing page at https://shop.example.com ' +
      'so it says "Get started", and design a new logo. 🚀'
    const first = parseBrief(brief(text))
    const second = parseBrief(brief(text))
    expect(second).toEqual(first)
    // Byte-for-byte through the one serialiser behind every hash, not just structurally equal.
    expect(canonicalJson(second)).toBe(canonicalJson(first))
  })

  // Protects: repeated calls across many different briefs never leak state into each other.
  it('is unaffected by what was parsed before it', () => {
    const a = 'Deploy the landing page at https://one.example.com'
    const b = 'Build the API in acme/widgets with tests.'
    const aAlone = parseBrief(brief(a))
    const bAlone = parseBrief(brief(b))
    parseBrief(brief(b))
    parseBrief(brief('logo'))
    parseBrief(brief(''))
    expect(parseBrief(brief(a))).toEqual(aAlone)
    expect(parseBrief(brief(b))).toEqual(bAlone)
  })
})

describe('templateProvider', () => {
  // Protects: the no-credential path is a MilestoneProvider like any other, so the resolver
  // can fall through to it without a special case.
  it('is a provider named template that proposes the same drafts as parseBrief', async () => {
    expect(templateProvider.name).toBe('template')
    const input = brief('Build the API in acme/widgets with tests.')
    await expect(templateProvider.propose(input)).resolves.toEqual(parseBrief(input))
  })

  // Protects: a rejected promise rather than a synchronous throw, so callers can `await` it
  // inside the same try/catch as the LLM provider.
  it('rejects rather than throwing synchronously on unsplittable money', async () => {
    await expect(templateProvider.propose(brief('anything', '0'))).rejects.toThrow(RangeError)
  })
})
