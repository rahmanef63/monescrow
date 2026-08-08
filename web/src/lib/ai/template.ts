/**
 * C7 — the deterministic template parser.
 *
 * This is the floor of the credential ladder: `x-llm-key`, then `ANTHROPIC_API_KEY`, then
 * this. It is the only rung that is guaranteed to be there, so it is the one that decides
 * whether the product works on a machine with no key at all. It reads no environment, opens
 * no socket, and consults no clock — the same brief in always gives the same split out.
 *
 * What it honestly is: a keyword-driven phase template. It does not understand the brief. It
 * picks a shape that matches how freelance work is actually staged, picks a check kind from
 * what the brief mentions, and lifts a URL or a repository only when one is literally there.
 * Everything it emits is a *draft* — both parties edit every title, every amount and every
 * criterion in the UI before anything is signed.
 */

import type { BriefInput, MilestoneDraft, MilestoneProvider } from '@/lib/ai/types'
import type { CheckKind, Criteria } from '@/lib/verify/types'

/**
 * Placeholders are deliberately ugly and deliberately unresolvable (`.invalid` is reserved by
 * RFC 2606 and can never be registered). A plausible-looking guessed URL is far more dangerous
 * than a visible blank: a blank gets edited, a plausible guess gets signed.
 */
export const PLACEHOLDER_URL = 'https://replace-me.invalid/'
export const PLACEHOLDER_REPO = 'REPLACE-ME/REPLACE-ME'

/** The default branch to check when a repo is found. Stated in the rationale so it is editable. */
const DEFAULT_REF = 'main'

/** Ten seconds. Long enough for a cold serverless page, short enough not to hang a report. */
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * The only check-run name we can offer without inventing evidence. It is a guess at the job
 * name, and the rationale says so — the parties must make it match their actual workflow.
 */
const DEFAULT_CHECK_RUN = 'ci'

/** The five phases, in the order they happen. */
type Role = 'kickoff' | 'foundation' | 'core' | 'review' | 'delivery'

const ROLES: readonly Role[] = ['kickoff', 'foundation', 'core', 'review', 'delivery'] as const

/**
 * Relative weights, not an even split. A first milestone that is a small setup slice and a
 * last one that carries the delivery is how these contracts are actually written, and an even
 * split quietly pays most of the money before most of the work exists.
 */
const WEIGHTS: Record<Role, number> = {
  kickoff: 10,
  foundation: 20,
  core: 25,
  review: 15,
  delivery: 30,
}

/**
 * Which phases survive when there is not enough money for five non-zero milestones.
 *
 * Dropping phases is the only option that keeps every amount >= 1 wei; a zero-amount
 * milestone makes `create` revert `ZeroMilestoneAmount`, so it is not an option at all.
 * Delivery is kept first because a contract with no delivery milestone is not a contract.
 */
const KEEP_PRIORITY: readonly Role[] = ['delivery', 'core', 'kickoff', 'foundation', 'review'] as const

// ---------------------------------------------------------------------------------------
// Keyword signals
// ---------------------------------------------------------------------------------------

/**
 * Multi-word entries are matched by substring; single words by word boundary, so "apibulk"
 * does not count as "api" and "designer" does not count as "design" twice.
 */
const CODE_WORDS: readonly string[] = [
  'repo',
  'repository',
  'github',
  'gitlab',
  'git',
  'code',
  'codebase',
  'api',
  'endpoint',
  'endpoints',
  'backend',
  'library',
  'package',
  'sdk',
  'cli',
  'commit',
  'commits',
  'pull request',
  'merge',
  'refactor',
  'typescript',
  'javascript',
  'python',
  'rust',
  'solidity',
  'smart contract',
  'npm',
  'module',
  'script',
  'bugfix',
  'integration',
]

const SITE_WORDS: readonly string[] = [
  'site',
  'website',
  'web site',
  'page',
  'pages',
  'landing',
  'homepage',
  'deploy',
  'deployment',
  'live',
  'hosting',
  'host',
  'domain',
  'staging',
  'launch',
  'seo',
  'webflow',
  'wordpress',
  'shopify',
  'storefront',
]

