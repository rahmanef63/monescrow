'use client'

/**
 * The job card — and the small data layer the three dock screens share.
 *
 * ## Why the data layer lives here
 *
 * `/`, `/actions` and `/wallet` are three views of one question: *what is true about the jobs
 * this address is party to?* Answering it three times would be three chances to disagree about
 * whose money is where, so it is answered once, here, and the pages render the answer.
 *
 * ## What it never does
 *
 * It never decides whether an action is allowed. Every verdict on this page comes out of
 * `permits` / `availableActions` in `@/lib/chat/permissions` — the C1 table as code. A card that
 * says "waiting on you" says it because the table said the call would succeed, not because this
 * file has an opinion about escrow.
 *
 * ## Two facts the copy is careful about
 *
 *   1. The verifier **proposes**. An attestation is a claim that a milestone passed; it opens a
 *      challenge window. Nothing here calls the verifier an approver or an authority.
 *   2. **Released is not withdrawn.** A released milestone credits a balance *inside the escrow*.
 *      MON moves to a wallet only when somebody calls `withdraw`. Every place this file says
 *      "released" near a number, it says that too.
 */

import Link from 'next/link'
import { useMemo, useSyncExternalStore } from 'react'
import { parseEther } from 'viem'
import { useQuery } from '@tanstack/react-query'
import { useConfig, useConnection } from 'wagmi'
import { getPublicClient } from 'wagmi/actions'
import { escrowAbi, escrowFactoryAbi } from '@/lib/abis'
import { FACTORY_ADDRESS, formatMon, hasFactory, sameAddress, shortAddress } from '@/lib/chain'
import {
  ALL_ACTIONS,
  MILESTONE_SCOPED_ACTIONS,
  availableActions,
  roleOf,
} from '@/lib/chat/permissions'
import {
  MSTATE,
  type ActionContext,
  type ChainAction,
  type JobView,
  type MState,
  type MilestoneView,
  type Permission,
  type Role,
} from '@/lib/chat/types'
import type { CheckKind } from '@/lib/verify/types'

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

/**
 * A job plus one account's balance in it, in wei as a decimal string.
 *
 * `owed` is not part of `JobView` because a job is the same job for everybody and a balance is
 * emphatically not. It rides along because `permits('withdraw', …)` needs it and because
 * `/wallet` is a list of exactly this pair.
 *
 * `owedFor` is the address `owed` belongs to, and it is not optional. A balance without its owner
 * is the kind of value that gets read against the wrong wallet and offers somebody a withdraw
 * button for money that is not theirs — `contextFor` refuses to use `owed` unless the address
 * asking matches this one.
 */
export type JobWithOwed = JobView & {
  readonly owed: string
  readonly owedFor: `0x${string}`
}

/** Where the rendered jobs came from. The UI must never let these two look alike. */
export type JobsSource = 'chain' | 'sample'

export type JobsStatus =
  | 'booting' // still hydrating; nothing is knowable yet
  | 'no-factory' // NEXT_PUBLIC_FACTORY_ADDRESS is unset — we never asked the chain anything
  | 'disconnected' // no wallet, and the wallet is the login
  | 'loading' // asking the chain
  | 'error'
  | 'ready'

export type MyJobs = {
  /** Unix seconds, ticking. `0` until the component has mounted. */
  now: number
  /** The connected address, or null. Never a role — roles are derived per job. */
  viewer: `0x${string}` | null
  /**
   * The address the rendered jobs should be read against.
   *
   * Identical to `viewer` for chain data. For sample data it is `SAMPLE_VIEWER`, because the
   * sample jobs are told from that address — reading them against a freshly connected wallet
   * would make a judge the *stranger* in every one of them and hide the whole product.
   */
  renderViewer: `0x${string}`
  jobs: readonly JobWithOwed[]
  source: JobsSource
  status: JobsStatus
  error: string | null
  refetch: () => void
}

/* ------------------------------------------------------------------ *
 * Clocks
 * ------------------------------------------------------------------ */

/**
 * The wall clock, as an external store.
 *
 * Two values, one subscription:
 *
 *   `now`     unix seconds, ticking, so challenge windows count down
 *   `anchor`  the first second this tab knew about, frozen forever after
 *
 * The anchor is what the sample jobs are built against. Rebuilding them from `now` each second
 * would keep every deadline the same distance away and every countdown would sit motionless at
 * the same value — the bug that makes a demo look fake.
 *
 * A store rather than `useState` + `useEffect` because that is what this is: React synchronising
 * with an external system it does not own. It also means one interval for the whole page instead
 * of one per card, and `getServerSnapshot` gives every clock-dependent view a stable `0` on the
 * server so nothing hydrates into a mismatch. Callers read `0` as "not yet" and render a
 * skeleton.
 */
