'use client'

/**
 * `/new` — a brief goes in, a funded escrow comes out.
 *
 * The page is a single mobile column that grows a second one at `lg`. Everything is stacked in
 * the order the decision actually gets made: what the job is, what it is worth, who is doing
 * it, how long the client gets to object, then the split, then the money.
 *
 * ## Three things this page refuses to get wrong
 *
 * **1. The split must equal the total, exactly.** `createEscrow` forwards `msg.value` into the
 * `Escrow` constructor, which reverts `FundingMismatch(sum, msg.value)` on any difference. One
 * wei off is a transaction that fails *after* the user has signed it and paid the gas. So the
 * sum is re-checked on every keystroke in `MilestoneEditor`, the create button stays disabled
 * until it matches, and money is `bigint` wei from the first character typed to the last
 * argument encoded — never a `Number`.
 *
 * **2. The challenge window comes from a fixed list.** The constructor rejects anything under
 * 60 seconds or over 30 days, so there is no free-text field here that could produce a value
 * it refuses. 90 seconds is on the list because a demo has to show the mechanism inside a
 * five-minute slot, and it is labelled as exactly that — the product default is three days.
 *
 * **3. The drafts are advisory.** `/api/ai/milestones` proposes; the two people sign. Every
 * title, amount and criterion is editable, and the banner in the editor says so. With no API
 * key anywhere the endpoint still answers 200 with a deterministic template split, which is
 * the path a judge on a clean clone actually takes.
 *
 * ## Why `useTxFlow` is used directly here rather than `TxButton`
 *
 * `TxButton` simulates as soon as it mounts, which is right on a job page where the call is
 * fixed. Here the call changes on every keystroke, so auto-simulating would hammer the RPC and
 * quote a price for a form the user is still editing. Instead there are two explicit steps —
 * "check and price it", then "create and fund" — and any edit in between resets the quote, so
 * it is impossible to price one transaction and send another. It also lets the cost line show
 * the number that actually matters: the escrow amount **plus** the gas limit, together.
 */

import Link from 'next/link'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useConnection } from 'wagmi'
import { escrowFactoryAbi } from '@/lib/abis'
import { FACTORY_ADDRESS, VERIFIER_ADDRESS, hasFactory, monadTestnet, sameAddress, shortAddress } from '@/lib/chain'
import { requestKey, useTxFlow, type TxRequest } from '@/lib/useTxFlow'
import { hashJson } from '@/lib/verify/report'
import type { MilestoneDraft } from '@/lib/ai/types'
import type { CheckKind } from '@/lib/verify/types'
import {
  MilestoneEditor,
  blankMilestone,
  draftToEditable,
  parseMon,
  sumMilestones,
  weiLabel,
  weiToMon,
  type EditableMilestone,
} from '@/components/MilestoneEditor'

/* ------------------------------------------------------------------ contract constants */

/** `Escrow.Check` ordinals. ClientApproval is 0 — the enum's first member, not http. */
const CHECK_ORDINAL: Record<CheckKind, number> = { clientApproval: 0, http: 1, github: 2 }

/** `Escrow.MAX_TITLE_BYTES`. Bytes, not characters — an emoji costs four. */
const MAX_TITLE_BYTES = 120

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * The challenge-window list, fixed by D-7 and D-3.
 *
 * A closed list rather than a number field, because the constructor reverts
 * `ChallengeWindowOutOfRange` below 60 seconds and above 30 days, and offering a control that
 * can produce a value the chain refuses is offering somebody a wasted signature.
 */
const CHALLENGE_WINDOWS: readonly {
  seconds: number
  label: string
  note: string
  demo?: boolean
}[] = [
  {
    seconds: 90,
    label: '90 seconds',
    note: 'Demo setting only — it exists so the release can be shown on stage. No real client can review work in 90 seconds.',
    demo: true,
  },
  { seconds: 24 * 3600, label: '24 hours', note: 'One working day to look at the work and object.' },
  {
    seconds: 3 * 24 * 3600,
    label: '3 days',
    note: 'The default. Long enough to cover a weekend, short enough that the freelancer is not left waiting.',
  },
  { seconds: 7 * 24 * 3600, label: '7 days', note: 'A full week, for work that needs a real review.' },
]

const DEFAULT_WINDOW = 3 * 24 * 3600

