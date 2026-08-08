/**
 * The HTTP check: fetch a URL and report what came back.
 *
 * What this is worth, stated plainly. A 200 is satisfied by a blank page, and "the rendered
 * text contains 'Pricing'" is satisfied by the word 'Pricing' sitting alone on a white
 * background. Nothing below is evidence that the agreed work was done — it is evidence that
 * a server answered and that some agreed strings were or were not present in what it sent.
 * That is exactly why a pass here only opens a challenge window instead of deciding anything:
 * the client still gets to look at the page and object.
 *
 * The other half of this file's job is the 422/502 line. A server that answers with 500 has
 * told us something about the milestone, and that is a signed failure. A DNS error, a refused
 * connection, a TLS handshake failure, our own timeout firing, or a body we could not finish
 * reading tell us nothing about the milestone — they are our problem, and they come back as
 * `unreachable` so the route can answer 502 and the caller can retry. Recording our own
 * network trouble on-chain as somebody's work being incomplete is the worst bug this service
 * can have, so every ambiguous path below resolves to `unreachable`.
 */

import type { CheckOutcome, CheckResult, Criteria, FetchImpl } from '../types'

/**
 * Run the http block of `criteria` against `fetchImpl`.
 *
 * @param now injected clock, so the elapsed figure in `detail` is deterministic under test.
 *            It is only ever used for human-readable timings, never for a pass/fail decision.
 * @throws TypeError if `criteria.http` is absent. That is a programming error on our side of
 *         the wall — C6 makes the route validate the body and answer 400 — so it must not be
 *         quietly laundered into a failing milestone or a retryable 502.
 */
export async function runHttpCheck(
  criteria: Criteria,
  fetchImpl: FetchImpl,
  now: () => number = Date.now,
): Promise<CheckOutcome> {
  const http = criteria.http
  if (!http) {
    throw new TypeError(
      'runHttpCheck: criteria.http is missing; the route must reject this body with 400 before calling the check',
    )
  }

  const { url, expectStatus, mustContain, mustNotContain, timeoutMs } = http

  // Our own AbortController, not one handed in: the timeout is a property of this check, and
  // whoever fires it has to be the same code that can tell the difference between "we gave up"
  // (ours, unreachable) and "the server said no" (theirs, a failure).
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const startedAt = now()

  try {
    let response: Awaited<ReturnType<FetchImpl>>
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'text/html,*/*' },
        signal: controller.signal,
      })
    } catch (err: unknown) {
      // Everything that makes fetch reject — DNS, connection refused, TLS, the abort above —
      // is a statement about the network between us and the target, not about the milestone.
      return unreachable(timedOut, timeoutMs, url, err)
    }

    let body: string
    try {
      body = await response.text()
    } catch (err: unknown) {
      // Headers arrived but the body did not finish. We saw a status code, and it is tempting
      // to grade on that alone — but a truncated response is an incomplete observation caused
      // by the transport, and grading a half-read page would let a dropped connection be
      // signed as the freelancer's failure. Retry instead.
      return unreachable(timedOut, timeoutMs, url, err)
    }

    const elapsedMs = now() - startedAt
    const text = renderedText(body)

    const checks: CheckResult[] = []

    // The server answered. Whatever it said, this is now a statement about the milestone.
    checks.push({
      id: 'http.status',
      label: `HTTP status equals ${expectStatus}`,
      passed: response.status === expectStatus,
      detail:
        `GET ${url} — expected ${expectStatus}, observed ${response.status}` +
        ` (full response read in ${elapsedMs}ms)`,
    })

    // Ids carry the index because a report can hold several contains checks and the UI keys
    // its rows on the id; two rows sharing 'http.contains' with different verdicts would be
    // indistinguishable to anyone reading the report later, including an arbiter.
    mustContain.forEach((phrase, i) => {
      const at = indexOfPhrase(text, phrase)
      checks.push({
        id: `http.contains.${i}`,
        label: `Rendered text contains ${JSON.stringify(phrase)}`,
        passed: at !== -1,
        detail:
          at !== -1
            ? `found at character ${at} of ${text.length} of rendered text`
            : `not found in the ${text.length} characters of rendered text. ${APPROXIMATION_NOTE}`,
      })
    })

    mustNotContain.forEach((phrase, i) => {
      const at = indexOfPhrase(text, phrase)
      checks.push({
        id: `http.notContains.${i}`,
        label: `Rendered text does not contain ${JSON.stringify(phrase)}`,
        passed: at === -1,
        detail:
          at === -1
            ? `absent from the ${text.length} characters of rendered text. ${APPROXIMATION_NOTE}`
            : `found at character ${at} of ${text.length} of rendered text`,
      })
    })

    return { kind: 'ran', checks }
  } finally {
    // Held until the body is read, not just the headers, so a response that trickles forever
    // still hits the timeout rather than hanging the request.
    clearTimeout(timer)
  }
}

