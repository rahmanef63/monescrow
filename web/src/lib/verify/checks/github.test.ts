import { describe, expect, it } from 'vitest'
import type { Criteria, FetchImpl } from '../types'
import { runGithubCheck } from './github'

/* ------------------------------------------------------------------ fakes */

type FakeResponse = { status: number; body?: string; headers?: Record<string, string> }
/** Returning an Error makes the fake `fetch` reject, standing in for DNS/socket failure. */
type Handler = (url: string) => FakeResponse | Error

type Call = { url: string; headers: Record<string, string> }

function makeFetch(handler: Handler): { impl: FetchImpl; calls: Call[] } {
  const calls: Call[] = []
  const impl: FetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} })
    const result = handler(url)
    if (result instanceof Error) throw result

    const lower: Record<string, string> = {}
    for (const [k, v] of Object.entries(result.headers ?? {})) lower[k.toLowerCase()] = v

    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
      text: async () => result.body ?? '',
    }
  }
  return { impl, calls }
}

type GithubBlock = NonNullable<Criteria['github']>

function criteria(github: Partial<GithubBlock> = {}): Criteria {
  return {
    v: 1,
    title: 'Ship the parser',
    check: 'github',
    github: {
      repo: 'acme/widget',
      ref: 'abc123',
      requireCommit: false,
      requireCheckRun: null,
      minStars: null,
      ...github,
    },
  }
}

const COMMIT_BODY = JSON.stringify({ sha: 'abc123' })

function checkRunsBody(runs: Array<Record<string, unknown>>): string {
  return JSON.stringify({ total_count: runs.length, check_runs: runs })
}

/** Every response is a 200 with this body, whatever the URL — for header-only assertions. */
function always(res: FakeResponse): Handler {
  return () => res
}

/* ------------------------------------------------------------------ gh.commit */

describe('runGithubCheck — gh.commit', () => {
  // Protects: a reachable commit produces a *ran* outcome with a passing line, and the URL
  // is the one C-contract names. A wrong path here would 404 every honest submission.
  it('passes when the commit endpoint returns 200', async () => {
    const { impl, calls } = makeFetch(always({ status: 200, body: COMMIT_BODY }))

    const outcome = await runGithubCheck(criteria({ requireCommit: true }), impl)

    expect(outcome.kind).toBe('ran')
    if (outcome.kind !== 'ran') return
    expect(outcome.checks).toHaveLength(1)
    expect(outcome.checks[0].id).toBe('gh.commit')
    expect(outcome.checks[0].passed).toBe(true)
    expect(calls[0].url).toBe('https://api.github.com/repos/acme/widget/commits/abc123')
  })

  // Protects the 422 side of the line: a commit that is genuinely absent is the freelancer's
  // problem and must be signable as a failure, never quietly turned into a retry.
  it('fails — not unreachable — when the commit 404s', async () => {
    const { impl } = makeFetch(always({ status: 404, body: '{"message":"Not Found"}' }))

    const outcome = await runGithubCheck(criteria({ requireCommit: true }), impl)

    expect(outcome.kind).toBe('ran')
    if (outcome.kind !== 'ran') return
    expect(outcome.checks[0].passed).toBe(false)
    expect(outcome.checks[0].detail).toContain('404')
  })

  // Protects honesty about what a 200 buys. A reader must not come away thinking the code
  // was reviewed, so the detail states the limit of the observation.
  it('says only that the ref resolves, not that the work is done', async () => {
    const { impl } = makeFetch(always({ status: 200, body: COMMIT_BODY }))

    const outcome = await runGithubCheck(criteria({ requireCommit: true }), impl)

    if (outcome.kind !== 'ran') throw new Error('expected ran')
    expect(outcome.checks[0].detail).toMatch(/not what the commit contains/i)
  })

  // Protects refs with slashes (`feature/x`, `heads/main`): encoding the separator to %2F
  // would ask GitHub for a different resource and 404 correct work.
  it('keeps slashes inside a ref while still encoding each segment', async () => {
    const { impl, calls } = makeFetch(always({ status: 200, body: COMMIT_BODY }))

    await runGithubCheck(criteria({ requireCommit: true, ref: 'feature/a b' }), impl)

    expect(calls[0].url).toBe('https://api.github.com/repos/acme/widget/commits/feature/a%20b')
  })
})

/* ------------------------------------------------------------------ gh.checkRun */