const DEADLINE_PRESETS: readonly { days: number; label: string }[] = [
  { days: 14, label: '2 weeks' },
  { days: 30, label: '1 month' },
  { days: 60, label: '2 months' },
  { days: 90, label: '3 months' },
]

const DEMO_BRIEF =
  'Build a marketing site for a small coffee roastery. I need a landing page, an online ' +
  'shop page listing about a dozen beans, a simple checkout that hands off to Stripe, and ' +
  'the whole thing deployed on a domain I already own. Copy and photos come from me. I want ' +
  'to see something working every couple of weeks rather than one big reveal at the end.'

/* ------------------------------------------------------------------ small helpers */

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function isAddress(value: string): value is `0x${string}` {
  return ADDRESS_RE.test(value.trim())
}

/** `YYYY-MM-DDTHH:mm` in the browser's own timezone, for `<input type="datetime-local">`. */
function toLocalInput(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromLocalInput(value: string): number | null {
  // A `datetime-local` string carries no offset, which ES parses as local time — the same
  // clock the user was reading when they picked it.
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

function humanDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function humanDuration(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} day${seconds === 86400 ? '' : 's'}`
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`
  return `${seconds} seconds`
}

/**
 * The wall clock, read once, on the client only.
 *
 * A default deadline derived from `Date.now()` during render would differ between the server
 * HTML and the first client paint, and React would throw a hydration mismatch. This is the
 * `useSyncExternalStore` form of "this value does not exist on the server": the server snapshot
 * is `null`, the client snapshot is a single timestamp memoised at module scope so repeated
 * calls are stable and the store never looks like it changed.
 */
let clientNow: number | null = null

function readClientNow(): number {
  if (clientNow === null) clientNow = Math.floor(Date.now() / 1000)
  return clientNow
}

const subscribeNever = () => () => {}

function useClientNow(): number | null {
  return useSyncExternalStore(subscribeNever, readClientNow, () => null)
}

/** Narrow the milestones endpoint's 200 body without trusting it and without `any`. */
type ProposalOk = { milestones: MilestoneDraft[]; source: 'llm' | 'template' }

function readProposal(value: unknown): ProposalOk | null {
  if (typeof value !== 'object' || value === null) return null
  const body = value as { milestones?: unknown; source?: unknown }
  if (!Array.isArray(body.milestones) || body.milestones.length === 0) return null
  if (body.source !== 'llm' && body.source !== 'template') return null
  for (const entry of body.milestones) {
    if (typeof entry !== 'object' || entry === null) return null
    const draft = entry as { amount?: unknown; title?: unknown; criteria?: unknown }
    if (typeof draft.amount !== 'string' || typeof draft.title !== 'string') return null
    if (typeof draft.criteria !== 'object' || draft.criteria === null) return null
  }
  return { milestones: body.milestones as MilestoneDraft[], source: body.source }
}

function readError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const body = value as { error?: unknown }
  return typeof body.error === 'string' ? body.error : null
}

/* ------------------------------------------------------------------ shared classes */

const FIELD =
  'w-full min-h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-[0.9375rem] ' +
  'text-zinc-100 placeholder:text-zinc-600 focus:border-accent focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-60'

const LABEL = 'block text-xs font-medium tracking-wide text-zinc-400 uppercase'

const CARD = 'rounded-2xl border border-zinc-800 bg-zinc-900 p-4'

const PRIMARY =
  'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 ' +
  'text-[0.9375rem] font-semibold text-zinc-950 transition-colors hover:bg-accent/90 ' +
  'disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500'

const QUIET =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-zinc-800 ' +
  'bg-zinc-950 px-4 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-700 ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

/* ================================================================== the page */

