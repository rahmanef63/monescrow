import { describe, expect, it } from 'vitest'
import { runHttpCheck } from './http'
import type { CheckResult, Criteria, FetchImpl } from '../types'

// ---------------------------------------------------------------------------
// Fakes. Nothing in this file touches the network; `fetchImpl` is always one of
// these, so a green run here says nothing about anyone's DNS.
// ---------------------------------------------------------------------------

function criteria(http: Partial<NonNullable<Criteria['http']>> = {}): Criteria {
  return {
    v: 1,
    title: 'Landing page is up',
    check: 'http',
    http: {
      url: 'https://example.test/',
      expectStatus: 200,
      mustContain: [],
      mustNotContain: [],
      timeoutMs: 5000,
      ...http,
    },
  }
}

/** A server that answers with the given status and body. */
function respondWith(status: number, body: string): FetchImpl {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  })
}

/** Headers arrive, then the body read fails — a connection dropped mid-transfer. */
function bodyUnreadable(status: number, err: unknown): FetchImpl {
  return async () => ({
    ok: true,
    status,
    headers: { get: () => null },
    text: async () => {
      throw err
    },
  })
}

/** Never answers; only settles when the caller's AbortController fires. */
const neverAnswers: FetchImpl = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal
    if (!signal) return
    signal.addEventListener('abort', () => {
      const err = new Error('This operation was aborted')
      err.name = 'AbortError'
      reject(err)
    })
  })

/** A clock that returns each reading in turn, then sticks on the last one. */
function clock(readings: number[]): () => number {
  let i = 0
  return () => readings[Math.min(i++, readings.length - 1)]
}

function byId(checks: CheckResult[], id: string): CheckResult {
  const found = checks.find((c) => c.id === id)
  if (!found) throw new Error(`no check with id ${id}; got ${checks.map((c) => c.id).join(', ')}`)
  return found
}

/** Narrows to the ran branch, failing loudly instead of silently skipping assertions. */
function ran(outcome: { kind: string }): CheckResult[] {
  if (outcome.kind !== 'ran') {
    throw new Error(`expected a ran outcome, got ${JSON.stringify(outcome)}`)
  }
  return (outcome as { kind: 'ran'; checks: CheckResult[] }).checks
}

describe('runHttpCheck — status', () => {
  // The agreement is an exact status. 200 when 200 was agreed is the only pass; this is what
  // the whole check hangs off, so it is asserted on its own.
  it('passes when the status equals expectStatus exactly', async () => {
    const out = await runHttpCheck(criteria(), respondWith(200, '<p>hi</p>'), clock([0, 12]))
    expect(byId(ran(out), 'http.status').passed).toBe(true)
  })

  // THE line this service exists to hold: the server answered, so this is a statement about
  // the milestone and must be a signed 422 failure — never a retryable 502.
  it('treats a 500 as a FAILING milestone, not as unreachable', async () => {
    const out = await runHttpCheck(criteria(), respondWith(500, 'boom'), clock([0, 3]))
    expect(out.kind).toBe('ran')
    expect(byId(ran(out), 'http.status').passed).toBe(false)
  })

  // A near miss is still a miss: 301 is not 200, and "close enough" is not something the
  // contract can express.
  it('fails on a status that is merely similar', async () => {
    const out = await runHttpCheck(criteria(), respondWith(301, ''), clock([0, 1]))
    expect(byId(ran(out), 'http.status').passed).toBe(false)
  })

  // The detail is what a human reads when they dispute the result, so it has to name the
  // observed status and the elapsed time rather than just "failed".
  it('reports the observed status and elapsed ms in detail', async () => {
    const out = await runHttpCheck(criteria(), respondWith(503, ''), clock([1000, 1042]))
    const detail = byId(ran(out), 'http.status').detail
    expect(detail).toContain('expected 200')
    expect(detail).toContain('observed 503')
    expect(detail).toContain('42ms')
  })
})