/**
 * Honest about what was and was not looked at. Repeated into the detail of every contains
 * check because that is the line an arbiter will actually read when a result is disputed.
 */
const APPROXIMATION_NOTE =
  'The rendered text is a tag-stripped approximation of the page — there is no headless ' +
  'browser here, so anything a browser would have inserted via client-side JavaScript is ' +
  'invisible to this check.'

function unreachable(
  timedOut: boolean,
  timeoutMs: number,
  url: string,
  err: unknown,
): CheckOutcome {
  const reason = timedOut
    ? `timed out after ${timeoutMs}ms fetching ${url}`
    : `could not reach ${url}: ${describeError(err)}`
  return { kind: 'unreachable', reason }
}

/** Never let a thrown value escape as an exception, and never let it be `[object Object]`. */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    // Node puts the useful part (ENOTFOUND, ECONNREFUSED) on `cause`, not on the message.
    const cause = err.cause
    const code =
      typeof cause === 'object' && cause !== null && 'code' in cause
        ? String((cause as { code: unknown }).code)
        : null
    return code ? `${err.name}: ${err.message} (${code})` : `${err.name}: ${err.message}`
  }
  return typeof err === 'string' ? err : JSON.stringify(err) ?? String(err)
}

/** Case-insensitive, whitespace-insensitive search. Returns -1 when absent. */
function indexOfPhrase(text: string, phrase: string): number {
  // The needle goes through the same collapse as the haystack, so a phrase the client typed
  // across two lines in the criteria still matches a page that renders it on one.
  return text.indexOf(collapse(phrase).toLowerCase())
}

/**
 * A text approximation of what a reader would see. This is not a renderer and does not
 * pretend to be one: it drops script and style bodies, strips the remaining tags, decodes the
 * common entities, and collapses whitespace. It cannot execute JavaScript, so a single-page
 * app that paints its content client-side will look empty here — which is a real limitation
 * of this check and is stated in every detail string it produces.
 *
 * Returned lowercased; every comparison in this module is case-insensitive.
 */
function renderedText(html: string): string {
  let s = html

  // Comments first: they can contain anything, including markup, and none of it is rendered.
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')

  // Script and style contents are code, not text. A browser shows neither, so a phrase that
  // only appears inside them has not been rendered and must not satisfy `mustContain` — nor
  // may it trip `mustNotContain`.
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')

  // An unclosed <script> or <style> swallows the rest of the document in a real parser too,
  // so drop to the end rather than letting raw JavaScript leak into the "rendered" text.
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*$/i, ' ')

  // Remaining tags become a space, not nothing: `<p>one</p><p>two</p>` reads as two words.
  s = s.replace(/<[^>]*>/g, ' ')

  // Entities are decoded only now that no tag can be formed from the result — decoding first
  // would turn a literal `&lt;script&gt;` printed on the page into a tag we then stripped.
  // One pass, so `&amp;lt;` decodes to the text `&lt;` and is not decoded twice.
  s = s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return codePoint(parseInt(entity.slice(2), 16), whole)
    }
    if (entity.startsWith('#')) {
      return codePoint(parseInt(entity.slice(1), 10), whole)
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()]
    // An entity we do not know stays verbatim. Silently deleting it would change the text a
    // contains check is matched against, and we would rather be visibly approximate.
    return named ?? whole
  })

  return collapse(s).toLowerCase()
}

function codePoint(value: number, whole: string): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return whole
  try {
    return String.fromCodePoint(value)
  } catch {
    return whole
  }
}

/** The entities that actually show up in hand-written and framework-generated HTML. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
}

/** Any run of whitespace becomes one space, because a browser collapses it the same way. */
function collapse(s: string): string {
  // \s matches U+00A0 in JavaScript, so a decoded &nbsp; collapses like an ordinary space.
  return s.replace(/\s+/g, ' ').trim()
}