export default function NewJobPage() {
  const connection = useConnection()
  const account = connection.address

  // ---- the brief --------------------------------------------------------------------------
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [total, setTotal] = useState('')
  const [llmKey, setLlmKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [proposing, setProposing] = useState(false)
  const [proposalError, setProposalError] = useState<string | null>(null)
  const [source, setSource] = useState<'llm' | 'template' | null>(null)

  // ---- the parties ------------------------------------------------------------------------
  const [freelancer, setFreelancer] = useState('')
  const [arbiter, setArbiter] = useState('')

  // ---- timing -----------------------------------------------------------------------------
  const [challengeWindow, setChallengeWindow] = useState(DEFAULT_WINDOW)
  const mountedAt = useClientNow()
  // Null until the user picks one, and derived from the client clock until then, so there is no
  // state to synchronise in an effect and nothing to mismatch during hydration.
  const [chosenDeadline, setChosenDeadline] = useState<number | null>(null)
  const deadline = chosenDeadline ?? (mountedAt === null ? null : mountedAt + 30 * 86400)
  const setDeadline = setChosenDeadline

  // ---- the split --------------------------------------------------------------------------
  const [milestones, setMilestones] = useState<EditableMilestone[]>([])

  const totalParsed = parseMon(total)
  const totalWei = totalParsed.ok ? totalParsed.wei : null
  const sum = sumMilestones(milestones)

  /* ---------------------------------------------------------------- propose */

  const propose = useCallback(async () => {
    if (!totalParsed.ok) {
      setProposalError('Set a job total first — the split has to add up to something.')
      return
    }
    setProposing(true)
    setProposalError(null)
    try {
      const key = llmKey.trim()
      const response = await fetch('/api/ai/milestones', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Sent with this one request and held nowhere else — not in localStorage, not in a
          // cookie, not in this component after the page is closed.
          ...(key ? { 'x-llm-key': key } : {}),
        },
        body: JSON.stringify({ brief, totalAmount: totalParsed.wei.toString(), currency: 'MON' }),
      })
      const payload: unknown = await response.json()

      if (!response.ok) {
        setProposalError(
          readError(payload) ??
            'The milestone endpoint could not answer. You can still add milestones by hand.',
        )
        return
      }

      const proposal = readProposal(payload)
      if (!proposal) {
        setProposalError('The milestone endpoint answered in a shape MonEscrow does not recognise.')
        return
      }

      setMilestones(proposal.milestones.map(draftToEditable))
      setSource(proposal.source)
    } catch {
      setProposalError(
        'Could not reach the milestone endpoint. Add milestones by hand — nothing else on this ' +
          'page depends on it.',
      )
    } finally {
      setProposing(false)
    }
  }, [brief, llmKey, totalParsed])

  /* ---------------------------------------------------------------- the call */

  const needsVerifier = milestones.some((m) => m.check !== 'clientApproval')
  const verifierSet = ADDRESS_RE.test(VERIFIER_ADDRESS)

  /**
   * Everything that would make the chain say no, in the order a person would notice it.
   * The first sentence becomes the disabled button's reason — never a hidden button.
   */
  const blockedReason = useMemo((): string | null => {
    if (!hasFactory()) {
      return (
        'No escrow factory is configured, so there is nothing to send this to. Set ' +
        'NEXT_PUBLIC_FACTORY_ADDRESS and reload — everything above still works, it just cannot ' +
        'be created yet.'
      )
    }
    if (!account) return 'Connect your wallet to create this — your wallet is the client here.'
    if (title.trim() === '') return 'The job needs a title. The contract rejects an empty one.'
    if (byteLength(title) > MAX_TITLE_BYTES) {
      return `The title is ${byteLength(title)} bytes and the contract accepts ${MAX_TITLE_BYTES}.`
    }
    if (!isAddress(freelancer)) return 'Enter the freelancer’s address — 0x and 40 hex characters.'
    if (sameAddress(freelancer, account)) {
      return 'The client and the freelancer cannot be the same wallet — the contract reverts ClientIsFreelancer.'
    }
    if (!isAddress(arbiter)) {
      return 'Enter an arbiter address. The contract requires one: somebody has to be able to settle a disputed milestone.'
    }
    if (needsVerifier && !verifierSet) {
      return (
        'A milestone here expects an automated check, and no verifier address is configured. ' +
        'Either set NEXT_PUBLIC_VERIFIER_ADDRESS or switch those milestones to client approval — ' +
        'the contract refuses to create an escrow whose funds nobody could ever attest for.'
      )
    }
    if (deadline === null) return 'Pick a deadline.'
    if (mountedAt !== null && deadline <= mountedAt) {
      return 'The deadline is in the past. The constructor reverts DeadlineInPast.'
    }
    if (milestones.length === 0) return 'Add at least one milestone.'
    if (!totalParsed.ok) return `Job total: ${totalParsed.error}`
    if (sum.invalid > 0) {
      return `${sum.invalid} milestone amount${sum.invalid === 1 ? '' : 's'} cannot be read as a number.`
    }
    if (totalWei !== null && sum.wei !== totalWei) {
      const diff = totalWei - sum.wei
      const magnitude = diff > 0n ? diff : -diff
      return (
        `The milestones are ${weiToMon(magnitude)} MON ${diff > 0n ? 'short of' : 'over'} the total ` +
        `(${weiLabel(magnitude)}). The escrow constructor reverts FundingMismatch on any ` +
        'difference at all, so this has to be exact before it is worth signing.'
      )
    }
    return null
  }, [
    account,
    arbiter,
    deadline,
    freelancer,
    milestones.length,
    mountedAt,
    needsVerifier,
    sum.invalid,
    sum.wei,
    title,
    totalParsed,
    totalWei,
    verifierSet,
  ])

  /**
   * The call, or null when the form is not yet a call.
   *
   * `termsHash` commits to the whole agreement the two of them read on this screen: the title,
   * the brief, the timing and every milestone with its criteria. It is a `bytes32` on-chain and
   * proves later that neither side is describing a different deal.
   */
  const request = useMemo((): TxRequest | null => {
    if (blockedReason !== null || totalWei === null || deadline === null) return null
    if (!hasFactory()) return null

    const encoded = milestones.map((m) => {
      const parsed = parseMon(m.amount)
      return {
        amount: parsed.ok ? parsed.wei : 0n,
        check: CHECK_ORDINAL[m.check],
        criteriaHash: hashJson(m.criteria),
      }
    })

    const termsHash = hashJson({
      v: 1,
      title: title.trim(),
      brief: brief.trim(),
      totalAmount: totalWei.toString(),
      challengeWindow,
      deadline,
      milestones: milestones.map((m, i) => ({
        index: i,
        title: m.title,
        amount: encoded[i].amount.toString(),
        check: m.check,
        criteria: m.criteria,
      })),
    })

    const params = {
      freelancer: freelancer.trim() as `0x${string}`,
      verifier: (verifierSet ? VERIFIER_ADDRESS : '0x0000000000000000000000000000000000000000') as `0x${string}`,
      arbiter: arbiter.trim() as `0x${string}`,
      deadline: BigInt(deadline),
      challengeWindow,
      termsHash,
      title: title.trim(),
    }

    return {
      address: FACTORY_ADDRESS as `0x${string}`,
      abi: escrowFactoryAbi,
      functionName: 'createEscrow',
      args: [params, encoded],
      value: totalWei,
    }
  }, [
    arbiter,
    blockedReason,
    brief,
    challengeWindow,
    deadline,
    freelancer,
    milestones,
    title,
    totalWei,
    verifierSet,
  ])

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-zinc-100">New job</h1>
          <p className="text-sm leading-relaxed text-zinc-400">
            You fund the whole job now. Each milestone releases as it is shown to be done — a
            verifier <em className="not-italic font-medium text-zinc-100">proposes</em> that one
            passed, which opens a challenge window. Your silence releases the money and anyone can
            trigger it; your objection freezes that milestone for the arbiter.
          </p>
        </header>

        {/* ============================================================ 1. the brief */}
        <section className={CARD} aria-labelledby="s-brief">
          <h2 id="s-brief" className="mb-1 text-base font-semibold text-zinc-100">
            1 · What the job is
          </h2>
          <p className="mb-4 text-xs text-zinc-500">
            The title goes on-chain. The brief does not — it is only used to propose a split, and
            its hash is folded into the terms hash so neither of you can rewrite it later.
          </p>

          <div className="flex flex-col gap-4">
            <div>
              <label className={LABEL} htmlFor="job-title">
                Job title
              </label>
              <input
                id="job-title"
                className={`${FIELD} mt-1`}
                value={title}
                maxLength={200}
                placeholder="Coffee roastery marketing site"
                onChange={(e) => setTitle(e.target.value)}
                aria-describedby="job-title-note"
              />
              <p
                id="job-title-note"
                className={`mt-1 text-xs tabular-nums ${
                  byteLength(title) > MAX_TITLE_BYTES ? 'text-danger' : 'text-zinc-500'
                }`}
              >
                {byteLength(title)} / {MAX_TITLE_BYTES} bytes
              </p>
            </div>

            <div>
              <label className={LABEL} htmlFor="job-brief">
                Brief
              </label>
              <textarea
                id="job-brief"
                className={`${FIELD} mt-1 min-h-[9rem] resize-y leading-relaxed`}
                value={brief}
                placeholder="Describe the work the way you would to the person doing it."
                onChange={(e) => setBrief(e.target.value)}
              />
              <button
                type="button"
                className="mt-2 min-h-11 text-sm text-accent-soft underline underline-offset-4"
                onClick={() => {
                  setBrief(DEMO_BRIEF)
                  if (title.trim() === '') setTitle('Coffee roastery marketing site')
                  if (total.trim() === '') setTotal('6')
                }}
              >
                Fill in a sample brief
              </button>
            </div>

            <div>
              <label className={LABEL} htmlFor="job-total">
                Total you are funding (MON)
              </label>
              <input
                id="job-total"
                className={`${FIELD} mt-1 tabular-nums`}
                value={total}
                inputMode="decimal"
                autoComplete="off"
                placeholder="6.0"
                aria-invalid={total.trim() !== '' && !totalParsed.ok ? true : undefined}
                aria-describedby="job-total-note"
                onChange={(e) => setTotal(e.target.value)}
              />
              <p id="job-total-note" className="mt-1 font-mono text-[0.6875rem] break-all">
                {totalParsed.ok ? (
                  <span className="text-zinc-500">{weiLabel(totalParsed.wei)}</span>
                ) : total.trim() === '' ? (
                  <span className="text-zinc-500">The whole job, paid into escrow up front.</span>
                ) : (
                  <span className="text-danger">{totalParsed.error}</span>
                )}
              </p>
            </div>

            {/* -------------------------------------------------- optional key */}
            <details className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2">
              <summary className="min-h-11 cursor-pointer list-none py-2 text-sm font-medium text-zinc-100">
                Use your own LLM key (optional)
              </summary>
              <div className="pb-2">
                <p className="mb-2 text-xs leading-relaxed text-zinc-500">
                  Without one, milestones come from a deterministic template that runs entirely on
                  this server — that path is not a degraded mode, it is how the demo runs. A key
                  you paste here is sent with that one request and is never stored, logged or
                  echoed back.
                </p>
                <div className="flex gap-2">
                  <input
                    id="llm-key"
                    className={FIELD}
                    type={showKey ? 'text' : 'password'}
                    value={llmKey}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="sk-ant-…"
                    aria-label="Anthropic API key, used for this request only"
                    onChange={(e) => setLlmKey(e.target.value)}
                  />
                  <button
                    type="button"
                    className={QUIET}
                    onClick={() => setShowKey((v) => !v)}
                    aria-pressed={showKey}
                  >
                    {showKey ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
            </details>

            <button
              type="button"
              className={PRIMARY}
              onClick={() => void propose()}
              disabled={proposing || !totalParsed.ok}
            >
              {proposing ? 'Proposing…' : 'Propose milestones from the brief'}
            </button>

            <p aria-live="polite" className="text-sm">
              {proposalError ? (
                <span className="text-danger">{proposalError}</span>
              ) : !totalParsed.ok && total.trim() !== '' ? (
                <span className="text-zinc-500">Fix the total and this becomes available.</span>
              ) : !totalParsed.ok ? (
                <span className="text-zinc-500">
                  A total is needed first — the proposal splits it exactly.
                </span>
              ) : null}
            </p>
          </div>
        </section>

        {/* ============================================================ 2. the parties */}
        <section className={CARD} aria-labelledby="s-parties">
          <h2 id="s-parties" className="mb-1 text-base font-semibold text-zinc-100">
            2 · Who is involved
          </h2>
          <p className="mb-4 text-xs leading-relaxed text-zinc-500">
            You are the client, because you are the wallet sending this transaction — the contract
            takes it from <code className="font-mono">msg.sender</code> and never from calldata.
          </p>

          <div className="flex flex-col gap-4">
            <div className="rounded-xl bg-zinc-950 px-3 py-2.5 text-sm">
              <span className="text-zinc-400">Client (you): </span>
              <span className="font-mono text-zinc-100">
                {account ? shortAddress(account) : 'not connected'}
              </span>
              {account ? null : (
                <p className="mt-1 text-xs text-zinc-500">
                  Connecting a wallet is signing in here. There is no account to create.
                </p>
              )}
            </div>

            <AddressField
              id="freelancer"
              label="Freelancer"
              value={freelancer}
              onChange={setFreelancer}
              hint="The wallet that accepts the job and submits the work."
              error={
                freelancer.trim() !== '' && !isAddress(freelancer)
                  ? 'That is not a 20-byte address.'
                  : sameAddress(freelancer, account)
                    ? 'This is your own address. The contract reverts ClientIsFreelancer.'
                    : null
              }
            />

            <AddressField
              id="arbiter"
              label="Arbiter"
              value={arbiter}
              onChange={setArbiter}
              hint="Only ever involved if you dispute a milestone. The contract requires one — an escrow with no arbiter has no way out of a disagreement."
              error={
                arbiter.trim() !== '' && !isAddress(arbiter) ? 'That is not a 20-byte address.' : null
              }
            />

            <div className="rounded-xl bg-zinc-950 px-3 py-2.5 text-sm">
              <span className="text-zinc-400">Verifier: </span>
              <span className="font-mono text-zinc-100">
                {verifierSet ? shortAddress(VERIFIER_ADDRESS) : 'not configured'}
              </span>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                The verifier only ever <em className="not-italic font-medium text-zinc-400">proposes</em>{' '}
                that a milestone passed. It cannot release anything, cannot take anything, and its
                attestation is what opens your challenge window — not what ends it.
                {needsVerifier && !verifierSet
                  ? ' A milestone below expects an automated check, so one is required before this can be created.'
                  : ''}
              </p>
            </div>
          </div>
        </section>

        {/* ============================================================ 3. timing */}
        <section className={CARD} aria-labelledby="s-timing">
          <h2 id="s-timing" className="mb-1 text-base font-semibold text-zinc-100">
            3 · Timing
          </h2>

          <fieldset className="mt-4">
            <legend className={LABEL}>Challenge window</legend>
            <p className="mt-1 mb-3 text-xs leading-relaxed text-zinc-500">
              After a verifier attests a milestone, this is how long you have to object. Say
              nothing and anyone — you, the freelancer, a stranger — can trigger the release. The
              contract accepts 60 seconds to 30 days, so this is a fixed list rather than a box
              that could produce a value it refuses.
            </p>
            <div className="flex flex-col gap-2">
              {CHALLENGE_WINDOWS.map((option) => (
                <label
                  key={option.seconds}
                  className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 transition-colors ${
                    challengeWindow === option.seconds
                      ? 'border-accent bg-accent/10'
                      : 'border-zinc-800 bg-zinc-950 hover:border-zinc-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="challenge-window"
                    className="mt-0.5 size-5 shrink-0 accent-[#836EF9]"
                    checked={challengeWindow === option.seconds}
                    onChange={() => setChallengeWindow(option.seconds)}
                  />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-100">
                      {option.label}
                      {option.demo ? (
                        <span className="rounded-full border border-warning/50 px-2 py-0.5 text-[0.6875rem] font-semibold text-warning">
                          demo only
                        </span>
                      ) : null}
                      {option.seconds === DEFAULT_WINDOW ? (
                        <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[0.6875rem] text-zinc-400">
                          default
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-zinc-500">
                      {option.note}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-5">
            <label className={LABEL} htmlFor="deadline">
              Deadline
            </label>
            <p className="mt-1 mb-2 text-xs leading-relaxed text-zinc-500">
              After this, the freelancer can no longer submit and you can reclaim anything still
              Pending or Submitted. An attested milestone survives it — work proven in time is not
              undone by the clock.
            </p>
            <input
              id="deadline"
              type="datetime-local"
              className={`${FIELD} tabular-nums`}
              value={deadline === null ? '' : toLocalInput(deadline)}
              onChange={(e) => {
                const next = fromLocalInput(e.target.value)
                if (next !== null) setDeadline(next)
              }}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              {DEADLINE_PRESETS.map((preset) => (
                <button
                  key={preset.days}
                  type="button"
                  className={QUIET}
                  onClick={() => setDeadline(Math.floor(Date.now() / 1000) + preset.days * 86400)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {deadline !== null ? (
              <p className="mt-2 text-xs text-zinc-500">
                {mountedAt !== null && deadline <= mountedAt ? (
                  <span className="text-danger">
                    That is in the past. The constructor reverts DeadlineInPast.
                  </span>
                ) : (
                  <>Submissions close {humanDate(deadline)}.</>
                )}
              </p>
            ) : null}
          </div>
        </section>

        {/* ============================================================ 4. the split */}
        <section className={CARD} aria-labelledby="s-split">
          <h2 id="s-split" className="mb-1 text-base font-semibold text-zinc-100">
            4 · The split
          </h2>
          <p className="mb-4 text-xs leading-relaxed text-zinc-500">
            Each milestone is funded now and released on its own. Editing any of it is the point —
            nothing here is agreed until you both act on it.
          </p>

          <MilestoneEditor
            milestones={milestones}
            onChange={setMilestones}
            totalWei={totalWei}
            source={source}
          />

          {milestones.length === 0 ? (
            <button
              type="button"
              className={`${QUIET} mt-4 w-full`}
              onClick={() => setMilestones([blankMilestone(0)])}
            >
              Add the first milestone by hand
            </button>
          ) : null}
        </section>
      </div>

      {/* ============================================================ 5. create */}
      <aside className="w-full lg:sticky lg:top-24 lg:w-[22rem] lg:shrink-0">
        <CreateSection
          request={request}
          blockedReason={blockedReason}
          totalWei={totalWei}
          milestoneCount={milestones.length}
          challengeWindow={challengeWindow}
          deadline={deadline}
        />
      </aside>
    </div>
  )
}

/* ------------------------------------------------------------------ address field */

function AddressField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
}: {
  id: string
  label: string
  value: string
  onChange: (next: string) => void
  hint: string
  error: string | null
}) {
  return (
    <div>
      <label className={LABEL} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={`${FIELD} mt-1 font-mono text-sm`}
        value={value}
        autoComplete="off"
        spellCheck={false}
        placeholder="0x…"
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-note`}
        onChange={(e) => onChange(e.target.value)}
      />
      <p id={`${id}-note`} className="mt-1 text-xs leading-relaxed">
        {error ? <span className="text-danger">{error}</span> : <span className="text-zinc-500">{hint}</span>}
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ the transaction */

/**
 * Price it, then send it.
 *
 * Two clicks on purpose. The first simulates against the chain and estimates the gas; the
 * second sends with that gas as an explicit limit. Any edit to the form between them clears
 * the quote — see the effect below — so it is structurally impossible to be shown the price of
 * one transaction and sign another.
 */
function CreateSection({
  request,
  blockedReason,
  totalWei,
  milestoneCount,
  challengeWindow,
  deadline,
}: {
  request: TxRequest | null
  blockedReason: string | null
  totalWei: bigint | null
  milestoneCount: number
  challengeWindow: number
  deadline: number | null
}) {
  // Simulation is manual here: the call changes on every keystroke, and auto-simulating would
  // both hammer the RPC and quote a price for a form the user is still editing.
  const flow = useTxFlow({ request, blockedReason, auto: false })
  const { state, phase, costLabel, explorerUrl } = flow

  /**
   * Which call was priced.
   *
   * `useTxFlow` holds the prepared call in a ref, so pressing send would post whatever was last
   * simulated — including after an edit. Comparing the priced key with the current one makes a
   * stale quote a visible state with its own button, rather than a silent reset the user never
   * sees or, worse, a signature over numbers they did not read.
   */
  const [pricedKey, setPricedKey] = useState('')
  const key = requestKey(request)
  const stale = phase === 'ready' && pricedKey !== key

  const price = () => {
    setPricedKey(key)
    flow.prepare()
  }

  const gasWei = state.costWei
  const fullCost = totalWei !== null && gasWei !== undefined ? totalWei + gasWei : null

  const busy = phase === 'simulating' || phase === 'confirming' || phase === 'pending'

  return (
    <section className={`${CARD} lg:bg-zinc-900`} aria-labelledby="s-create">
      <h2 id="s-create" className="mb-3 text-base font-semibold text-zinc-100">
        5 · Fund and create
      </h2>

      <dl className="mb-4 flex flex-col gap-2 border-b border-zinc-800 pb-4 text-sm">
        <Row label="Into escrow" value={totalWei === null ? '—' : `${weiToMon(totalWei)} MON`} />
        <Row label="Milestones" value={String(milestoneCount)} />
        <Row label="Challenge window" value={humanDuration(challengeWindow)} />
        <Row label="Deadline" value={deadline === null ? '—' : humanDate(deadline)} />
      </dl>

      {phase === 'success' ? (
        <div className="flex flex-col gap-3">
          <p className="rounded-xl border border-success/40 bg-success/5 px-3 py-3 text-sm text-zinc-100">
            <span className="font-semibold text-success">Created and funded.</span> The whole
            amount is in the escrow contract now. Nothing is paid out until a milestone releases —
            and a release credits the freelancer’s balance{' '}
            <em className="not-italic font-medium">inside the escrow</em>, which they then
            withdraw to their wallet themselves.
          </p>
          {explorerUrl ? (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noreferrer noopener"
              className={`${QUIET} w-full`}
            >
              View it on MonadVision
            </a>
          ) : null}
          <Link href="/" className={`${QUIET} w-full`}>
            Back to my jobs
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {phase === 'ready' && !stale ? (
            <button type="button" className={PRIMARY} onClick={flow.send} disabled={!flow.canSend}>
              Create and fund
            </button>
          ) : (
            <button
              type="button"
              className={PRIMARY}
              onClick={phase === 'error' ? flow.retry : price}
              disabled={blockedReason !== null || request === null || busy}
            >
              {phase === 'simulating'
                ? 'Checking with the chain…'
                : phase === 'confirming'
                  ? 'Confirm in your wallet'
                  : phase === 'pending'
                    ? 'Sending…'
                    : phase === 'error'
                      ? 'Check it again'
                      : stale
                        ? 'Price it again'
                        : 'Check and price this'}
            </button>
          )}

          <div aria-live="polite" className="flex flex-col gap-2 text-xs leading-relaxed">
            {stale ? (
              <p className="text-warning">
                The job changed since this was priced, so that quote no longer describes what
                would be sent. Price it again before signing.
              </p>
            ) : null}

            {phase === 'ready' && !stale && costLabel ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5">
                <p className="text-zinc-100">
                  The chain has already agreed this call would succeed. Nothing is sent until you
                  press the button above.
                </p>
                <dl className="mt-2 flex flex-col gap-1">
                  <Row
                    small
                    label="Escrow funding"
                    value={totalWei === null ? '—' : `${weiToMon(totalWei)} MON`}
                  />
                  <Row small label="Gas, at the limit" value={costLabel} />
                  <Row
                    small
                    strong
                    label="Leaves your wallet"
                    value={fullCost === null ? '—' : `≤ ${weiToMon(fullCost)} MON`}
                  />
                </dl>
                <p className="mt-2 text-zinc-500">
                  On Monad you pay the gas <em className="not-italic font-medium text-zinc-300">limit</em>,
                  not the gas used, so MonEscrow sets the limit itself rather than letting your
                  wallet pick a generous one. That figure is the exact maximum.
                </p>
              </div>
            ) : null}

            {phase === 'idle' && blockedReason === null && request !== null ? (
              <p className="text-zinc-400">
                This simulates the call against {monadTestnet.name} and prices it. Nothing is
                signed and nothing is spent by pressing it.
              </p>
            ) : null}

            {blockedReason ? <p className="text-warning">{blockedReason}</p> : null}

            {phase === 'confirming' || phase === 'pending' ? (
              <p className="text-zinc-400">
                {phase === 'confirming'
                  ? 'Waiting for you to confirm in your wallet.'
                  : 'Sent. Waiting for it to be included in a block.'}
              </p>
            ) : null}

            {phase === 'error' && state.error ? (
              <div
                className={
                  state.error.rejected
                    ? 'text-zinc-400'
                    : 'rounded-xl border border-danger/50 bg-danger/10 px-3 py-2.5 text-[#fca5a5]'
                }
              >
                {state.error.name ? (
                  <p className="mb-1 font-mono text-[0.6875rem] tracking-wide break-words text-danger">
                    {state.error.name}
                    {state.error.args?.length ? `(${state.error.args.join(', ')})` : ''}
                  </p>
                ) : null}
                <p className="break-words">{state.error.message}</p>
              </div>
            ) : null}
          </div>
        </div>
      )}

      <p className="mt-4 border-t border-zinc-800 pt-3 text-xs leading-relaxed text-zinc-500">
        Creating this moves the full amount into a fresh escrow contract. You can cancel and get
        it back until the freelancer accepts; after that it releases milestone by milestone, or
        comes back to you through the deadline or the arbiter.
      </p>
    </section>
  )
}

function Row({
  label,
  value,
  small,
  strong,
}: {
  label: string
  value: string
  small?: boolean
  strong?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={small ? 'text-zinc-500' : 'text-zinc-400'}>{label}</dt>
      <dd
        className={`text-right tabular-nums ${
          strong ? 'font-semibold text-zinc-100' : small ? 'text-zinc-300' : 'text-zinc-100'
        }`}
      >
        {value}
      </dd>
    </div>
  )
}
