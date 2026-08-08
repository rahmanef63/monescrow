'use client'

/**
 * One milestone, told honestly.
 *
 * Three things this card is built to stop somebody believing after a five-second skim:
 *
 *   1. **That the verifier decided anything.** It did not. An off-chain check *proposes* that a
 *      milestone passed; that proposal opens a challenge window, and it is the client's silence
 *      or the client's objection that decides what happens next. Every place a report appears,
 *      the card says what the check actually observed — "the URL answered 200 and the text was
 *      there" — and refuses to dress that up as a verdict on the quality of the work.
 *   2. **That "Released" means money arrived.** It does not. A release credits an internal
 *      balance inside the escrow contract; the recipient still has to call `withdraw` to move it
 *      into their wallet. The card says so on every released milestone, not in a footnote.
 *   3. **That a missing button means the app is broken.** Every action in the C1 table that
 *      names a milestone is rendered here, always. The ones this wallet cannot take render as
 *      real disabled buttons carrying the reason from `permits` — "only the client can dispute",
 *      "the challenge window still has 2 hours left". A hidden button teaches nothing.
 *
 * The permission table is not reimplemented here. `permits` and `MILESTONE_SCOPED_ACTIONS` come
 * straight from `@/lib/chat/permissions`, so this card and the assistant cannot drift apart.
 */

import type { ReactNode } from 'react'
import { MILESTONE_SCOPED_ACTIONS, permits } from '@/lib/chat/permissions'
import { MSTATE, type ActionContext, type ChainAction, type MState, type Role } from '@/lib/chat/types'
import type { CheckKind, Criteria, Evidence, Report } from '@/lib/verify/types'
import { escrowAbi } from '@/lib/abis'
import { formatMon } from '@/lib/chain'
import type { TxRequest } from '@/lib/useTxFlow'
import { TxButton } from '@/components/TxButton'
import { Countdown, formatAbsolute, useNow } from '@/components/Countdown'

/* ------------------------------------------------------------------ *
 * What the card is given
 * ------------------------------------------------------------------ */

export type MilestoneCardMilestone = {
  /** wei, as a decimal string. Never a `number` — escrow amounts outrun `Number`. */
  amount: string
  check: CheckKind
  state: MState
  /** How many times the freelancer has submitted. A new submission voids an old attestation. */
  submissions: number
  /** Unix seconds the challenge window closes, or 0 when the milestone is not Attested. */
  releasableAt: number
  /** The on-chain commitment to the criteria. Shown when the plain text is not available. */
  criteriaHash?: string | null
  /** The on-chain commitment to the evidence. */
  evidenceHash?: string | null
}

export type MilestoneCardJob = {
  accepted: boolean
  cancelled: boolean
  /** Unix seconds. */
  deadline: number
  /** Seconds. */
  challengeWindow: number
}

export type MilestoneCardProps = {
  escrow: `0x${string}`
  index: number
  milestone: MilestoneCardMilestone
  job: MilestoneCardJob
  /** Derived from the connected address by `roleOf`. Never asked for. */
  role: Role
  /** wei as a decimal string — what this wallet is owed inside the escrow. */
  owed: string
  /** The off-chain criteria this milestone commits to, when the page could resolve them. */
  criteria?: Criteria | null
  /** What the freelancer submitted, when the page could resolve it. */
  evidence?: Evidence | null
  /** The verifier's report, when one exists. */
  report?: Report | null
  /** True when these numbers are the bundled sample job rather than the chain. */
  sample?: boolean
  /** Fired after a send is mined, so the page can refetch chain state. */
  onChanged?: () => void
  /**
   * Escape hatch for the two actions this card cannot build a call for on its own — `submit`
   * needs an evidence hash and `attest` needs the verifier's signature. When a sibling flow owns
   * those, it passes this and the card hands off; when nobody does, the button renders disabled
   * and says exactly what is missing rather than pretending.
   */
  onAction?: (action: ChainAction, index: number) => void
}

/* ------------------------------------------------------------------ *
 * State vocabulary
 * ------------------------------------------------------------------ */

type Tone = 'neutral' | 'accent' | 'warning' | 'success' | 'danger'