export type Clock = { now: number; anchor: number }

const CLOCK_ZERO: Clock = { now: 0, anchor: 0 }

let clockValue: Clock = CLOCK_ZERO
let clockTimer: number | null = null
const clockListeners = new Set<() => void>()

function tickClock() {
  const seconds = Math.floor(Date.now() / 1000)
  clockValue = { now: seconds, anchor: clockValue.anchor === 0 ? seconds : clockValue.anchor }
  for (const listener of clockListeners) listener()
}

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener)
  if (clockTimer === null) {
    clockTimer = window.setInterval(tickClock, 1000)
    tickClock()
  }
  return () => {
    clockListeners.delete(listener)
    if (clockListeners.size === 0 && clockTimer !== null) {
      window.clearInterval(clockTimer)
      clockTimer = null
    }
  }
}

const readClock = (): Clock => clockValue
const readServerClock = (): Clock => CLOCK_ZERO

export function useClock(): Clock {
  return useSyncExternalStore(subscribeClock, readClock, readServerClock)
}

/** Unix seconds, ticking. `0` until this tab has mounted and read its own clock. */
export function useNow(): number {
  return useClock().now
}

/** "1d 4h", "2h 13m", "48s", "now". Two units at most — it has to fit a 380px badge. */
export function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  if (total === 0) return 'now'
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`
  return `${s}s`
}

export type CountdownProps = { to: number; now: number; className?: string }

/** A live countdown to a unix timestamp. `<time>` so it is not just a number to a screen reader. */
export function Countdown({ to, now, className }: CountdownProps) {
  const left = to - now
  return (
    <time
      dateTime={new Date(to * 1000).toISOString()}
      className={`tabular-nums ${className ?? ''}`}
    >
      {left > 0 ? formatCountdown(left) : 'elapsed'}
    </time>
  )
}

/* ------------------------------------------------------------------ *
 * Permission plumbing — thin wrappers, no second table
 * ------------------------------------------------------------------ */

/** Actions that are about the whole job rather than one milestone: accept, cancel, withdraw. */
export const ESCROW_LEVEL_ACTIONS: readonly ChainAction[] = ALL_ACTIONS.filter(
  (a) => !MILESTONE_SCOPED_ACTIONS.includes(a),
)

/**
 * Everything `permits` needs, assembled from a job and the address asking. Nothing here is a
 * judgement — the role is derived by `roleOf` and the verdict is left to `permits`.
 *
 * The one guard: `owed` is only passed through when the asking address is the one the balance
 * was read for. Any other address is owed nothing by this record, and saying so is what stops a
 * withdraw button appearing over somebody else's money.
 */
export function contextFor(
  job: JobWithOwed,
  viewer: string | null,
  now: number,
  milestone?: MilestoneView,
): ActionContext {
  return {
    role: roleOf(viewer, job),
    milestoneState: milestone?.state,
    accepted: job.acceptedAt > 0,
    cancelled: job.cancelled,
    now,
    deadline: job.deadline,
    releasableAt: milestone?.releasableAt ?? 0,
    owed: sameAddress(viewer, job.owedFor) ? job.owed : '0',
  }
}

/** How urgent a row is, and therefore which heading it sits under on `/actions`. */
export type AwaitingGroup = 'frozen' | 'you' | 'anyone' | 'money' | 'clock' | 'verifier'

export const AWAITING_GROUPS: readonly AwaitingGroup[] = [
  'frozen',
  'you',
  'anyone',
  'money',
  'clock',
  'verifier',
]

export type Awaiting = {
  key: string
  job: JobWithOwed
  role: Role
  action: ChainAction
  /** Zero-based milestone index, or null for a job-level action. */
  milestone: number | null
  permission: Permission
  group: AwaitingGroup
  /** When a clock is the only thing in the way, the unix second it stops being in the way. */
  waitingUntil: number | null
}

/** Actions that are a chore sitting in *your* queue. `dispute` is an objection, not a chore. */
const YOURS: readonly ChainAction[] = ['accept', 'cancel', 'submit', 'approve', 'reclaim']

/**
 * Everything about one job that is currently awaiting somebody, built out of `availableActions`.
 *
 * Deliberately not "every blocked verdict": there are ten actions per milestone and nine of them
 * are blocked at any moment, so dumping the lot would bury the one that matters. What survives:
 *
 *   every **allowed** action worth doing,
 *   the one **blocked** verdict that is only blocked by a clock — a running challenge window,
 *   and the fact that a submitted milestone is **waiting on the verifier**, which is not an
 *   action anybody on this screen can take but is the answer to "why is nothing happening".
 */
export function awaitingFor(job: JobWithOwed, viewer: string | null, now: number): Awaiting[] {
  const role = roleOf(viewer, job)
  const out: Awaiting[] = []
  const at = (action: ChainAction, milestone: number | null) =>
    `${job.escrow}:${milestone ?? 'job'}:${action}`

  // ---- job-level: accept, cancel, withdraw
  const jobCtx = contextFor(job, viewer, now)
  for (const verdict of availableActions(jobCtx)) {
    if (!ESCROW_LEVEL_ACTIONS.includes(verdict.action)) continue
    if (!verdict.permission.allowed) continue
    out.push({
      key: at(verdict.action, null),
      job,
      role,
      action: verdict.action,
      milestone: null,
      permission: verdict.permission,
      group: verdict.action === 'withdraw' ? 'money' : 'you',
      waitingUntil: null,
    })
  }

  // ---- per milestone
  for (const m of job.milestones) {
    const ctx = contextFor(job, viewer, now, m)
    const verdicts = availableActions(ctx)
    const verdictOf = (action: ChainAction): Permission =>
      verdicts.find((v) => v.action === action)?.permission ?? {
        allowed: false,
        reason: 'Unknown action.',
      }

    const push = (action: ChainAction, group: AwaitingGroup, waitingUntil: number | null) =>
      out.push({
        key: at(action, m.index),
        job,
        role,
        action,
        milestone: m.index,
        permission: verdictOf(action),
        group,
        waitingUntil,
      })

    if (verdictOf('resolveDispute').allowed) push('resolveDispute', 'frozen', null)
    for (const action of YOURS) {
      if (!MILESTONE_SCOPED_ACTIONS.includes(action)) continue
      if (verdictOf(action).allowed) push(action, 'you', null)
    }

    const release = verdictOf('release')
    if (release.allowed) {
      push('release', 'anyone', null)
    } else if (m.state === MSTATE.Attested && now < m.releasableAt) {
      // Blocked by the clock and nothing else. Shown disabled, with the reason from the table
      // and a countdown, because "2 hours left" teaches the mechanism and a hidden row does not.
      push('release', 'clock', m.releasableAt)
    }

    // `attest` is permitted for anyone but carries a verifier signature nobody here holds, so it
    // is never a button. It is the honest answer to "why is my submitted milestone just sitting
    // there" — the verifier has not proposed a result yet.
    if (verdictOf('attest').allowed) push('attest', 'verifier', null)
  }

  return out
}

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

export const MSTATE_LABEL: Record<MState, string> = {
  [MSTATE.Pending]: 'Pending',
  [MSTATE.Submitted]: 'Submitted',
  [MSTATE.Attested]: 'Attested',
  [MSTATE.Released]: 'Released',
  [MSTATE.Disputed]: 'Disputed',
  [MSTATE.Refunded]: 'Refunded',
}

export const ROLE_LABEL: Record<Role, string> = {
  client: 'You are the client',
  freelancer: 'You are the freelancer',
  arbiter: 'You are the arbiter',
  stranger: 'You are not a party',
}

export const CHECK_LABEL: Record<CheckKind, string> = {
  http: 'checked by URL',
  github: 'checked on GitHub',
  clientApproval: 'client sign-off',
}

/** Imperative, human, milestone numbers 1-based. */
export function actionLabel(a: Awaiting): string {
  const n = a.milestone === null ? 0 : a.milestone + 1
  switch (a.action) {
    case 'accept':
      return 'Accept this job'
    case 'cancel':
      return 'Cancel this job'
    case 'submit':
      return `Submit milestone ${n}`
    case 'attest':
      return `Milestone ${n} is with the verifier`
    case 'approve':
      return `Approve milestone ${n}`
    case 'release':
      return `Release milestone ${n}`
    case 'dispute':
      return `Dispute milestone ${n}`
    case 'resolveDispute':
      return `Resolve milestone ${n}`
    case 'reclaim':
      return `Reclaim milestone ${n}`
    case 'withdraw':
      return `Withdraw ${formatMon(a.job.owed)} MON`
  }
}

/** Why this is here, in one sentence, said without overstating what anything means. */
export function actionRationale(a: Awaiting): string {
  const n = a.milestone === null ? 0 : a.milestone + 1
  switch (a.action) {
    case 'accept':
      return 'The client has funded the whole job. Accepting starts the clock and lets you submit milestones.'
    case 'cancel':
      return 'Nobody has accepted yet, so you can cancel and take the escrow back.'
    case 'submit':
      return `Send your evidence for milestone ${n}. The verifier reads it and proposes a result — it does not decide anything.`
    case 'attest':
      return `Milestone ${n} is submitted and waiting for the off-chain verifier to propose a result. Nobody here can sign that for it, and the client can approve without waiting.`
    case 'approve':
      return `Approving pays milestone ${n} out immediately, without waiting for the challenge window.`
    case 'release':
      return `The challenge window on milestone ${n} has run out with no objection, so anyone may push the payment through — including you.`
    case 'dispute':
      return `Objecting freezes milestone ${n} for the arbiter instead of letting it release.`
    case 'resolveDispute':
      return `Milestone ${n} is frozen and waiting on your decision: it goes to the freelancer or back to the client.`
    case 'reclaim':
      return `The deadline passed with milestone ${n} unproven, so you can take its funds back out of the escrow.`
    case 'withdraw':
      return 'Money credited to you inside the escrow. Withdrawing is the step that actually moves MON into your wallet.'
  }
}

/** What to say once the receipt lands. This is where the release/withdraw myth gets corrected. */
export function actionSuccessNote(a: Awaiting): string | undefined {
  const n = a.milestone === null ? 0 : a.milestone + 1
  switch (a.action) {
    case 'approve':
    case 'release':
      return `Milestone ${n} now reads Released. That credited the freelancer's balance inside the escrow — it did not move MON to their wallet. They collect it with a withdraw.`
    case 'reclaim':
      return `Milestone ${n} now reads Refunded, and its funds are credited to you inside the escrow. Withdraw on the Wallet screen to move the MON to your wallet.`
    case 'withdraw':
      return 'That one really did move MON. Your wallet balance should change once the block settles.'
    default:
      return undefined
  }
}