describe('runHttpCheck — rendered text', () => {
  // The phrase is present in what a reader would see.
  it('passes mustContain when the phrase is in the rendered text', async () => {
    const out = await runHttpCheck(
      criteria({ mustContain: ['Pricing'] }),
      respondWith(200, '<html><body><h1>Pricing</h1></body></html>'),
      clock([0, 5]),
    )
    expect(byId(ran(out), 'http.contains.0').passed).toBe(true)
  })

  // Absent means the milestone failed. It also means the detail must admit what this check
  // could not see, because "not found" from a tag stripper is weaker than "not on the page".
  it('fails mustContain when absent, and says what it could not see', async () => {
    const out = await runHttpCheck(
      criteria({ mustContain: ['Pricing'] }),
      respondWith(200, '<html><body><h1>Coming soon</h1></body></html>'),
      clock([0, 5]),
    )
    const c = byId(ran(out), 'http.contains.0')
    expect(c.passed).toBe(false)
    expect(c.detail).toContain('JavaScript')
  })

  // Tags separate words; without inserting a space `<p>one</p><p>two</p>` would read as
  // "onetwo" and a two-word phrase would match across an element boundary that no reader sees.
  it('does not weld adjacent elements into one word', async () => {
    const out = await runHttpCheck(
      criteria({ mustContain: ['onetwo'] }),
      respondWith(200, '<p>one</p><p>two</p>'),
      clock([0, 1]),
    )
    expect(byId(ran(out), 'http.contains.0').passed).toBe(false)
  })

  // Case and whitespace are formatting, not content; the criteria author typing "Ships Free"
  // should match a page that renders "SHIPS\n  FREE".
  it('matches case-insensitively and across collapsed whitespace', async () => {
    const out = await runHttpCheck(
      criteria({ mustContain: ['Ships Free'] }),
      respondWith(200, '<p>SHIPS\n   FREE</p>'),
      clock([0, 1]),
    )
    expect(byId(ran(out), 'http.contains.0').passed).toBe(true)
  })

  // The forbidden phrase is on the page: the milestone failed.
  it('fails notContains when the forbidden phrase is rendered', async () => {
    const out = await runHttpCheck(
      criteria({ mustNotContain: ['Lorem ipsum'] }),
      respondWith(200, '<main><p>Lorem ipsum dolor</p></main>'),
      clock([0, 1]),
    )
    expect(byId(ran(out), 'http.notContains.0').passed).toBe(false)
  })

  it('passes notContains when the phrase is nowhere in the rendered text', async () => {
    const out = await runHttpCheck(
      criteria({ mustNotContain: ['Lorem ipsum'] }),
      respondWith(200, '<main><p>Real copy</p></main>'),
      clock([0, 1]),
    )
    expect(byId(ran(out), 'http.notContains.0').passed).toBe(true)
  })

  // A browser renders neither script nor style bodies. Counting a phrase found there would
  // let a freelancer satisfy "the page says Pricing" with a JavaScript string literal, and
  // would let an unrelated identifier in a bundle trip a mustNotContain.
  it('does not see text that only appears inside <script> or <style>', async () => {
    const html =
      '<html><head><style>.pricing::after{content:"Pricing"}</style>' +
      '<script>var label = "Pricing";</script></head><body><h1>Home</h1></body></html>'

    const contains = await runHttpCheck(
      criteria({ mustContain: ['Pricing'] }),
      respondWith(200, html),
      clock([0, 1]),
    )
    expect(byId(ran(contains), 'http.contains.0').passed).toBe(false)

    const notContains = await runHttpCheck(
      criteria({ mustNotContain: ['Pricing'] }),
      respondWith(200, html),
      clock([0, 1]),
    )
    expect(byId(ran(notContains), 'http.notContains.0').passed).toBe(true)
  })

  // A real parser swallows everything after an unclosed <script> to EOF, so we do too —
  // otherwise raw JavaScript would leak into what we call "rendered text".
  it('drops to end of document after an unclosed <script>', async () => {
    const out = await runHttpCheck(
      criteria({ mustContain: ['Pricing'] }),
      respondWith(200, '<body><h1>Home</h1><script>var t = "Pricing";'),
      clock([0, 1]),
    )
    expect(byId(ran(out), 'http.contains.0').passed).toBe(false)
  })

  // The reader sees "Tom & Jerry"; the bytes say "Tom &amp; Jerry". Comparing against raw
  // HTML would fail a milestone that a human would look at and call done.
  it('counts entity-encoded text as rendered', async () => {
    const out = await runHttpCheck(
      criteria({ mustContain: ['Tom & Jerry — 50% off'] }),
      respondWith(200, '<p>Tom&nbsp;&amp; Jerry &mdash; 50&#37; off</p>'),
      clock([0, 1]),
    )
    expect(byId(ran(out), 'http.contains.0').passed).toBe(true)
  })

  // Entities are decoded once, after tags are stripped. Decoding first would turn the literal
  // text `<script>` printed on a page into a tag we then deleted — so a page that visibly
  // shows `<script>alert(1)</script>` would look empty.
  it('does not re-decode into markup: printed &lt;script&gt; stays visible text', async () => {
    const out = await runHttpCheck(
      criteria({ mustContain: ['<script>alert(1)</script>'] }),
      respondWith(200, '<pre>&lt;script&gt;alert(1)&lt;/script&gt;</pre>'),
      clock([0, 1]),
    )
    expect(byId(ran(out), 'http.contains.0').passed).toBe(true)
  })

  // Comments are not rendered, and letting them count would make an HTML comment a way to
  // satisfy a criterion nobody can see.
  it('ignores HTML comments', async () => {
    const out = await runHttpCheck(
      criteria({ mustContain: ['secret'] }),
      respondWith(200, '<body><!-- secret --><p>visible</p></body>'),
      clock([0, 1]),
    )
    expect(byId(ran(out), 'http.contains.0').passed).toBe(false)
  })

  // Every phrase gets its own line with its own id. Sharing one id would make two rows of the
  // hashed report indistinguishable to whoever reads it later, including an arbiter.
  it('emits one uniquely identified check per phrase, in order', async () => {
    const out = await runHttpCheck(
      criteria({ mustContain: ['alpha', 'beta'], mustNotContain: ['gamma'] }),
      respondWith(200, '<p>alpha</p>'),
      clock([0, 1]),
    )
    const checks = ran(out)
    expect(checks.map((c) => c.id)).toEqual([
      'http.status',
      'http.contains.0',
      'http.contains.1',
      'http.notContains.0',
    ])
    expect(new Set(checks.map((c) => c.id)).size).toBe(checks.length)
    expect(byId(checks, 'http.contains.0').passed).toBe(true)
    expect(byId(checks, 'http.contains.1').passed).toBe(false)
    expect(byId(checks, 'http.notContains.0').passed).toBe(true)
  })
})