const TONE_PILL: Record<Tone, string> = {
  neutral: 'border-zinc-700 bg-zinc-800 text-zinc-300',
  accent: 'border-accent/50 bg-accent/15 text-accent-soft',
  warning: 'border-warning/50 bg-warning/10 text-warning',
  success: 'border-success/50 bg-success/10 text-success',
  danger: 'border-danger/50 bg-danger/10 text-danger',
}

const STATE_META: Record<MState, { label: string; tone: Tone; blurb: string }> = {
  [MSTATE.Pending]: {
    label: 'Pending',
    tone: 'neutral',
    blurb: 'Nothing has been submitted against this milestone yet. Its money is sitting in the escrow.',
  },
  [MSTATE.Submitted]: {
    label: 'Submitted',
    tone: 'accent',
    blurb:
      'The freelancer has handed something in. No passing attestation is on the chain for it, so no challenge window is running.',
  },
  [MSTATE.Attested]: {
    label: 'Attested',
    tone: 'warning',
    blurb:
      'A verifier proposed that this submission meets the criteria. That opened a challenge window — it did not release anything.',
  },
  [MSTATE.Released]: {
    label: 'Released',
    tone: 'success',
    blurb:
      'Settled in the freelancer’s favour. The amount was credited to their balance inside the escrow contract; it is not in their wallet until they withdraw it.',
  },
  [MSTATE.Disputed]: {
    label: 'Disputed',
    tone: 'danger',
    blurb:
      'The client objected inside the challenge window. The milestone is frozen and only the arbiter can move it.',
  },
  [MSTATE.Refunded]: {
    label: 'Refunded',
    tone: 'neutral',
    blurb:
      'Settled in the client’s favour. The amount was credited to their balance inside the escrow contract; it is not in their wallet until they withdraw it.',
  },
}

const CHECK_LABEL: Record<CheckKind, string> = {
  http: 'HTTP check',
  github: 'GitHub check',
  clientApproval: 'Client approval — no automated check',
}

/* ------------------------------------------------------------------ *
 * Criteria, in plain language
 * ------------------------------------------------------------------ */

const quote = (s: string): string => `“${s}”`

const list = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

/**
 * Turn the criteria JSON into sentences.
 *
 * A judge should never have to read `{"expectStatus":200,"mustContain":["Sign in with Google"]}`
 * to find out what was agreed. Same facts, said the way the two people would have said them.
 */
export function criteriaLines(criteria: Criteria): string[] {
  const out: string[] = []

  if (criteria.check === 'http' && criteria.http) {
    const c = criteria.http
    out.push(`Fetch ${c.url}.`)
    out.push(`It must answer with HTTP ${c.expectStatus}.`)
    if (c.mustContain.length > 0) {
      out.push(`The response body must contain ${list(c.mustContain.map(quote))}.`)
    }
    if (c.mustNotContain.length > 0) {
      out.push(`It must not contain ${list(c.mustNotContain.map(quote))}.`)
    }
    out.push(`The check gives up after ${Math.round(c.timeoutMs / 100) / 10} seconds.`)
    return out
  }

  if (criteria.check === 'github' && criteria.github) {
    const g = criteria.github
    out.push(`Repository ${g.repo}, at ${g.ref}.`)
    if (g.requireCommit) out.push('That commit must actually exist on the repository.')
    if (g.requireCheckRun) {
      out.push(`A check run named ${quote(g.requireCheckRun)} must have concluded successfully.`)
    }
    if (g.minStars !== null && g.minStars !== undefined) {
      out.push(`The repository must have at least ${g.minStars} stars.`)
    }
    return out
  }

  if (criteria.check === 'clientApproval') {
    out.push('No automated check runs against this milestone.')
    out.push('It moves when the client approves it, or when an arbiter resolves a dispute.')
    return out
  }

  // The criteria named a check kind but carried no block for it. Say that, do not guess.
  out.push(
    `The agreed criteria say the check is ${quote(criteria.check)} but carry no settings for it, ` +
      'so there is nothing here that could be run automatically.',
  )
  return out
}

/**
 * What a report of this kind actually observed — the sentence the whole product argues for.
 *
 * A passing HTTP check means a server answered. It does not mean the work is good, and a UI that
 * lets somebody believe otherwise has quietly turned a proposal into an authority.
 */
