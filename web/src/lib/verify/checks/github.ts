/**
 * The GitHub check — asks api.github.com three narrow questions about a repo.
 *
 * What this module is allowed to conclude is deliberately tiny. `GET /commits/{ref}` returning
 * 200 says a commit object is reachable at that ref; it says nothing about what is in it. A
 * check run concluding "success" says GitHub's own CI reported success; we did not read the
 * logs, and a workflow that runs `exit 0` concludes success too. `stargazers_count` measures
 * attention, not delivery. Every `detail` string below is written to say what was *observed*,
 * because the attestation this feeds only opens a challenge window — the client still gets to
 * look at the same report and object.
 *
 * The other half of the job is the 422/502 line. Anything that stopped us from *looking* —
 * rate limits on our own token, a repo our credentials cannot open, GitHub being down, a body
 * we cannot parse — is `unreachable`. Recording our own API budget running out as a freelancer's
 * milestone being incomplete would be a lie with money attached, so every ambiguous branch here
 * resolves to `unreachable`.
 */

import type { CheckOutcome, CheckResult, Criteria, FetchImpl } from '../types'

const GITHUB_API = 'https://api.github.com'

/** How many sibling run names to name in a "no such check run" detail before truncating. */
const MAX_NAMED_RUNS = 10

/** How much of an error body to quote back in an `unreachable` reason. */
const MAX_BODY_SNIPPET = 200

/** A step either produced a report line, or stopped us from looking at all. */
type Step = { kind: 'check'; check: CheckResult } | { kind: 'unreachable'; reason: string }

/** A GitHub response we managed to read. `notFound` is separated because only the caller
 *  knows whether a 404 on *its* endpoint is a failure or an ambiguity. */
type GhResponse =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'notFound' }
  | { kind: 'unreachable'; reason: string }

/**
 * Run whichever GitHub checks the criteria asked for, in a fixed order.
 *
 * Returns `unreachable` the moment any single request fails to produce an answer: one
 * unanswerable question makes the whole outcome unanswerable, because the report's `passed`
 * is an AND over every check and we would be asserting a conjunction we did not evaluate.
 *
 * `token` is optional and is only ever used as an `Authorization` header value. It is never
 * logged and every string leaving this function is passed through a redactor, so a token that
 * somehow ended up inside an error message cannot reach a report that gets stored off-chain.
 */
export async function runGithubCheck(
  criteria: Criteria,
  fetchImpl: FetchImpl,
  token?: string,
): Promise<CheckOutcome> {
  const redact = makeRedactor(token)
  const gh = criteria.github

  // A github check with no github block is malformed *criteria* — written by the client, not
  // by the freelancer. Blaming the freelancer's work for it would be exactly the wrong party,
  // so this is unreachable, not a failure. (The route should catch this first and answer 400.)
  if (!gh) {
    return {
      kind: 'unreachable',
      reason: 'criteria.github is missing, so there was nothing to look up on GitHub',
    }
  }

  if (!isRepoSlug(gh.repo)) {
    return {
      kind: 'unreachable',
      reason: `criteria.github.repo is not in owner/name form: ${JSON.stringify(gh.repo)}`,
    }
  }

  const wantCommit = gh.requireCommit === true
  const wantCheckRun = gh.requireCheckRun !== null && gh.requireCheckRun !== undefined
  const wantStars = gh.minStars !== null && gh.minStars !== undefined

  // `ref` is only needed by the two ref-scoped endpoints. A stars-only criteria set with a
  // blank ref is perfectly answerable, so do not reject it.
  if ((wantCommit || wantCheckRun) && !isNonBlank(gh.ref)) {
    return {
      kind: 'unreachable',
      reason: 'criteria.github.ref is empty, so there is no commit to look up',
    }
  }

  if (wantCheckRun && !isNonBlank(gh.requireCheckRun as string)) {
    // An empty name matches no run and would fail every time. That is a broken criteria
    // field, not evidence about the work.
    return {
      kind: 'unreachable',
      reason: 'criteria.github.requireCheckRun is blank, so no run name was specified to look for',
    }
  }

  if (wantStars && !Number.isFinite(gh.minStars as number)) {
    return {
      kind: 'unreachable',
      reason: `criteria.github.minStars is not a finite number: ${String(gh.minStars)}`,
    }
  }

  const repoPath = encodePath(gh.repo)
  const refPath = encodePath(gh.ref)
  const checks: CheckResult[] = []

  if (wantCommit) {
    const step = await commitStep(repoPath, refPath, gh.ref, fetchImpl, token, redact)
    if (step.kind === 'unreachable') return step
    checks.push(step.check)
  }

  if (wantCheckRun) {
    const step = await checkRunStep(
      repoPath,
      refPath,
      gh.ref,
      gh.requireCheckRun as string,
      fetchImpl,
      token,
      redact,
    )
    if (step.kind === 'unreachable') return step
    checks.push(step.check)
  }

  if (wantStars) {
    const step = await starsStep(repoPath, gh.repo, gh.minStars as number, fetchImpl, token, redact)
    if (step.kind === 'unreachable') return step
    checks.push(step.check)
  }

  // Note the empty case is reachable: criteria asking for none of the three yields no checks,
  // and an AND over nothing is true. This module does not invent a check to prevent that —
  // whether "a github criteria that requires nothing" should pass is the aggregator's call.
  return { kind: 'ran', checks }
}