describe('runGithubCheck — gh.checkRun', () => {
  // Protects: only `conclusion === "success"` passes.
  it('passes when the named run concluded success', async () => {
    const { impl, calls } = makeFetch(
      always({
        status: 200,
        body: checkRunsBody([
          { name: 'lint', status: 'completed', conclusion: 'failure' },
          { name: 'ci', status: 'completed', conclusion: 'success' },
        ]),
      }),
    )

    const outcome = await runGithubCheck(criteria({ requireCheckRun: 'ci' }), impl)

    if (outcome.kind !== 'ran') throw new Error('expected ran')
    expect(outcome.checks[0].id).toBe('gh.checkRun')
    expect(outcome.checks[0].passed).toBe(true)
    // per_page=100 is load-bearing: the endpoint's 30-run default could hide the named run.
    expect(calls[0].url).toBe(
      'https://api.github.com/repos/acme/widget/commits/abc123/check-runs?per_page=100',
    )
  })

  // Protects: a completed run with any other conclusion is a failure, and the report says so
  // in words a human can act on.
  it('fails, and says "finished and failed", when the run concluded failure', async () => {
    const { impl } = makeFetch(
      always({
        status: 200,
        body: checkRunsBody([{ name: 'ci', status: 'completed', conclusion: 'failure' }]),
      }),
    )

    const outcome = await runGithubCheck(criteria({ requireCheckRun: 'ci' }), impl)

    if (outcome.kind !== 'ran') throw new Error('expected ran')
    expect(outcome.checks[0].passed).toBe(false)
    expect(outcome.checks[0].detail).toContain('finished and failed')
    expect(outcome.checks[0].detail).not.toContain('not finished yet')
  })

  // Protects the distinction the contract asks for by name: "wait and resubmit" and "fix your
  // build" are different instructions, and the report is the only place they can be told apart.
  it('fails, and says "not finished yet", while the run is still in progress', async () => {
    const { impl } = makeFetch(
      always({
        status: 200,
        body: checkRunsBody([{ name: 'ci', status: 'in_progress', conclusion: null }]),
      }),
    )

    const outcome = await runGithubCheck(criteria({ requireCheckRun: 'ci' }), impl)

    if (outcome.kind !== 'ran') throw new Error('expected ran')
    expect(outcome.checks[0].passed).toBe(false)
    expect(outcome.checks[0].detail).toContain('not finished yet')
    expect(outcome.checks[0].detail).toContain('in_progress')
    expect(outcome.checks[0].detail).not.toContain('finished and failed')
  })

  // Same distinction for the other unfinished state.
  it('treats a queued run as not finished yet', async () => {
    const { impl } = makeFetch(
      always({
        status: 200,
        body: checkRunsBody([{ name: 'ci', status: 'queued', conclusion: null }]),
      }),
    )

    const outcome = await runGithubCheck(criteria({ requireCheckRun: 'ci' }), impl)

    if (outcome.kind !== 'ran') throw new Error('expected ran')
    expect(outcome.checks[0].passed).toBe(false)
    expect(outcome.checks[0].detail).toContain('not finished yet')
    expect(outcome.checks[0].detail).toContain('queued')
  })

  // Protects: an absent run is a failure (GitHub answered; the run simply is not there), and
  // the detail names what *was* there so a typo in the criteria is diagnosable.
  it('fails when no run carries the required name, and lists the runs that were present', async () => {
    const { impl } = makeFetch(
      always({
        status: 200,
        body: checkRunsBody([
          { name: 'build', status: 'completed', conclusion: 'success' },
          { name: 'lint', status: 'completed', conclusion: 'success' },
        ]),
      }),
    )

    const outcome = await runGithubCheck(criteria({ requireCheckRun: 'ci' }), impl)

    if (outcome.kind !== 'ran') throw new Error('expected ran')
    expect(outcome.checks[0].passed).toBe(false)
    expect(outcome.checks[0].detail).toContain('"ci"')
    expect(outcome.checks[0].detail).toContain('"build"')
    expect(outcome.checks[0].detail).toContain('"lint"')
  })

  // Protects: an empty run list is still an answer, so still a failure rather than a retry.
  it('fails when GitHub reports no check runs at all', async () => {
    const { impl } = makeFetch(always({ status: 200, body: checkRunsBody([]) }))

    const outcome = await runGithubCheck(criteria({ requireCheckRun: 'ci' }), impl)

    if (outcome.kind !== 'ran') throw new Error('expected ran')
    expect(outcome.checks[0].passed).toBe(false)
    expect(outcome.checks[0].detail).toMatch(/no check runs at all/i)
  })

  // Protects against silently picking a winner among re-runs: the report admits the choice.
  it('discloses when several runs share the required name', async () => {
    const { impl } = makeFetch(
      always({
        status: 200,
        body: checkRunsBody([
          { name: 'ci', status: 'completed', conclusion: 'success' },
          { name: 'ci', status: 'completed', conclusion: 'failure' },
        ]),
      }),
    )

    const outcome = await runGithubCheck(criteria({ requireCheckRun: 'ci' }), impl)

    if (outcome.kind !== 'ran') throw new Error('expected ran')
    expect(outcome.checks[0].detail).toContain('2 runs share this name')
  })

  // Protects against the worst failure mode in this module: "we did not see it" is only
  // "it is not there" if we saw everything. A run hiding on an unread page must produce a
  // retry, never a signed failure.
  it('is unreachable when the named run is absent but the run list is incomplete', async () => {
    const { impl } = makeFetch(
      always({
        status: 200,
        body: JSON.stringify({
          total_count: 120,
          check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }],
        }),
      }),
    )

    const outcome = await runGithubCheck(criteria({ requireCheckRun: 'ci' }), impl)

    expect(outcome.kind).toBe('unreachable')
    if (outcome.kind !== 'unreachable') return
    expect(outcome.reason).toContain('120')
  })

  // The mirror of the above: when the list is complete, absence really is absence, and the
  // freelancer's missing run must stay a signable failure rather than an endless retry.
  it('still fails when the named run is absent and the list is complete', async () => {
    const { impl } = makeFetch(
      always({
        status: 200,
        body: JSON.stringify({
          total_count: 1,
          check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }],
        }),
      }),
    )

    const outcome = await runGithubCheck(criteria({ requireCheckRun: 'ci' }), impl)

    if (outcome.kind !== 'ran') throw new Error('expected ran')
    expect(outcome.checks[0].passed).toBe(false)
  })

  // Protects the 502 side: a body we cannot read means we never learned the run's state, so
  // we have observed nothing about the work.
  it('is unreachable when the check-runs body has no check_runs array', async () => {
    const { impl } = makeFetch(always({ status: 200, body: '{"total_count":1}' }))

    const outcome = await runGithubCheck(criteria({ requireCheckRun: 'ci' }), impl)

    expect(outcome.kind).toBe('unreachable')
  })
})