const SOFT_WORDS: readonly string[] = [
  'design',
  'redesign',
  'copy',
  'copywriting',
  'research',
  'review',
  'document',
  'documentation',
  'brand',
  'branding',
  'logo',
  'illustration',
  'mockup',
  'wireframe',
  'article',
  'blog',
  'content',
  'strategy',
  'audit',
  'report',
  'presentation',
  'deck',
  'translation',
  'editing',
  'ux',
  'ui',
  'consult',
  'consulting',
]

/** CI-ish words. Spec: a check-run name is added when the brief mentions CI, tests or a build. */
const CI_WORDS: readonly string[] = [
  'ci',
  'continuous integration',
  'test',
  'tests',
  'testing',
  'build',
  'builds',
  'pipeline',
  'github actions',
  'lint',
  'coverage',
]

/** Words that look like a repo owner or name but are English. Guards `and/or`, `he/she`, ... */
const REPO_STOPWORDS: ReadonlySet<string> = new Set([
  'and',
  'or',
  'the',
  'an',
  'to',
  'in',
  'on',
  'of',
  'for',
  'per',
  'both',
  'either',
  'neither',
  'he',
  'she',
  'it',
  'his',
  'her',
  'him',
  'they',
  'them',
  'we',
  'us',
  'you',
  'yes',
  'no',
  'am',
  'pm',
  'ie',
  'eg',
  'etc',
  'day',
  'week',
  'month',
  'year',
  'day',
  'hr',
  'min',
  'sec',
])

/**
 * Precompiled at module scope so a 100 kB brief is scanned with the same regex objects every
 * time. None of these are global, so none of them carry `lastIndex` state between calls —
 * a stateful regex would make the parser non-deterministic across repeated calls, which is
 * exactly the property this module exists to guarantee.
 */
const WORD_MATCHERS: ReadonlyMap<string, RegExp> = new Map(
  [...CODE_WORDS, ...SITE_WORDS, ...SOFT_WORDS, ...CI_WORDS]
    .filter((w) => !w.includes(' '))
    .map((w) => [w, new RegExp(`\\b${w}\\b`)] as const),
)

function countHits(haystack: string, words: readonly string[]): number {
  let n = 0
  for (const w of words) {
    if (w.includes(' ')) {
      if (haystack.includes(w)) n += 1
      continue
    }
    const re = WORD_MATCHERS.get(w)
    // Defensive: a word added to a list but not to the matcher map falls back to substring.
    if (re ? re.test(haystack) : haystack.includes(w)) n += 1
  }
  return n
}

// ---------------------------------------------------------------------------------------
// Extraction — only what is literally in the brief
// ---------------------------------------------------------------------------------------

/** No nested quantifiers: this must stay linear on a brief that is 100 kB of one word. */
const URL_RE = /https?:\/\/[^\s<>"'()[\]{}]+/i
const BARE_WWW_RE = /\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"'()[\]{}]*/i
/** Only double and curly quotes. Single quotes collide with apostrophes ("the client's site"). */
const QUOTED_RE = /["“]([^"“”\n]{3,80})["”]/

function trimUrlPunctuation(url: string): string {
  // A URL at the end of a sentence swallows the full stop. Strip trailing sentence punctuation
  // but never a slash, which is meaningful.
  return url.replace(/[.,;:!?]+$/, '')
}

function isCodeHost(url: string): boolean {
  const lower = url.toLowerCase()
  return lower.includes('://github.com/') || lower.includes('://gitlab.com/')
}

/** Every URL in the brief, in the order they appear, de-duplicated. */
function extractUrls(brief: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const token of brief.split(/\s+/)) {
    if (token.length === 0) continue
    const direct = URL_RE.exec(token)
    if (direct) {
      const url = trimUrlPunctuation(direct[0])
      if (!seen.has(url)) {
        seen.add(url)
        out.push(url)
      }
      continue
    }
    const bare = BARE_WWW_RE.exec(token)
    if (bare) {
      const url = `https://${trimUrlPunctuation(bare[0])}`
      if (!seen.has(url)) {
        seen.add(url)
        out.push(url)
      }
    }
  }
  return out
}