/* ------------------------------------------------------------------ the three checks */

async function commitStep(
  repoPath: string,
  refPath: string,
  ref: string,
  fetchImpl: FetchImpl,
  token: string | undefined,
  redact: (s: string) => string,
): Promise<Step> {
  const url = `${GITHUB_API}/repos/${repoPath}/commits/${refPath}`
  const res = await request(url, fetchImpl, token, redact)

  if (res.kind === 'unreachable') return res

  if (res.kind === 'notFound') {
    // C-contract: 404 here is a genuine failure — the commit is not there. Said honestly,
    // because GitHub also answers 404 for a repository our credentials cannot open: what we
    // actually observed is "no commit visible to us at this ref". Supplying a token that can
    // see the repo is what makes this check mean the stronger thing.
    return {
      kind: 'check',
      check: {
        id: 'gh.commit',
        label: 'Commit exists at ref',
        passed: false,
        detail: `GitHub returned 404 for ${ref}: no commit visible to us at this ref (GitHub also answers 404 for repositories our credentials cannot open).`,
      },
    }
  }

  return {
    kind: 'check',
    check: {
      id: 'gh.commit',
      label: 'Commit exists at ref',
      passed: true,
      detail: `GitHub returned 200 for ${ref}: a commit object exists at this ref. Only the ref's existence was observed, not what the commit contains.`,
    },
  }
}

async function checkRunStep(
  repoPath: string,
  refPath: string,
  ref: string,
  name: string,
  fetchImpl: FetchImpl,
  token: string | undefined,
  redact: (s: string) => string,
): Promise<Step> {
  // `per_page=100` is not decoration. The endpoint defaults to 30 per page, and a ref with
  // more runs than that would hide the named one behind a page we never asked for — which
  // this module would then report as "no such run", a false failure with money attached.
  const url = `${GITHUB_API}/repos/${repoPath}/commits/${refPath}/check-runs?per_page=100`
  const res = await request(url, fetchImpl, token, redact)

  if (res.kind === 'unreachable') return res

  const label = `Check run "${name}" concluded success`

  if (res.kind === 'notFound') {
    return {
      kind: 'check',
      check: {
        id: 'gh.checkRun',
        label,
        passed: false,
        detail: `GitHub returned 404 listing check runs for ${ref}: no such ref visible to us, so no run named "${name}" could be found.`,
      },
    }
  }

  const parsed = parseCheckRuns(res.body)
  if (parsed === null) {
    // The endpoint answered but not with the shape it documents. We did not learn the run's
    // state, so we have not observed a failure — only our own inability to read the answer.
    return {
      kind: 'unreachable',
      reason: `GitHub's check-runs response for ${ref} did not contain a readable check_runs array`,
    }
  }

  const { runs, totalCount } = parsed
  const matching = runs.filter((r) => r.name === name)

  if (matching.length === 0) {
    // "We did not see it" only means "it is not there" if we saw everything. If GitHub says
    // there are more runs than it handed us, the named run may be on a page we never fetched,
    // and reporting a failure would be asserting something we did not observe.
    if (totalCount !== null && totalCount > runs.length) {
      return {
        kind: 'unreachable',
        reason: `GitHub reported ${totalCount} check runs for ${ref} but returned only ${runs.length}; "${name}" may be on a page we did not read, so this is not a failure we can assert`,
      }
    }
    return {
      kind: 'check',
      check: {
        id: 'gh.checkRun',
        label,
        passed: false,
        detail: `No check run named "${name}" was reported for ${ref}. ${describeRunNames(runs)}`,
      },
    }
  }

  // Re-runs can share a name. GitHub does not promise an order, so say which one was read
  // rather than quietly picking a winner.
  const run = matching[0]
  const ambiguity =
    matching.length > 1
      ? ` (${matching.length} runs share this name; the first one GitHub returned was used.)`
      : ''

  if (run.conclusion === 'success') {
    return {
      kind: 'check',
      check: {
        id: 'gh.checkRun',
        label,
        passed: true,
        detail: `Check run "${name}" finished and passed (status: ${run.status ?? 'unknown'}, conclusion: success). This is GitHub's own conclusion; the run's logs and what it actually asserted were not inspected.${ambiguity}`,
      },
    }
  }

  if (run.status !== 'completed') {
    // "Not finished yet" and "finished and failed" are both failures, but they call for
    // completely different responses from a human — one is "wait and resubmit", the other is
    // "fix the build". The report is the only place they can tell them apart.
    return {
      kind: 'check',
      check: {
        id: 'gh.checkRun',
        label,
        passed: false,
        detail: `Check run "${name}" has not finished yet (status: ${run.status ?? 'unknown'}, conclusion: ${run.conclusion ?? 'none'}). A run still in flight has not passed, so this does not pass.${ambiguity}`,
      },
    }
  }

  return {
    kind: 'check',
    check: {
      id: 'gh.checkRun',
      label,
      passed: false,
      detail: `Check run "${name}" finished and failed (status: completed, conclusion: ${run.conclusion ?? 'none'}).${ambiguity}`,
    },
  }
}