/* ------------------------------------------------------------------ gh.stars */

describe('runGithubCheck — gh.stars', () => {
  // Protects the comparison boundary in both directions, including >= at the threshold.
  it('passes at or above the threshold and fails below it', async () => {
    const above = makeFetch(always({ status: 200, body: '{"stargazers_count":100}' }))
    const below = makeFetch(always({ status: 200, body: '{"stargazers_count":99}' }))

    const pass = await runGithubCheck(criteria({ minStars: 100 }), above.impl)
    const fail = await runGithubCheck(criteria({ minStars: 100 }), below.impl)

    if (pass.kind !== 'ran' || fail.kind !== 'ran') throw new Error('expected ran')
    expect(pass.checks[0].id).toBe('gh.stars')
    expect(pass.checks[0].passed).toBe(true)
    expect(fail.checks[0].passed).toBe(false)
    expect(above.calls[0].url).toBe('https://api.github.com/repos/acme/widget')
  })

  // Protects honesty: stars are attention, and the report must not let a reader mistake them
  // for delivered work.
  it('says out loud that a star count is not evidence of work', async () => {
    const { impl } = makeFetch(always({ status: 200, body: '{"stargazers_count":100}' }))

    const outcome = await runGithubCheck(criteria({ minStars: 100 }), impl)

    if (outcome.kind !== 'ran') throw new Error('expected ran')
    expect(outcome.checks[0].detail).toMatch(/not whether the work was done/i)
  })

  // Protects: `minStars: 0` is a real threshold, not "no stars requirement". Falsy-checking
  // it would silently drop the check.
  it('still runs the check when minStars is 0', async () => {
    const { impl, calls } = makeFetch(always({ status: 200, body: '{"stargazers_count":0}' }))

    const outcome = await runGithubCheck(criteria({ minStars: 0 }), impl)

    if (outcome.kind !== 'ran') throw new Error('expected ran')
    expect(calls).toHaveLength(1)
    expect(outcome.checks[0].passed).toBe(true)
  })

  // Protects the 502 side: no readable count means nothing was observed to compare.
  it('is unreachable when stargazers_count is missing', async () => {
    const { impl } = makeFetch(always({ status: 200, body: '{"name":"widget"}' }))

    const outcome = await runGithubCheck(criteria({ minStars: 10 }), impl)

    expect(outcome.kind).toBe('unreachable')
  })
})