export function observedText(check: CheckKind, passed: boolean, checkedAt: number): string {
  const when = formatAbsolute(checkedAt)

  if (!passed) {
    return (
      `At ${when} at least one of the agreed criteria did not hold. That is a statement about ` +
      'what the check saw at that moment, not a verdict on the person or the work. A failing ' +
      'check does not move the milestone anywhere on its own.'
    )
  }

  switch (check) {
    case 'http':
      return (
        `At ${when} the URL answered with the required status code and the required text was ` +
        'present in the response body. That is the entire observation. It is not a judgement ' +
        'that the work is good, finished, or worth the money — a page can answer 200 and still ' +
        'be wrong.'
      )
    case 'github':
      return (
        `At ${when} the named commit existed at the named ref and any required check run had ` +
        'concluded successfully. Nobody read the code. Green CI is evidence that some tests ran, ' +
        'not that the feature is right.'
      )
    case 'clientApproval':
      return (
        'There is no automated observation for this milestone — the agreed check is the ' +
        'client saying yes. Anything below is context, not a measurement.'
      )
  }
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

type ActionSpec = {
  action: ChainAction
  label: string
  /** Why somebody would press this, in one line. */
  hint: string
  /** Shown after the receipt lands. Where money is involved this must not overstate it. */
  successNote?: string
  /** null when this card cannot build the call itself — see `onAction`. */
  request: TxRequest | null
  /** Extra sentence appended to a block reason when the call cannot be built at all. */
  unbuildable?: string
  variant?: 'primary' | 'secondary' | 'danger'
  /** resolveDispute is two buttons, not one. */
  args?: readonly unknown[]
  key?: string
}

const CREDIT_NOTE =
  'That credited a balance inside the escrow contract. No money has moved to anyone’s wallet ' +
  'yet — the person owed it still has to withdraw from the Wallet tab.'

function specsFor(
  action: ChainAction,
  escrow: `0x${string}`,
  index: number,
  live: boolean,
): ActionSpec[] {
  const i = BigInt(index)
  const call = (functionName: string, args: readonly unknown[]): TxRequest | null =>
    live ? { address: escrow, abi: escrowAbi, functionName, args } : null

  switch (action) {
    case 'submit':
      return [
        {
          action,
          label: `Submit work for milestone ${index + 1}`,
          hint: 'Hands in the evidence the verifier will check against the agreed criteria.',
          request: null,
          unbuildable:
            'Submitting commits a hash of your evidence — the URL or the commit you are handing ' +
            'over — and this card does not collect that. Use the assistant or the submit flow, ' +
            'which builds the evidence and then sends exactly the same call.',
          variant: 'primary',
        },
      ]

    case 'attest':
      return [
        {
          action,
          label: `Relay a verifier attestation for milestone ${index + 1}`,
          hint:
            'Anyone may carry a verifier attestation to the chain — that is deliberate, so the ' +
            'verifier never becomes a gatekeeper who can stall a payout by going offline.',
          request: null,
          unbuildable:
            'The call has to carry the verifier signature over this exact submission, and this ' +
            'page holds no verifier key. Run the check from the assistant and it will produce a ' +
            'signed attestation somebody can relay.',
          variant: 'secondary',
        },
      ]

    case 'approve':
      return [
        {
          action,
          label: `Approve milestone ${index + 1}`,
          hint:
            'Pays out immediately and waives the rest of the challenge window. You do not have ' +
            'to wait for a verifier to agree with you.',
          successNote: CREDIT_NOTE,
          request: call('approve', [i]),
          variant: 'primary',
        },
      ]

    case 'release':
      return [
        {
          action,
          label: `Release milestone ${index + 1}`,
          hint:
            'Available to anyone once the challenge window has run out — the freelancer never ' +
            'has to chase the client for a signature.',
          successNote: CREDIT_NOTE,
          request: call('release', [i]),
          variant: 'primary',
        },
      ]

    case 'dispute':
      return [
        {
          action,
          label: `Dispute milestone ${index + 1}`,
          hint:
            'Freezes this milestone and hands it to the arbiter. Nothing is paid out and nothing ' +
            'is refunded until they decide.',
          request: call('dispute', [i]),
          variant: 'danger',
        },
      ]

    case 'resolveDispute':
      return [
        {
          action,
          key: 'resolveDispute:freelancer',
          label: `Resolve for the freelancer`,
          hint: 'Ends the dispute by awarding this milestone to the freelancer.',
          successNote: CREDIT_NOTE,
          request: call('resolveDispute', [i, true]),
          variant: 'primary',
        },
        {
          action,
          key: 'resolveDispute:client',
          label: `Resolve for the client`,
          hint: 'Ends the dispute by returning this milestone to the client.',
          successNote: CREDIT_NOTE,
          request: call('resolveDispute', [i, false]),
          variant: 'secondary',
        },
      ]

    case 'reclaim':
      return [
        {
          action,
          label: `Reclaim milestone ${index + 1}`,
          hint:
            'Takes the money back after the deadline, for work that was never attested. An ' +
            'attested milestone survives the deadline and can never be reclaimed.',
          successNote: CREDIT_NOTE,
          request: call('reclaim', [i]),
          variant: 'secondary',
        },
      ]

    default:
      return []
  }
}

/* ------------------------------------------------------------------ *
 * Small presentational pieces
 * ------------------------------------------------------------------ */

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONE_PILL[tone]}`}
    >
      {children}
    </span>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-zinc-800 px-4 py-3.5">
      <h4 className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">{title}</h4>
      <div className="mt-2 text-sm leading-relaxed text-zinc-300">{children}</div>
    </section>
  )
}

/** A hash, wrapped so a 66-character string cannot push the page sideways at 380px. */
function Hash({ label, value }: { label: string; value: string }) {
  return (
    <p className="mt-1 text-xs break-all text-zinc-400">
      <span className="text-zinc-400">{label}</span>{' '}
      <span className="font-mono">{value}</span>
    </p>
  )
}

/**
 * A blocked action.
 *
 * A real `<button>`, really disabled, 44px tall, with the sentence from `permits` next to it.
 * Not hidden, and not a paragraph pretending to be a control — somebody has to be able to see
 * that the thing exists and that the chain would refuse it.
 */
function BlockedAction({ label, reason }: { label: string; reason: string }) {
  return (
    <li className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-2.5">
      <button
        type="button"
        disabled
        className="flex min-h-11 w-full cursor-not-allowed items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm font-medium text-zinc-400"
      >
        <span className="min-w-0 truncate">{label}</span>
      </button>
      <p className="mt-2 text-xs leading-relaxed text-zinc-400">{reason}</p>
    </li>
  )
}

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

export function MilestoneCard({
  escrow,
  index,
  milestone,
  job,
  role,
  owed,
  criteria = null,
  evidence = null,
  report = null,
  sample = false,
  onChanged,
  onAction,
}: MilestoneCardProps) {
  const now = useNow()
  const meta = STATE_META[milestone.state]

  // Everything below the fold depends on the connected wallet and on the clock, neither of which
  // exists during SSR. Rendering the verdicts only after mount keeps the first client paint
  // identical to the server HTML instead of hydrating a different set of sentences.
  const ready = now !== null

  const ctx: ActionContext | null = ready
    ? {
        role,
        milestoneState: milestone.state,
        accepted: job.accepted,
        cancelled: job.cancelled,
        now,
        deadline: job.deadline,
        releasableAt: milestone.releasableAt,
        owed,
      }
    : null

  const rows = ctx
    ? MILESTONE_SCOPED_ACTIONS.flatMap((action) => {
        const permission = permits(action, ctx)
        return specsFor(action, escrow, index, !sample).map((spec) => ({ spec, permission }))
      })
    : []

  const allowed = rows.filter((r) => r.permission.allowed)
  const blocked = rows.filter((r) => !r.permission.allowed)

  const headingId = `milestone-${index}-heading`

  return (
    <article
      aria-labelledby={headingId}
      className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900"
    >
      {/* ------------------------------------------------------------------ header */}
      <header className="px-4 pt-4 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">
              Milestone {index + 1}
            </p>
            <h3 id={headingId} className="mt-0.5 text-base font-semibold text-balance text-zinc-100">
              {criteria?.title ?? `Milestone ${index + 1}`}
            </h3>
          </div>
          <Pill tone={meta.tone}>{meta.label}</Pill>
        </div>

        <p className="mt-2 font-mono text-xl tabular-nums text-zinc-100">
          {formatMon(milestone.amount)}{' '}
          <span className="font-sans text-sm font-normal text-zinc-400">MON</span>
        </p>

        <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{meta.blurb}</p>

        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
          <span>{CHECK_LABEL[milestone.check]}</span>
          <span aria-hidden="true">·</span>
          <span>
            {milestone.submissions} submission{milestone.submissions === 1 ? '' : 's'}
          </span>
        </p>
      </header>

      {/* --------------------------------------------------- the one sentence people misread */}
      {milestone.state === MSTATE.Released || milestone.state === MSTATE.Refunded ? (
        <p className="mx-4 mb-3 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm leading-relaxed text-zinc-300">
          <span className="font-semibold text-zinc-100">
            {meta.label} does not mean the money reached a wallet.
          </span>{' '}
          It credited a balance held by the escrow contract. Whoever it belongs to has to call
          withdraw before it is theirs to spend — that is a second transaction, on the Wallet tab.
        </p>
      ) : null}

      {/* ------------------------------------------------------------ the challenge window */}
      {milestone.state === MSTATE.Attested ? (
        <div className="px-4 pb-3">
          <Countdown releasableAt={milestone.releasableAt} onElapsed={onChanged} />
        </div>
      ) : null}

      {/* ----------------------------------------------------------------------- criteria */}
      <Section title="What was agreed">
        {criteria ? (
          <ul className="space-y-1.5">
            {criteriaLines(criteria).map((line) => (
              <li key={line} className="flex gap-2">
                <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-zinc-600" />
                <span className="min-w-0 break-words">{line}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-zinc-400">
            The chain stores only a hash of the agreed criteria — the wording itself lives
            off-chain, and this page has no store wired up to fetch it. All it can honestly show
            you is the commitment the two parties signed up to.
          </p>
        )}
        {milestone.criteriaHash ? <Hash label="criteriaHash" value={milestone.criteriaHash} /> : null}
      </Section>

      {/* ----------------------------------------------------------------------- evidence */}
      {evidence || milestone.evidenceHash ? (
        <Section title="What the freelancer submitted">
          {evidence ? (
            <dl className="space-y-2">
              {evidence.url ? (
                <div>
                  <dt className="text-xs text-zinc-400">Link</dt>
                  <dd className="mt-0.5 min-w-0">
                    <a
                      href={evidence.url}
                      target="_blank"
                      rel="noreferrer noopener nofollow"
                      className="inline-block min-h-11 max-w-full break-all text-accent-soft underline underline-offset-4 hover:text-accent"
                    >
                      {evidence.url}
                    </a>
                  </dd>
                </div>
              ) : null}
              {evidence.repo ? (
                <div>
                  <dt className="text-xs text-zinc-400">Repository</dt>
                  <dd className="mt-0.5 font-mono text-xs break-all text-zinc-200">
                    {evidence.repo}
                  </dd>
                </div>
              ) : null}
              {evidence.commit ? (
                <div>
                  <dt className="text-xs text-zinc-400">Commit</dt>
                  <dd className="mt-0.5 font-mono text-xs break-all text-zinc-200">
                    {evidence.commit}
                  </dd>
                </div>
              ) : null}
              {evidence.note ? (
                <div>
                  {/* Labelled as theirs on purpose. This string is written by a counterparty and
                      must never read as something MonEscrow is asserting. */}
                  <dt className="text-xs text-zinc-400">
                    Note from the freelancer — their words, not ours
                  </dt>
                  <dd className="mt-1 border-l-2 border-zinc-700 pl-3 break-words text-zinc-300 italic">
                    {evidence.note}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt className="text-xs text-zinc-400">Submitted</dt>
                <dd className="mt-0.5 text-zinc-300">{formatAbsolute(evidence.submittedAt)}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-zinc-400">
              The chain holds a hash of the submission. The files and links behind it are
              off-chain and this page cannot resolve them, so it will not pretend to show them.
            </p>
          )}
          {milestone.evidenceHash ? <Hash label="evidenceHash" value={milestone.evidenceHash} /> : null}
        </Section>
      ) : null}

      {/* ------------------------------------------------------------------------- report */}
      {report ? (
        <Section title="What the verifier reported">
          <div
            className={`rounded-xl border px-3 py-2.5 ${
              report.passed
                ? 'border-success/40 bg-success/5'
                : 'border-danger/40 bg-danger/5'
            }`}
          >
            <p
              className={`flex items-center gap-2 text-sm font-semibold ${
                report.passed ? 'text-success' : 'text-danger'
              }`}
            >
              <span
                aria-hidden="true"
                className={`size-2 shrink-0 rounded-full ${report.passed ? 'bg-success' : 'bg-danger'}`}
              />
              {report.passed
                ? 'The verifier proposed that this passed'
                : 'The verifier reported that this did not pass'}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-zinc-300">
              {observedText(milestone.check, report.passed, report.checkedAt)}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-zinc-400">
              A verifier proposes and never decides. A pass opens the challenge window above; the
              client can object inside it, and if nobody does, anyone may release the milestone
              once it closes.
            </p>
          </div>

          <ul className="mt-3 space-y-2">
            {report.checks.map((c) => (
              <li key={c.id} className="flex gap-2.5">
                <span
                  aria-hidden="true"
                  className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[0.6875rem] font-bold ${
                    c.passed ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'
                  }`}
                >
                  {c.passed ? '✓' : '✗'}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm text-zinc-200">
                    {c.label}
                    <span className="sr-only">{c.passed ? ' — matched' : ' — did not match'}</span>
                  </span>
                  <span className="mt-0.5 block font-mono text-xs break-words text-zinc-400">
                    {c.detail}
                  </span>
                </span>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-xs text-zinc-400">
            Checked {formatAbsolute(report.checkedAt)} against submission #{report.submission}.
            {milestone.submissions > report.submission
              ? ' The freelancer has submitted again since, so this report no longer matches the current work and the chain will refuse it.'
              : ''}
          </p>
        </Section>
      ) : milestone.state === MSTATE.Submitted ? (
        <Section title="What the verifier reported">
          <p className="text-zinc-400">
            No attestation is on the chain for this submission. Until a verifier signs one, no
            challenge window is running and nothing is counting down — the client can still
            approve it by hand at any time.
          </p>
        </Section>
      ) : null}

      {/* ------------------------------------------------------------------------ actions */}
      <Section title="What can be done here">
        {!ready ? (
          <p className="text-zinc-400">Working out what this wallet can do here…</p>
        ) : (
          <>
            {allowed.length > 0 ? (
              <ul className="space-y-4">
                {allowed.map(({ spec }) => (
                  <li key={spec.key ?? spec.action}>
                    {/* Hand off only the calls this card genuinely cannot build — never merely
                        because the job is sample data, where nothing should be sendable. */}
                    {!sample && spec.unbuildable && onAction ? (
                      <button
                        type="button"
                        onClick={() => onAction(spec.action, index)}
                        className="flex min-h-11 w-full items-center justify-center rounded-xl bg-accent px-4 text-sm font-semibold text-zinc-950 transition-colors hover:bg-accent/90"
                      >
                        <span className="min-w-0 truncate">{spec.label}</span>
                      </button>
                    ) : (
                      <TxButton
                        label={spec.label}
                        request={spec.request}
                        blockedReason={
                          sample
                            ? 'The chain would accept this from your wallet. It cannot be sent ' +
                              'here because this job is sample data, not a real escrow.'
                            : spec.request === null
                              ? (spec.unbuildable ?? null)
                              : null
                        }
                        hint={spec.hint}
                        successNote={spec.successNote}
                        variant={spec.variant}
                        onSuccess={onChanged ? () => onChanged() : undefined}
                      />
                    )}
                    {!sample && spec.unbuildable && onAction ? (
                      <p className="mt-2 text-xs text-zinc-400">{spec.hint}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-zinc-400">
                Nothing on this milestone is open to this wallet right now. Everything the escrow
                could accept is listed below, with the reason it would refuse.
              </p>
            )}

            {blocked.length > 0 ? (
              <div className="mt-4">
                <h5 className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">
                  Not open to this wallet
                </h5>
                <p className="mt-1 text-xs text-zinc-400">
                  Shown, not hidden. These are the rules the escrow enforces on everybody,
                  including whoever deployed it.
                </p>
                <ul className="mt-2 space-y-2">
                  {blocked.map(({ spec, permission }) => (
                    <BlockedAction
                      key={spec.key ?? spec.action}
                      label={spec.label}
                      reason={
                        permission.allowed
                          ? ''
                          : spec.request === null && spec.unbuildable
                            ? `${permission.reason} ${spec.unbuildable}`
                            : permission.reason
                      }
                    />
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </Section>
    </article>
  )
}

export default MilestoneCard