async function starsStep(
  repoPath: string,
  repo: string,
  minStars: number,
  fetchImpl: FetchImpl,
  token: string | undefined,
  redact: (s: string) => string,
): Promise<Step> {
  const url = `${GITHUB_API}/repos/${repoPath}`
  const res = await request(url, fetchImpl, token, redact)

  if (res.kind === 'unreachable') return res

  const label = `Repository has at least ${minStars} stars`

  if (res.kind === 'notFound') {
    return {
      kind: 'check',
      check: {
        id: 'gh.stars',
        label,
        passed: false,
        detail: `GitHub returned 404 for ${repo}: the repository is not visible to us, so no star count was observed.`,
      },
    }
  }

  const stars = res.body['stargazers_count']
  if (typeof stars !== 'number' || !Number.isFinite(stars)) {
    return {
      kind: 'unreachable',
      reason: `GitHub's repository response for ${repo} had no readable stargazers_count`,
    }
  }

  const passed = stars >= minStars
  return {
    kind: 'check',
    check: {
      id: 'gh.stars',
      label,
      passed,
      detail: passed
        ? `stargazers_count is ${stars}, at or above the required ${minStars}. A star count measures attention, not whether the work was done.`
        : `stargazers_count is ${stars}, below the required ${minStars}.`,
    },
  }
}

/* ------------------------------------------------------------------ transport */

/**
 * One GET against the GitHub API, with every non-answer folded into `unreachable`.
 *
 * The status ladder is the whole 422/502 decision for this module:
 *   403 / 429  -> unreachable. Rate limit is our budget; a permissions wall is a repo we
 *                 could not open. Neither is a statement about the freelancer's work.
 *   401        -> unreachable. Our credential was rejected. Also ours.
 *   5xx        -> unreachable. GitHub is having a bad day.
 *   404        -> handed back to the caller, which knows what a 404 means on its endpoint.
 *   other non-2xx, unparseable body, rejected connection -> unreachable, because we did not
 *                 get an answer we can read and a guess here gets signed.
 */