function repoFromUrl(url: string): string | null {
  if (!isCodeHost(url)) return null
  const afterHost = url.replace(/^https?:\/\/[^/]+\//i, '')
  const segments = afterHost.split('/').filter((s) => s.length > 0)
  if (segments.length < 2) return null
  const owner = segments[0]
  const name = segments[1].replace(/\.git$/i, '')
  return isRepoSide(owner) && isRepoSide(name) ? `${owner}/${name}` : null
}

const REPO_SIDE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function isRepoSide(part: string): boolean {
  if (part.length < 2 || part.length > 100) return false
  if (!REPO_SIDE_RE.test(part)) return false
  if (/[.\-_]$/.test(part)) return false
  return !REPO_STOPWORDS.has(part.toLowerCase())
}

/**
 * A bare `owner/name` token. Gated on the brief mentioning code at all, because outside that
 * context `and/or` and `client/agency` are far more likely than a repository — and a wrong
 * repo in signed criteria is worse than a visible placeholder.
 */
function extractBareRepo(brief: string, hasCodeSignal: boolean): string | null {
  if (!hasCodeSignal) return null
  for (const raw of brief.split(/\s+/)) {
    const token = raw.replace(/^[("'[]+/, '').replace(/[).,;:!?"'\]]+$/, '')
    if (token.split('/').length !== 2) continue
    const [owner, name] = token.split('/')
    if (isRepoSide(owner) && isRepoSide(name)) return `${owner}/${name}`
  }
  return null
}

/**
 * A phrase we are allowed to require a page to contain. Only a phrase the client themselves
 * put in quotes qualifies — anything else would be us inventing acceptance criteria and
 * calling it theirs.
 */
function extractQuotedPhrase(brief: string): string | null {
  const m = QUOTED_RE.exec(brief)
  if (!m) return null
  const phrase = m[1].trim()
  if (phrase.length < 3) return null
  // Must carry at least one letter or digit; `"---"` is not an acceptance criterion.
  return /[\p{L}\p{N}]/u.test(phrase) ? phrase : null
}

// ---------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------

const DECIMAL_RE = /^[0-9]+$/

function parseTotal(totalAmount: string): bigint {
  if (typeof totalAmount !== 'string' || !DECIMAL_RE.test(totalAmount)) {
    throw new TypeError('totalAmount must be a decimal wei string, e.g. "6000000000000000000"')
  }
  const total = BigInt(totalAmount)
  if (total <= 0n) {
    // Zero cannot be split into any number of non-zero milestones, and a zero-amount milestone
    // makes `create` revert `ZeroMilestoneAmount`. Refusing here is the only honest answer.
    throw new RangeError('totalAmount must be at least 1 wei')
  }
  return total
}

/**
 * Split `total` across `weights`, in wei, exactly.
 *
 * One wei is reserved per milestone before anything is weighted, which is what makes every
 * amount non-zero even at pathological totals. The rest is distributed by weight with integer
 * division, and **the remainder goes to the last milestone** — every share except the last is
 * a floor, so the leftover wei are handed to the tail rather than rounded away. Rounding can
 * therefore never lose or invent a wei, and the sum is exactly `total` by construction. One
 * wei off is a `create` that reverts `FundingMismatch`.
 */
function splitByWeight(total: bigint, weights: readonly number[]): bigint[] {
  const n = weights.length
  if (n === 0) throw new RangeError('cannot split across zero milestones')
  if (total < BigInt(n)) throw new RangeError('cannot split into that many non-zero milestones')

  const rest = total - BigInt(n)
  const sumW = BigInt(weights.reduce((a, b) => a + b, 0))
  const shares: bigint[] = []
  let assigned = 0n
  for (let i = 0; i < n - 1; i += 1) {
    const share = (rest * BigInt(weights[i])) / sumW
    shares.push(1n + share)
    assigned += share
  }
  shares.push(1n + (rest - assigned))
  return shares
}

// ---------------------------------------------------------------------------------------
// Titles, criteria and rationale
// ---------------------------------------------------------------------------------------

function titleFor(role: Role, kind: CheckKind): string {
  switch (role) {
    case 'kickoff':
      return 'Scope agreed and work started'
    case 'foundation':
      if (kind === 'github') return 'Project skeleton committed'
      if (kind === 'http') return 'Page structure and styling in place'
      return 'Direction and research agreed'
    case 'core':
      if (kind === 'github') return 'Core functionality implemented'
      if (kind === 'http') return 'All pages built and content in place'
      return 'First full draft delivered'
    case 'review':
      return 'Client review and revisions'
    case 'delivery':
      if (kind === 'github') return 'Final code delivered and handed over'
      if (kind === 'http') return 'Deployed live and handed over'
      return 'Final files delivered'
  }
}

type Extracted = {
  url: string | null
  repo: string | null
  phrase: string | null
  wantCheckRun: boolean
}

function buildCriteria(title: string, kind: CheckKind, x: Extracted): Criteria {
  if (kind === 'github') {
    return {
      v: 1,
      title,
      check: 'github',
      github: {
        repo: x.repo ?? PLACEHOLDER_REPO,
        ref: DEFAULT_REF,
        requireCommit: true,
        requireCheckRun: x.wantCheckRun ? DEFAULT_CHECK_RUN : null,
        // Never invented: a star threshold nobody asked for is a criterion nobody agreed to.
        minStars: null,
      },
    }
  }
  if (kind === 'http') {
    return {
      v: 1,
      title,
      check: 'http',
      http: {
        url: x.url ?? PLACEHOLDER_URL,
        expectStatus: 200,
        // Only a phrase the client put in quotes. An empty list is an honest blank.
        mustContain: x.phrase ? [x.phrase] : [],
        mustNotContain: [],
        timeoutMs: DEFAULT_TIMEOUT_MS,
      },
    }
  }
  return { v: 1, title, check: 'clientApproval' }
}

const ROLE_PREFIX: Record<Role, string> = {
  kickoff: 'A small slice up front so the work can start.',
  foundation: 'The groundwork, paid once it exists rather than once it is promised.',
  core: 'The bulk of the work.',
  review: 'The revision round, kept separate so feedback is paid for rather than absorbed.',
  delivery: 'The largest slice, because this is the delivery.',
}

function rationaleFor(role: Role, kind: CheckKind, x: Extracted): string {
  const prefix = ROLE_PREFIX[role]

  if (kind === 'github') {
    const repo = x.repo ?? PLACEHOLDER_REPO
    const ci = x.wantCheckRun ? ` and a successful check run named "${DEFAULT_CHECK_RUN}"` : ''
    const placeholder = x.repo
      ? ''
      : ` The repository is a placeholder — replace "${PLACEHOLDER_REPO}" with the real one before signing.`
    const ciNote = x.wantCheckRun
      ? ` The check-run name is a guess; make it match the job name in your workflow or it will never be found.`
      : ''
    return (
      `${prefix} The verifier will look for a commit on ref "${DEFAULT_REF}" of ${repo}${ci}. ` +
      `It can see that code was pushed${x.wantCheckRun ? ' and that CI went green' : ''}; ` +
      `it cannot see whether the code does what you asked for, so read the work before the ` +
      `challenge window closes.` +
      placeholder +
      ciNote +
      ` The branch is assumed to be "${DEFAULT_REF}" — change it if you work on another.`
    )
  }

  if (kind === 'http') {
    const url = x.url ?? PLACEHOLDER_URL
    const contains = x.phrase ? ` and to contain the text "${x.phrase}"` : ''
    const placeholder = x.url
      ? ''
      : ` The URL is a placeholder — it can never resolve, so replace it with the agreed address before signing.`
    const blank = x.phrase
      ? ''
      : ` No required text was taken from the brief, because none was quoted there; add one if the page must say something specific.`
    return (
      `${prefix} The verifier will fetch ${url} and require HTTP 200${contains}. ` +
      `It can see that the page is up and answers; it cannot see whether it looks right, ` +
      `reads well, or works on a phone.` +
      placeholder +
      blank
    )
  }

  return (
    `${prefix} There is no automated check for this that would mean anything, so it is ` +
    `released on the client's approval. Nothing here is machine-verified — the client is the ` +
    `check, and the challenge window is the only backstop. Pretending otherwise would be worse ` +
    `than saying so.`
  )
}

// ---------------------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------------------

/**
 * Turn a brief into 1–5 milestone drafts.
 *
 * Deterministic and total: any string, including an empty one, produces a usable split. The
 * only inputs that throw are money that cannot be split at all (see `parseTotal`).
 */
export function parseBrief(input: BriefInput): MilestoneDraft[] {
  const total = parseTotal(input.totalAmount)
  const brief = typeof input.brief === 'string' ? input.brief : ''
  const lower = brief.toLowerCase()

  const urls = extractUrls(brief)
  const urlFromCodeHost = urls.find(isCodeHost) ?? null
  // A github URL is evidence of a repository, not of a website. Counting it as a site signal
  // would turn "here is my repo" into an http check against a repo page nobody agreed to.
  const siteUrl = urls.find((u) => !isCodeHost(u)) ?? null

  let codeScore = countHits(lower, CODE_WORDS)
  if (urlFromCodeHost) codeScore += 1
  let siteScore = countHits(lower, SITE_WORDS)
  if (siteUrl) siteScore += 1

  const repo = (urlFromCodeHost ? repoFromUrl(urlFromCodeHost) : null) ?? extractBareRepo(brief, codeScore > 0)
  if (repo) codeScore += 1

  const extracted: Extracted = {
    url: siteUrl,
    repo,
    phrase: extractQuotedPhrase(brief),
    wantCheckRun: countHits(lower, CI_WORDS) > 0,
  }

  // Design, copy, research, a review, a document: no automated check on those means anything.
  // Soft has to be able to *win*, not just be the fallback, or "write the launch copy" gets an
  // http check because "launch" happens to be a website word.
  const softScore = countHits(lower, SOFT_WORDS)
  const softWins = softScore > codeScore && softScore > siteScore

  // Building phases prefer github whenever the brief mentions code at all: a commit is more
  // specific evidence than a URL, and a half-built site has a URL that already returns 200.
  const buildKind: CheckKind = softWins
    ? 'clientApproval'
    : codeScore > 0
      ? 'github'
      : siteScore > 0
        ? 'http'
        : 'clientApproval'
  // Delivery prefers http, because when a site is involved "done" means the client can see it.
  const deliveryKind: CheckKind = softWins
    ? 'clientApproval'
    : siteScore > 0
      ? 'http'
      : codeScore > 0
        ? 'github'
        : 'clientApproval'

  const kindFor: Record<Role, CheckKind> = {
    // Agreeing a scope is not a thing a machine can observe. Saying so is the point.
    kickoff: 'clientApproval',
    foundation: buildKind,
    core: buildKind,
    review: 'clientApproval',
    delivery: deliveryKind,
  }

  // Five milestones unless the money cannot carry five non-zero amounts. `total` is below 5
  // here only in the pathological case, so the Number() conversion is never lossy.
  const count = total >= 5n ? 5 : Number(total)
  const kept = new Set(KEEP_PRIORITY.slice(0, count))
  const roles = ROLES.filter((r) => kept.has(r))

  const amounts = splitByWeight(
    total,
    roles.map((r) => WEIGHTS[r]),
  )

  return roles.map((role, i) => {
    const kind = kindFor[role]
    const title = titleFor(role, kind)
    return {
      title,
      amount: amounts[i].toString(),
      check: kind,
      // The criteria title is the milestone title verbatim: the verifier is later asked to
      // check exactly this object, and a criteria object that describes a different milestone
      // than the one it is attached to is a signature nobody can read back.
      criteria: buildCriteria(title, kind, extracted),
      rationale: rationaleFor(role, kind, extracted),
    }
  })
}

/**
 * The no-credential provider. Async only to satisfy the shared `MilestoneProvider` seam — it
 * awaits nothing and touches nothing outside its arguments. Declared `async` rather than
 * returning `Promise.resolve(...)` so that a refusal comes back as a rejection: the resolver
 * awaits every provider the same way, and a synchronous throw from this one alone would slip
 * past a caller's `.catch`.
 */
export const templateProvider: MilestoneProvider = {
  name: 'template',
  async propose(input: BriefInput): Promise<MilestoneDraft[]> {
    return parseBrief(input)
  },
}

export default templateProvider