/* ------------------------------------------------------------------ *
 * The single most urgent fact about a job
 * ------------------------------------------------------------------ */

export type UrgencyTone = 'danger' | 'warning' | 'accent' | 'success' | 'muted'

export type Urgency = {
  tone: UrgencyTone
  /** Badge text. Short enough for 380px. */
  label: string
  /** One sentence under it. */
  detail: string
  /** Renders a live countdown next to the label. */
  countdownTo?: number
}

const SETTLED: readonly MState[] = [MSTATE.Released, MSTATE.Refunded]

/**
 * The one thing worth saying about a job on a card, chosen in priority order.
 *
 * A card that lists six facts is a card nobody reads at 380px. So: a frozen dispute beats a
 * running challenge window, which beats a chore in your queue, which beats money sitting in the
 * escrow, which beats "done".
 */
export function urgencyOf(job: JobWithOwed, viewer: string | null, now: number): Urgency {
  const role = roleOf(viewer, job)
  const rows = awaitingFor(job, viewer, now)
  const has = (g: AwaitingGroup) => rows.filter((r) => r.group === g)

  if (job.cancelled) {
    return {
      tone: 'muted',
      label: 'Cancelled',
      detail:
        'The client cancelled before anyone accepted. Whatever was escrowed is refundable from the Wallet screen.',
    }
  }

  const disputed = job.milestones.find((m) => m.state === MSTATE.Disputed)
  if (disputed) {
    return {
      tone: 'danger',
      label: 'Frozen — disputed',
      detail:
        role === 'arbiter'
          ? `Milestone ${disputed.index + 1} is frozen and waiting on your decision.`
          : `The client objected to milestone ${disputed.index + 1}, so it is frozen until the arbiter decides where its funds go.`,
    }
  }

  const clock = has('clock')[0]
  if (clock && clock.waitingUntil !== null) {
    const n = (clock.milestone ?? 0) + 1
    return {
      tone: 'warning',
      label: 'Challenge window',
      countdownTo: clock.waitingUntil,
      detail:
        role === 'client'
          ? `The verifier proposed that milestone ${n} passed. Say nothing and it releases; dispute it and it freezes for the arbiter.`
          : `The verifier proposed that milestone ${n} passed. If the client stays silent, anyone can release it when the window runs out.`,
    }
  }

  const anyone = has('anyone')[0]
  if (anyone) {
    const n = (anyone.milestone ?? 0) + 1
    return {
      tone: 'accent',
      label: 'Ready to release',
      detail: `The window on milestone ${n} closed with no objection. Anyone can push the payment through — it credits the freelancer's escrow balance, which they then withdraw.`,
    }
  }

  const yours = has('you')[0]
  if (yours) {
    return { tone: 'accent', label: 'Waiting on you', detail: actionRationale(yours) }
  }

  const verifier = has('verifier')[0]
  if (verifier) {
    const n = (verifier.milestone ?? 0) + 1
    return {
      tone: 'muted',
      label: 'With the verifier',
      detail: `Milestone ${n} is submitted. The verifier is expected to propose a result — it never decides one.`,
    }
  }

  if (has('money')[0]) {
    return {
      tone: 'success',
      label: `${formatMon(job.owed)} MON to withdraw`,
      detail:
        'This escrow is holding money credited to you. Released is not the same as withdrawn — collect it on the Wallet screen.',
    }
  }

  if (job.milestones.every((m) => SETTLED.includes(m.state))) {
    return {
      tone: 'success',
      label: 'Complete',
      detail: 'Every milestone has settled and nothing here is owed to you.',
    }
  }

  if (now < job.deadline) {
    return {
      tone: 'muted',
      label: 'In progress',
      countdownTo: job.deadline,
      detail: 'Nothing is waiting on you right now. The job deadline is counting down.',
    }
  }

  return {
    tone: 'muted',
    label: 'Past deadline',
    detail: 'The deadline has passed and nothing here is currently actionable by this wallet.',
  }
}

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