async function request(
  url: string,
  fetchImpl: FetchImpl,
  token: string | undefined,
  redact: (s: string) => string,
): Promise<GhResponse> {
  let res: Awaited<ReturnType<FetchImpl>>
  try {
    res = await fetchImpl(url, { method: 'GET', headers: buildHeaders(token) })
  } catch (err) {
    return {
      kind: 'unreachable',
      reason: redact(`Could not reach ${url}: ${errorText(err)}`),
    }
  }

  let text: string
  try {
    text = await res.text()
  } catch (err) {
    return {
      kind: 'unreachable',
      reason: redact(`Response body from ${url} could not be read: ${errorText(err)}`),
    }
  }

  const status = res.status

  if (status === 403 || status === 429) {
    return { kind: 'unreachable', reason: redact(throttleReason(url, status, res.headers, text)) }
  }

  if (status === 401) {
    // Deliberately does not echo the body or any header — a 401 is about our credential and
    // the last thing this reason should carry is anything resembling it.
    return {
      kind: 'unreachable',
      reason: `GitHub rejected our credentials with 401 on ${url}. That is our configuration, not the freelancer's work.`,
    }
  }

  if (status >= 500) {
    return {
      kind: 'unreachable',
      reason: redact(`GitHub returned ${status} on ${url}${bodySnippet(text)}`),
    }
  }

  if (status === 404) return { kind: 'notFound' }

  if (status < 200 || status >= 300) {
    return {
      kind: 'unreachable',
      reason: redact(`GitHub returned an unexpected ${status} on ${url}${bodySnippet(text)}`),
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A 200 whose body is not JSON means something answered that is not the API we think we
    // are talking to (a proxy, a captive portal, a truncated response). Not a failing
    // milestone — an unread one.
    return {
      kind: 'unreachable',
      reason: `GitHub returned ${status} on ${url} with a body that is not valid JSON`,
    }
  }

  const body = asRecord(parsed)
  if (body === null) {
    return {
      kind: 'unreachable',
      reason: `GitHub returned ${status} on ${url} with a JSON body that is not an object`,
    }
  }

  return { kind: 'ok', body }
}

/**
 * Why a 403/429 stopped us, and when retrying is worth it.
 *
 * A rate limit is detected from status 403/429 together with `x-ratelimit-remaining: 0` or a
 * body that mentions a rate limit — GitHub uses 403 for both throttling and permissions, so
 * the status alone cannot tell them apart. Both land on `unreachable` regardless; the
 * distinction only changes the wording a human retries against. `x-ratelimit-reset` is echoed
 * whenever present so the caller knows when a retry has a chance.
 */
function throttleReason(
  url: string,
  status: number,
  headers: { get(name: string): string | null },
  body: string,
): string {
  const remaining = headers.get('x-ratelimit-remaining')
  const reset = headers.get('x-ratelimit-reset')
  const resetNote = reset === null || reset.trim() === '' ? '' : `; x-ratelimit-reset=${reset.trim()}`

  const exhausted = remaining !== null && remaining.trim() === '0'
  const bodySaysRateLimit = /rate.?limit|secondary rate|abuse detection/i.test(body)

  if (exhausted || bodySaysRateLimit) {
    return `GitHub rate limit hit on ${url} (HTTP ${status}${
      remaining === null ? '' : `, x-ratelimit-remaining=${remaining.trim()}`
    }${resetNote}). This is our own API budget and says nothing about the work; retry later.`
  }

  if (status === 429) {
    return `GitHub returned 429 Too Many Requests on ${url}${resetNote}. We were throttled before we could look; retry later.`
  }

  return `GitHub returned 403 on ${url}${resetNote} with no rate-limit signal, so this is most likely a permissions wall on a private repository. We could not look, so we must not judge.`
}

function buildHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  // Only ever placed here. Nothing in this module logs headers or copies them into a detail.
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/**
 * Belt and braces against the token leaking into a report.
 *
 * No branch above deliberately writes the token anywhere, but reasons interpolate error
 * messages from an injected fetch we do not control, and reports are stored off-chain and
 * shown to both parties. Scrubbing costs nothing next to leaking a credential.
 */
function makeRedactor(token: string | undefined): (s: string) => string {
  if (!token) return (s) => s
  return (s) => s.split(token).join('[redacted]')
}

/* ------------------------------------------------------------------ small helpers */

type ParsedRun = { name: string; status: string | null; conclusion: string | null }

/**
 * `null` means the body was not the documented shape — the caller turns that into unreachable.
 *
 * `totalCount` is `null` when GitHub omitted it, which is the honest way to say "we cannot
 * tell whether this list is complete"; the caller only uses it to refuse a false negative.
 */
function parseCheckRuns(
  body: Record<string, unknown>,
): { runs: ParsedRun[]; totalCount: number | null } | null {
  const raw = body['check_runs']
  if (!Array.isArray(raw)) return null

  const rawTotal = body['total_count']
  const totalCount =
    typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? rawTotal : null

  const runs: ParsedRun[] = []
  for (const entry of raw) {
    const rec = asRecord(entry)
    if (rec === null) return null
    const name = rec['name']
    if (typeof name !== 'string') return null
    runs.push({
      name,
      status: typeof rec['status'] === 'string' ? (rec['status'] as string) : null,
      conclusion: typeof rec['conclusion'] === 'string' ? (rec['conclusion'] as string) : null,
    })
  }
  return { runs, totalCount }
}

function describeRunNames(runs: ParsedRun[]): string {
  if (runs.length === 0) return 'GitHub reported no check runs at all for this ref.'
  const shown = runs.slice(0, MAX_NAMED_RUNS).map((r) => `"${r.name}"`).join(', ')
  const more = runs.length > MAX_NAMED_RUNS ? `, and ${runs.length - MAX_NAMED_RUNS} more` : ''
  return `${runs.length} run(s) were reported: ${shown}${more}.`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function bodySnippet(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  const cut =
    trimmed.length > MAX_BODY_SNIPPET ? `${trimmed.slice(0, MAX_BODY_SNIPPET)}...` : trimmed
  return `: ${cut}`
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function isNonBlank(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/** owner/name, exactly two non-empty segments and no whitespace. */
function isRepoSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[^/\s]+\/[^/\s]+$/.test(value)
}

/**
 * Percent-encode each path segment but keep the separators: a ref may legitimately be
 * `feature/thing` or `heads/main`, and encoding its slash to %2F would send GitHub a
 * different — and wrong — resource.
 */
function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/')
}