/* ------------------------------------------------------------------ the 502 ladder */

describe('runGithubCheck — unreachable, never a failure', () => {
  // THE bug this service must not have: our own rate limit recorded as somebody's milestone
  // being incomplete.
  it('treats a 403 with x-ratelimit-remaining: 0 as unreachable and reports the reset', async () => {
    const { impl } = makeFetch(
      always({
        status: 403,
        body: '{"message":"API rate limit exceeded"}',
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1718000000' },
      }),
    )

    const outcome = await runGithubCheck(criteria({ requireCommit: true }), impl)

    expect(outcome.kind).toBe('unreachable')
    if (outcome.kind !== 'unreachable') return
    // The reset is what tells the caller when a retry is worth attempting.
    expect(outcome.reason).toContain('1718000000')
    expect(outcome.reason).toMatch(/rate limit/i)
  })

  // Protects against a crash-or-misclassify when GitHub omits the reset header: still
  // unreachable, just without retry timing.
  it('treats a rate-limited 403 with no reset header as unreachable', async () => {
    const { impl } = makeFetch(
      always({
        status: 403,
        body: '{"message":"You have exceeded a secondary rate limit"}',
      }),
    )

    const outcome = await runGithubCheck(criteria({ requireCommit: true }), impl)

    expect(outcome.kind).toBe('unreachable')
    if (outcome.kind !== 'unreachable') return
    expect(outcome.reason).toMatch(/rate limit/i)
    expect(outcome.reason).not.toContain('x-ratelimit-reset')
  })

  // Protects the private-repo case named in the contract: we could not look, so we must not
  // judge — a permissions 403 is ours, not the freelancer's.
  it('treats a permissions 403 with no rate-limit signal as unreachable', async () => {
    const { impl } = makeFetch(
      always({ status: 403, body: '{"message":"Resource not accessible by personal access token"}' }),
    )

    const outcome = await runGithubCheck(criteria({ requireCommit: true }), impl)

    expect(outcome.kind).toBe('unreachable')
    if (outcome.kind !== 'unreachable') return
    expect(outcome.reason).toMatch(/permissions/i)
  })

  // Protects: 429 is throttling by definition, whatever the headers say.
  it('treats a 429 as unreachable', async () => {
    const { impl } = makeFetch(
      always({ status: 429, body: 'slow down', headers: { 'x-ratelimit-reset': '999' } }),
    )

    const outcome = await runGithubCheck(criteria({ minStars: 1 }), impl)

    expect(outcome.kind).toBe('unreachable')
    if (outcome.kind !== 'unreachable') return
    expect(outcome.reason).toContain('999')
  })

  // Protects: a rejected credential is our configuration problem. Signing it as a failing
  // milestone would blame the freelancer for our expired token.
  it('treats a 401 as unreachable', async () => {
    const { impl } = makeFetch(always({ status: 401, body: '{"message":"Bad credentials"}' }))

    const outcome = await runGithubCheck(criteria({ requireCommit: true }), impl, 'ghp_secret')

    expect(outcome.kind).toBe('unreachable')
    if (outcome.kind !== 'unreachable') return
    expect(outcome.reason).toContain('401')
  })

  // Protects: GitHub being down is not evidence.
  it('treats a 500 from GitHub as unreachable', async () => {
    const { impl } = makeFetch(always({ status: 500, body: 'boom' }))

    const outcome = await runGithubCheck(criteria({ requireCommit: true }), impl)

    expect(outcome.kind).toBe('unreachable')
  })

  // Protects: a 200 that is not JSON means we are not talking to the API we think we are.
  it('treats an unparseable JSON body as unreachable', async () => {
    const { impl } = makeFetch(always({ status: 200, body: '<html>captive portal</html>' }))

    const outcome = await runGithubCheck(criteria({ requireCommit: true }), impl)

    expect(outcome.kind).toBe('unreachable')
    if (outcome.kind !== 'unreachable') return
    expect(outcome.reason).toMatch(/not valid JSON/i)
  })

  // Protects: DNS/socket failure is ours.
  it('treats a rejected connection as unreachable', async () => {
    const { impl } = makeFetch(() => new Error('getaddrinfo ENOTFOUND api.github.com'))

    const outcome = await runGithubCheck(criteria({ requireCommit: true }), impl)

    expect(outcome.kind).toBe('unreachable')
    if (outcome.kind !== 'unreachable') return
    expect(outcome.reason).toContain('ENOTFOUND')
  })

  // Protects: an unexpected non-2xx we have no rule for defaults to the safe side.
  it('treats an unexpected 418 as unreachable', async () => {
    const { impl } = makeFetch(always({ status: 418, body: 'teapot' }))

    const outcome = await runGithubCheck(criteria({ requireCommit: true }), impl)

    expect(outcome.kind).toBe('unreachable')
  })

  // Protects the conjunction: `passed` is an AND over every check, so one unanswered question
  // must sink the whole outcome instead of quietly reporting a partial verdict.
  it('returns unreachable for the whole run when a later check cannot be answered', async () => {
    const { impl } = makeFetch((url) =>
      url.endsWith('/commits/abc123')
        ? { status: 200, body: COMMIT_BODY }
        : { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
    )

    const outcome = await runGithubCheck(
      criteria({ requireCommit: true, minStars: 1 }),
      impl,
    )

    expect(outcome.kind).toBe('unreachable')
  })
})

/* ------------------------------------------------------------------ requests and the token */

describe('runGithubCheck — requests', () => {
  // Protects the header the API version depends on.
  it('always sends the GitHub Accept header', async () => {
    const { impl, calls } = makeFetch(always({ status: 200, body: COMMIT_BODY }))

    await runGithubCheck(criteria({ requireCommit: true }), impl)

    expect(calls[0].headers['Accept']).toBe('application/vnd.github+json')
  })

  // Protects: no token means no Authorization header at all, rather than `Bearer undefined`.
  it('omits Authorization when no token is supplied', async () => {
    const { impl, calls } = makeFetch(always({ status: 200, body: COMMIT_BODY }))

    await runGithubCheck(criteria({ requireCommit: true }), impl)

    expect(calls[0].headers['Authorization']).toBeUndefined()
  })

  it('sends Bearer authorization when a token is supplied', async () => {
    const { impl, calls } = makeFetch(always({ status: 200, body: COMMIT_BODY }))

    await runGithubCheck(criteria({ requireCommit: true }), impl, 'ghp_secret')

    expect(calls[0].headers['Authorization']).toBe('Bearer ghp_secret')
  })

  // Protects the credential. The report is stored off-chain and shown to both parties, so a
  // token reaching any detail or reason string is a leak — on every path, including the ones
  // that interpolate an error message we did not write.
  it('never lets the token appear in the outcome, on any path', async () => {
    const token = 'ghp_supersecret'
    const responses: Array<FakeResponse | Error> = [
      { status: 200, body: COMMIT_BODY },
      { status: 404 },
      { status: 500, body: `denied for ${token}` },
      { status: 403, body: `rate limit for ${token}`, headers: { 'x-ratelimit-remaining': '0' } },
      { status: 401, body: `bad credentials ${token}` },
      { status: 418, body: `teapot ${token}` },
      { status: 200, body: 'not json at all' },
      new Error(`connect failed while sending ${token}`),
    ]

    for (const response of responses) {
      const { impl } = makeFetch(() => response)
      const outcome = await runGithubCheck(
        criteria({ requireCommit: true, requireCheckRun: 'ci', minStars: 1 }),
        impl,
        token,
      )
      expect(JSON.stringify(outcome)).not.toContain(token)
    }
  })

  // Protects: each check costs an API call against a shared budget, so a check nobody asked
  // for must not be run — and must not appear in the report either.
  it('makes no request and reports no checks when the criteria ask for none', async () => {
    const { impl, calls } = makeFetch(always({ status: 200, body: COMMIT_BODY }))

    const outcome = await runGithubCheck(criteria(), impl)

    expect(calls).toHaveLength(0)
    expect(outcome).toEqual({ kind: 'ran', checks: [] })
  })

  // Protects report completeness and ordering: all three requested checks appear, in a stable
  // order, with the stable ids the UI labels from.
  it('runs every requested check in a stable order', async () => {
    const { impl } = makeFetch((url) => {
      if (url.includes('/check-runs')) {
        return {
          status: 200,
          body: checkRunsBody([{ name: 'ci', status: 'completed', conclusion: 'success' }]),
        }
      }
      if (url.endsWith('/commits/abc123')) return { status: 200, body: COMMIT_BODY }
      return { status: 200, body: '{"stargazers_count":5}' }
    })

    const outcome = await runGithubCheck(
      criteria({ requireCommit: true, requireCheckRun: 'ci', minStars: 5 }),
      impl,
    )

    if (outcome.kind !== 'ran') throw new Error('expected ran')
    expect(outcome.checks.map((c) => c.id)).toEqual(['gh.commit', 'gh.checkRun', 'gh.stars'])
    expect(outcome.checks.every((c) => c.passed)).toBe(true)
  })

  // Protects: a failing check does not abort the rest. The client and the arbiter read one
  // report, and a report that stops at the first problem hides the others.
  it('keeps running later checks after one of them fails', async () => {
    const { impl } = makeFetch((url) =>
      url.endsWith('/commits/abc123')
        ? { status: 404, body: '{"message":"Not Found"}' }
        : { status: 200, body: '{"stargazers_count":7}' },
    )

    const outcome = await runGithubCheck(criteria({ requireCommit: true, minStars: 5 }), impl)

    if (outcome.kind !== 'ran') throw new Error('expected ran')
    expect(outcome.checks.map((c) => [c.id, c.passed])).toEqual([
      ['gh.commit', false],
      ['gh.stars', true],
    ])
  })
})

/* ------------------------------------------------------------------ malformed criteria */

describe('runGithubCheck — malformed criteria are never the freelancer\'s fault', () => {
  // Protects the blame boundary. Criteria are written by the client; a broken one is not
  // evidence that the work is incomplete, so it must never be signable as a failure.
  it('is unreachable when the github block is missing entirely', async () => {
    const { impl, calls } = makeFetch(always({ status: 200, body: COMMIT_BODY }))

    const outcome = await runGithubCheck(
      { v: 1, title: 'x', check: 'github' },
      impl,
    )

    expect(outcome.kind).toBe('unreachable')
    expect(calls).toHaveLength(0)
  })

  it('is unreachable when repo is not owner/name', async () => {
    const { impl, calls } = makeFetch(always({ status: 200, body: COMMIT_BODY }))

    const outcome = await runGithubCheck(criteria({ repo: 'widget', requireCommit: true }), impl)

    expect(outcome.kind).toBe('unreachable')
    expect(calls).toHaveLength(0)
  })

  it('is unreachable when a ref-scoped check is asked for with a blank ref', async () => {
    const { impl } = makeFetch(always({ status: 200, body: COMMIT_BODY }))

    const outcome = await runGithubCheck(criteria({ ref: '  ', requireCommit: true }), impl)

    expect(outcome.kind).toBe('unreachable')
  })

  // A stars-only criteria set does not need a ref, so a blank one must not block it.
  it('does not require a ref for a stars-only check', async () => {
    const { impl } = makeFetch(always({ status: 200, body: '{"stargazers_count":3}' }))

    const outcome = await runGithubCheck(criteria({ ref: '', minStars: 1 }), impl)

    expect(outcome.kind).toBe('ran')
  })

  // A blank run name matches nothing and would fail every submission forever. That is a
  // broken criteria field, not a verdict.
  it('is unreachable when requireCheckRun is a blank name', async () => {
    const { impl, calls } = makeFetch(always({ status: 200, body: checkRunsBody([]) }))

    const outcome = await runGithubCheck(criteria({ requireCheckRun: '   ' }), impl)

    expect(outcome.kind).toBe('unreachable')
    expect(calls).toHaveLength(0)
  })

  // NaN passes `typeof x === 'number'` and would make every comparison false, failing honest
  // work. Refuse to compare against it.
  it('is unreachable when minStars is not a finite number', async () => {
    const { impl, calls } = makeFetch(always({ status: 200, body: '{"stargazers_count":3}' }))

    const outcome = await runGithubCheck(criteria({ minStars: Number.NaN }), impl)

    expect(outcome.kind).toBe('unreachable')
    expect(calls).toHaveLength(0)
  })
})