const URGENCY_SKIN: Record<UrgencyTone, { box: string; dot: string; text: string }> = {
  danger: { box: 'border-danger/40 bg-danger/10', dot: 'bg-danger', text: 'text-danger' },
  warning: { box: 'border-warning/40 bg-warning/10', dot: 'bg-warning', text: 'text-warning' },
  accent: { box: 'border-accent/40 bg-accent/10', dot: 'bg-accent', text: 'text-accent-soft' },
  success: { box: 'border-success/40 bg-success/10', dot: 'bg-success', text: 'text-success' },
  muted: { box: 'border-zinc-800 bg-zinc-950', dot: 'bg-zinc-500', text: 'text-zinc-400' },
}

export function jobHref(job: JobView): string {
  return `/job/${job.escrow}`
}

export type JobCardProps = {
  job: JobWithOwed
  viewer: string | null
  now: number
}

/**
 * One job, as a card.
 *
 * A card and not a table row on purpose: a five-column table at 380px is either a horizontal
 * scroll or a font nobody can read, and this app's primary layout is the phone.
 *
 * The whole card is one link, so there is nothing inside it to mis-tap — every action lives on
 * the job page or on `/actions`, where it can be rendered with its cost and its reason.
 */
export function JobCard({ job, viewer, now }: JobCardProps) {
  const role = roleOf(viewer, job)
  const urgency = urgencyOf(job, viewer, now)
  const skin = URGENCY_SKIN[urgency.tone]

  const counterparty =
    role === 'client'
      ? { label: 'Freelancer', address: job.freelancer }
      : role === 'freelancer'
        ? { label: 'Client', address: job.client }
        : { label: 'Client', address: job.client }

  const total = BigInt(job.totalAmount)
  const released = BigInt(job.releasedAmount)
  const refunded = BigInt(job.refundedAmount)
  const settledCount = job.milestones.filter((m) => SETTLED.includes(m.state)).length
  const pct =
    total > 0n ? Number(((released + refunded) * 1000n) / total) / 10 : 0

  const unaccepted = job.acceptedAt === 0 && !job.cancelled

  return (
    <li className="min-w-0">
      <Link
        href={jobHref(job)}
        className="group block min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900 p-4 transition-colors hover:border-zinc-700 hover:bg-zinc-800/60"
      >
        {/* --------------------------------------------------------- title + role */}
        <div className="flex min-w-0 items-start justify-between gap-3">
          <h3 className="min-w-0 text-[0.9375rem] leading-snug font-semibold break-words text-zinc-100">
            {job.untrusted.title || 'Untitled job'}
          </h3>
          <span className="shrink-0 rounded-full border border-zinc-700 bg-zinc-950 px-2 py-1 text-[0.6875rem] font-medium whitespace-nowrap text-zinc-400">
            {role === 'client'
              ? 'Client'
              : role === 'freelancer'
                ? 'Freelancer'
                : role === 'arbiter'
                  ? 'Arbiter'
                  : 'Observer'}
          </span>
        </div>

        {/* --------------------------------------------------------- counterparty */}
        <p className="mt-1 text-xs text-zinc-400">
          {counterparty.label}{' '}
          <span className="font-mono text-zinc-300">
            {unaccepted && role === 'client'
              ? 'not accepted yet'
              : shortAddress(counterparty.address)}
          </span>
          <span className="sr-only">. {ROLE_LABEL[role]}.</span>
        </p>

        {/* --------------------------------------------------------- money + progress */}
        <p className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-zinc-100">
          <span className="text-2xl font-semibold tabular-nums">{formatMon(job.totalAmount)} MON</span>
          <span className="text-xs text-zinc-400">escrowed in total</span>
        </p>
        <p className="mt-0.5 text-xs text-zinc-400">
          <span className="tabular-nums text-zinc-300">
            {settledCount} of {job.milestones.length}
          </span>{' '}
          {job.milestones.length === 1 ? 'milestone' : 'milestones'} settled ·{' '}
          <span className="tabular-nums text-zinc-300">{formatMon(job.releasedAmount)} MON</span>{' '}
          released to an escrow balance
        </p>

        <div
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800"
          role="img"
          aria-label={`${settledCount} of ${job.milestones.length} milestones settled`}
        >
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        </div>

        {/* --------------------------------------------------------- the one urgent fact */}
        <div className={`mt-3 min-w-0 rounded-xl border ${skin.box} p-3`}>
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${skin.dot}`} />
            <span className={`text-sm font-semibold ${skin.text}`}>{urgency.label}</span>
            {urgency.countdownTo !== undefined && now > 0 ? (
              <span className="rounded-md bg-zinc-950/60 px-1.5 py-0.5 text-xs font-medium text-zinc-100">
                <Countdown to={urgency.countdownTo} now={now} /> left
              </span>
            ) : null}
          </p>
          <p className="mt-1.5 text-sm leading-relaxed break-words text-zinc-400">
            {urgency.detail}
          </p>
        </div>

        <p className="mt-3 text-sm font-medium text-accent-soft group-hover:text-accent">
          Open this job <span aria-hidden="true">→</span>
        </p>
      </Link>
    </li>
  )
}

/* ------------------------------------------------------------------ *
 * Sample data
 * ------------------------------------------------------------------ */

const SAMPLE_ME = '0x7A1c9F3b2E5d4A6c8B0f1E2d3C4b5A6978d0E1f2' as const
const SAMPLE_CLIENT = '0x2B5eC1d9A4f37E608c1D2a3B4c5D6e7F8091A2b3' as const
const SAMPLE_FREELANCER = '0x9c4D1e8F0a2B3c4D5e6F7081A2b3C4d5E6f70819' as const
const SAMPLE_ARBITER = '0x3F8b2C1d0E9a8B7c6D5e4F3a2B1c0D9e8F7a6B5c' as const
const SAMPLE_VERIFIER = '0x6d5C4b3A2918e7F6a5B4c3D2e1F0a9B8c7D6e5F4' as const

/** The address the sample jobs are told from. Shown on screen so nobody mistakes it for theirs. */
export const SAMPLE_VIEWER: `0x${string}` = SAMPLE_ME

const wei = (mon: string): string => parseEther(mon).toString()

type SampleMilestone = {
  amount: string
  check: CheckKind
  state: MState
  submissions?: number
  /** Seconds from the anchor. Only meaningful for an Attested milestone. */
  releasableIn?: number
}

function milestones(list: readonly SampleMilestone[], anchor: number): MilestoneView[] {
  return list.map((m, index) => ({
    index,
    amount: wei(m.amount),
    check: m.check,
    state: m.state,
    submissions: m.submissions ?? (m.state === MSTATE.Pending ? 0 : 1),
    releasableAt:
      m.state === MSTATE.Attested && m.releasableIn !== undefined ? anchor + m.releasableIn : 0,
  }))
}

const DAY = 86400

/**
 * Six jobs that between them show every state the app can be in, told from one address.
 *
 * Times are relative to `anchor` — a single second captured once when the page mounts, never
 * `Date.now()` per render, or every countdown would sit frozen at the same value forever.
 */
export function sampleJobs(anchor: number): JobWithOwed[] {
  if (anchor === 0) return []

  const base = {
    verifier: SAMPLE_VERIFIER,
    arbiter: SAMPLE_ARBITER,
    refundedAmount: '0',
    cancelled: false,
    // Every sample balance belongs to the sample viewer and to nobody else. Rendering these
    // jobs against a real connected wallet must not hand it a withdraw button.
    owedFor: SAMPLE_ME,
  } as const

  return [
    // 1 — a challenge window running, seen by the client. The teaching case.
    {
      ...base,
      escrow: '0xa1B2c3D4e5F60718293A4b5C6d7E8f9012345678',
      client: SAMPLE_ME,
      freelancer: SAMPLE_FREELANCER,
      totalAmount: wei('4.5'),
      releasedAmount: wei('1.5'),
      deadline: anchor + 12 * DAY,
      challengeWindow: 2 * 3600,
      acceptedAt: anchor - 9 * DAY,
      milestones: milestones(
        [
          { amount: '1.5', check: 'clientApproval', state: MSTATE.Released },
          { amount: '2', check: 'http', state: MSTATE.Attested, releasableIn: 6_913 },
          { amount: '1', check: 'github', state: MSTATE.Pending },
        ],
        anchor,
      ),
      untrusted: { title: 'Marketing site rebuild', notes: [] },
      owed: '0',
    },
    // 2 — window elapsed: anyone can release. Seen by the freelancer, who is also owed.
    {
      ...base,
      escrow: '0xB2c3D4e5F60718293A4b5C6d7E8f901234567890',
      client: SAMPLE_CLIENT,
      freelancer: SAMPLE_ME,
      totalAmount: wei('3'),
      releasedAmount: wei('1'),
      deadline: anchor + 5 * DAY,
      challengeWindow: 24 * 3600,
      acceptedAt: anchor - 14 * DAY,
      milestones: milestones(
        [
          { amount: '1', check: 'github', state: MSTATE.Released },
          { amount: '2', check: 'github', state: MSTATE.Attested, releasableIn: -640 },
        ],
        anchor,
      ),
      untrusted: { title: 'Vault contract fix pass', notes: [] },
      owed: wei('1'),
    },
    // 3 — submitted, verifier has not proposed anything yet, client can approve regardless.
    {
      ...base,
      escrow: '0xC3d4E5f60718293A4b5C6d7E8f90123456789012',
      client: SAMPLE_ME,
      freelancer: SAMPLE_FREELANCER,
      totalAmount: wei('2.4'),
      releasedAmount: '0',
      deadline: anchor + 6 * DAY,
      challengeWindow: 12 * 3600,
      acceptedAt: anchor - 2 * DAY,
      milestones: milestones(
        [
          { amount: '0.9', check: 'http', state: MSTATE.Submitted, submissions: 1 },
          { amount: '0.8', check: 'clientApproval', state: MSTATE.Pending },
          { amount: '0.7', check: 'clientApproval', state: MSTATE.Pending },
        ],
        anchor,
      ),
      untrusted: { title: 'Design system for the mobile app', notes: [] },
      owed: '0',
    },
    // 4 — funded and offered, not accepted. Seen by the freelancer it was offered to.
    {
      ...base,
      escrow: '0xD4e5F60718293A4b5C6d7E8f9012345678901234',
      client: SAMPLE_CLIENT,
      freelancer: SAMPLE_ME,
      totalAmount: wei('6'),
      releasedAmount: '0',
      deadline: anchor + 3 * DAY,
      challengeWindow: 24 * 3600,
      acceptedAt: 0,
      milestones: milestones(
        [
          { amount: '3', check: 'github', state: MSTATE.Pending },
          { amount: '3', check: 'http', state: MSTATE.Pending },
        ],
        anchor,
      ),
      untrusted: { title: 'Data pipeline migration', notes: [] },
      owed: '0',
    },
    // 5 — disputed and frozen for the arbiter.
    {
      ...base,
      escrow: '0xE5f60718293A4b5C6d7E8f901234567890123456',
      client: SAMPLE_ME,
      freelancer: SAMPLE_FREELANCER,
      totalAmount: wei('2'),
      releasedAmount: '0',
      deadline: anchor + 20 * DAY,
      challengeWindow: 48 * 3600,
      acceptedAt: anchor - 30 * DAY,
      milestones: milestones(
        [{ amount: '2', check: 'clientApproval', state: MSTATE.Disputed }],
        anchor,
      ),
      untrusted: { title: 'Brand identity refresh', notes: [] },
      owed: '0',
    },
    // 6 — everything released, money still sitting in the escrow. The whole point of /wallet.
    {
      ...base,
      escrow: '0xF60718293A4b5C6d7E8f90123456789012345678',
      client: SAMPLE_CLIENT,
      freelancer: SAMPLE_ME,
      totalAmount: wei('2.75'),
      releasedAmount: wei('2.75'),
      deadline: anchor - 2 * DAY,
      challengeWindow: 24 * 3600,
      acceptedAt: anchor - 40 * DAY,
      milestones: milestones(
        [
          { amount: '1.25', check: 'http', state: MSTATE.Released },
          { amount: '1.5', check: 'github', state: MSTATE.Released },
        ],
        anchor,
      ),
      untrusted: { title: 'Docs site and API reference', notes: [] },
      owed: wei('2.75'),
    },
  ]
}

/* ------------------------------------------------------------------ *
 * Reading the chain
 * ------------------------------------------------------------------ */

/**
 * `Escrow.Check` ordinals, in the order the enum declares them in `Escrow.sol`. Same list as the
 * chat route's chain reader — if one of them is ever wrong they are both wrong, which is the
 * point of keeping them spelled identically.
 */
const CHECK_KINDS: readonly CheckKind[] = ['clientApproval', 'http', 'github']

type ChainSummary = {
  escrow: `0x${string}`
  client: `0x${string}`
  freelancer: `0x${string}`
  verifier: `0x${string}`
  arbiter: `0x${string}`
  totalAmount: bigint
  releasedAmount: bigint
  refundedAmount: bigint
  deadline: bigint
  challengeWindow: number
  acceptedAt: bigint
  cancelled: boolean
  termsHash: `0x${string}`
  title: string
  accountOwed: bigint
}

type ChainMilestone = {
  amount: bigint
  check: number
  state: number
  submissions: number
  attestedAt: bigint
}

function toMState(raw: number): MState {
  const known = Object.values(MSTATE).find((s) => s === raw)
  return known ?? MSTATE.Pending
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'The chain read failed and gave no reason.'
}

/**
 * Every escrow this address is a party to, with what it owes them.
 *
 * `escrowsOf` is the factory's own index of "jobs touching this address", so there is no log
 * scan and no server. `summary(account)` answers the job and the caller's balance in one call;
 * `releasableAt(i)` is asked of the contract rather than recomputed from `attestedAt +
 * challengeWindow`, because a second implementation of that sum is a second thing that can be
 * wrong about when somebody gets paid.
 */
async function readMyJobs(
  config: ReturnType<typeof useConfig>,
  me: `0x${string}`,
): Promise<JobWithOwed[]> {
  const client = getPublicClient(config)
  if (!client) {
    throw new Error(`No RPC transport is configured for chain ${config.chains[0]?.id ?? '?'}.`)
  }
  const factory = FACTORY_ADDRESS as `0x${string}`

  const escrows = (await client.readContract({
    address: factory,
    abi: escrowFactoryAbi,
    functionName: 'escrowsOf',
    args: [me],
  })) as readonly `0x${string}`[]

  return Promise.all(
    escrows.map(async (escrow): Promise<JobWithOwed> => {
      const [rawSummary, rawMilestones] = await Promise.all([
        client.readContract({
          address: escrow,
          abi: escrowAbi,
          functionName: 'summary',
          args: [me],
        }) as Promise<unknown>,
        client.readContract({
          address: escrow,
          abi: escrowAbi,
          functionName: 'milestones',
        }) as Promise<unknown>,
      ])

      const s = rawSummary as ChainSummary
      const ms = rawMilestones as readonly ChainMilestone[]

      const releasableAt = await Promise.all(
        ms.map(
          (_, i) =>
            client.readContract({
              address: escrow,
              abi: escrowAbi,
              functionName: 'releasableAt',
              args: [BigInt(i)],
            }) as Promise<bigint>,
        ),
      )

      return {
        escrow,
        client: s.client,
        freelancer: s.freelancer,
        arbiter: s.arbiter,
        verifier: s.verifier,
        totalAmount: s.totalAmount.toString(),
        releasedAmount: s.releasedAmount.toString(),
        refundedAmount: s.refundedAmount.toString(),
        deadline: Number(s.deadline),
        challengeWindow: Number(s.challengeWindow),
        acceptedAt: Number(s.acceptedAt),
        cancelled: s.cancelled,
        milestones: ms.map((m, i) => ({
          index: i,
          amount: m.amount.toString(),
          check: CHECK_KINDS[m.check] ?? 'clientApproval',
          state: toMState(m.state),
          submissions: Number(m.submissions),
          releasableAt: Number(releasableAt[i]),
        })),
        untrusted: { title: s.title, notes: [] },
        owed: s.accountOwed.toString(),
        owedFor: me,
      }
    }),
  )
}

/**
 * The one hook the three dock screens share.
 *
 * It returns sample data whenever it cannot return real data, and it always says which — the
 * screens render `source` prominently, because a sample escrow that looks like a real one is a
 * worse bug than a blank page.
 */
export function useMyJobs(): MyJobs {
  const { now, anchor } = useClock()
  const config = useConfig()
  const connection = useConnection()

  const viewer = (connection.address ?? null) as `0x${string}` | null
  const factoryConfigured = hasFactory()
  const live = factoryConfigured && viewer !== null

  const query = useQuery<JobWithOwed[]>({
    queryKey: ['monescrow', 'myJobs', FACTORY_ADDRESS, viewer],
    enabled: live,
    queryFn: () => readMyJobs(config, viewer as `0x${string}`),
  })

  const samples = useMemo(() => sampleJobs(anchor), [anchor])

  return useMemo((): MyJobs => {
    const refetch = () => {
      void query.refetch()
    }
    const sample = (status: JobsStatus, jobs: readonly JobWithOwed[]): MyJobs => ({
      now,
      viewer,
      renderViewer: SAMPLE_VIEWER,
      jobs,
      source: 'sample',
      status,
      error: null,
      refetch,
    })
    const chain = (status: JobsStatus, jobs: readonly JobWithOwed[], error: string | null) => ({
      now,
      viewer,
      renderViewer: (viewer ?? SAMPLE_VIEWER) as `0x${string}`,
      jobs,
      source: 'chain' as const,
      status,
      error,
      refetch,
    })

    if (now === 0 || anchor === 0) return sample('booting', [])
    if (!factoryConfigured) return sample('no-factory', samples)
    if (viewer === null) return sample('disconnected', samples)
    if (query.isPending) return chain('loading', [], null)
    if (query.isError) return chain('error', [], messageOf(query.error))
    return chain('ready', query.data ?? [], null)
  }, [now, anchor, viewer, factoryConfigured, samples, query])
}

export default JobCard