describe('runHttpCheck — unreachable is ours, never the freelancer’s', () => {
  // A name that does not resolve tells us nothing about the milestone. Signing this as a
  // failure would record our own network trouble on-chain as somebody's work being undone.
  it('returns unreachable when fetch rejects (DNS-style)', async () => {
    const dns = new Error('fetch failed')
    dns.cause = { code: 'ENOTFOUND' }
    const out = await runHttpCheck(
      criteria({ url: 'https://nope.invalid/' }),
      async () => {
        throw dns
      },
      clock([0]),
    )
    expect(out.kind).toBe('unreachable')
    if (out.kind !== 'unreachable') throw new Error('unreachable')
    expect(out.reason).toContain('nope.invalid')
    expect(out.reason).toContain('ENOTFOUND')
  })

  // A rejecting fetch must never escape as an exception: an unhandled throw in the route
  // becomes a 500 with no report, which is neither of the two answers C6 allows here.
  it('never lets a thrown fetch escape as an exception', async () => {
    await expect(
      runHttpCheck(
        criteria(),
        () => {
          throw new Error('connect ECONNREFUSED')
        },
        clock([0]),
      ),
    ).resolves.toMatchObject({ kind: 'unreachable' })
  })

  // Our own timer firing is our impatience, not the freelancer's fault. It has to be
  // unreachable so the caller retries rather than the milestone being marked failed.
  it('returns unreachable when our own timeout aborts the request', async () => {
    const out = await runHttpCheck(criteria({ timeoutMs: 5 }), neverAnswers, clock([0]))
    expect(out.kind).toBe('unreachable')
    if (out.kind !== 'unreachable') throw new Error('unreachable')
    expect(out.reason).toContain('timed out after 5ms')
  })

  // Headers arrived and we know the status — but a truncated body is an incomplete
  // observation caused by the transport. Grading the half-read page would let a dropped
  // connection be signed as a failing milestone.
  it('returns unreachable when the body cannot be read, even though a status was seen', async () => {
    const out = await runHttpCheck(
      criteria({ expectStatus: 200 }),
      bodyUnreadable(200, new Error('terminated')),
      clock([0]),
    )
    expect(out.kind).toBe('unreachable')
    if (out.kind !== 'unreachable') throw new Error('unreachable')
    expect(out.reason).toContain('terminated')
  })

  // Same rule when the status was already wrong: in doubt it is unreachable, because the 502
  // costs a retry and the 422 costs somebody their money.
  it('prefers unreachable over a fail when the body is unreadable behind a 500', async () => {
    const out = await runHttpCheck(
      criteria(),
      bodyUnreadable(500, new Error('socket hang up')),
      clock([0]),
    )
    expect(out.kind).toBe('unreachable')
  })

  // Non-Error throws exist in the wild (a bare string, an object). The reason still has to be
  // something a human on call can read, not "[object Object]".
  it('describes a non-Error rejection legibly', async () => {
    const out = await runHttpCheck(
      criteria(),
      async () => {
        throw 'rate limited'
      },
      clock([0]),
    )
    if (out.kind !== 'unreachable') throw new Error('expected unreachable')
    expect(out.reason).toContain('rate limited')
  })
})

describe('runHttpCheck — malformed input is a programming error', () => {
  // C6 makes the route validate the body and answer 400. If a criteria object with no http
  // block reaches this function, our own wiring is broken — and a broken wire must not be
  // laundered into either a failing milestone (422) or a retry (502).
  it('throws a TypeError when the http block is missing', async () => {
    const noHttp: Criteria = { v: 1, title: 'Repo has a tagged commit', check: 'github' }
    await expect(runHttpCheck(noHttp, respondWith(200, ''), clock([0]))).rejects.toBeInstanceOf(
      TypeError,
    )
    await expect(runHttpCheck(noHttp, respondWith(200, ''), clock([0]))).rejects.toThrow(
      /criteria\.http is missing/,
    )
  })
})

describe('runHttpCheck — request shape', () => {
  // The timeout is honoured through a controller this function owns, and the signal really
  // reaches the fetch. Without the signal being passed, the timeout above would be decorative.
  it('passes an AbortSignal and a GET to fetchImpl', async () => {
    let sawSignal: AbortSignal | undefined
    let sawMethod: string | undefined
    let sawUrl: string | undefined

    await runHttpCheck(
      criteria({ url: 'https://example.test/pricing' }),
      async (input, init) => {
        sawUrl = input
        sawMethod = init?.method
        sawSignal = init?.signal
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => '' }
      },
      clock([0, 1]),
    )

    expect(sawUrl).toBe('https://example.test/pricing')
    expect(sawMethod).toBe('GET')
    expect(sawSignal).toBeInstanceOf(AbortSignal)
    expect(sawSignal?.aborted).toBe(false)
  })

  // A passing run must not leave a pending timer holding the process open, and must not abort
  // after the fact — the next thing the route does is sign, and it should not be racing a timer.
  it('clears its timeout once the response has been read', async () => {
    let sawSignal: AbortSignal | undefined
    await runHttpCheck(
      criteria({ timeoutMs: 1 }),
      async (_input, init) => {
        sawSignal = init?.signal
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'ok' }
      },
      clock([0, 1]),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(sawSignal?.aborted).toBe(false)
  })
})
