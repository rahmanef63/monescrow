'use client'

/**
 * `/job/0x…` — the page the whole product is.
 *
 * This is the URL somebody pastes into a Discord thread, so it has to be legible to four
 * different people without any of them being asked who they are:
 *
 *   the client       who funded it and is the only one who can object
 *   the freelancer   who did the work and wants the money
 *   the arbiter      who only matters once somebody objects
 *   a stranger       who was sent the link and should still learn how it works
 *
 * The role is derived by `roleOf` from the connected address against the escrow's own client /
 * freelancer / arbiter fields. There is no role picker anywhere in this app, and adding one
 * would be a security hole wearing a convenience costume — the chain does not care what you
 * claim to be.
 *
 * Two claims this page refuses to let anyone walk away with:
 *
 *   - **The verifier decided.** It did not. It proposes; the client's silence or objection is
 *     what settles a milestone, and once the challenge window closes *anyone* can push the
 *     release through.
 *   - **"Released" means paid.** It does not. Release credits a balance held by the escrow
 *     contract. The money is only in a wallet after a second transaction: `withdraw`.
 *
 * ## Where the numbers come from
 *
 * `summary(account)` and `milestones()` are read straight off the escrow at the address in the
 * URL — no factory needed, which is why this page works before `NEXT_PUBLIC_FACTORY_ADDRESS` is
 * set. When that read does not come back (no such contract, no RPC, nothing deployed yet) the
 * page falls back to a **clearly labelled sample job** rather than an empty shell, and every
 * send is disabled with a reason saying it is sample data. Blank screens teach nothing and a
 * silent fake teaches something false.
 *
 * The criteria, the evidence and the verifier's report are off-chain by design — the chain holds
 * only their hashes. On a live escrow this page shows the hashes and says plainly that it cannot
 * resolve the text; on the sample it shows the whole thing, which is what the mechanism looks
 * like when the off-chain store is wired up.
 */

import { use, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { useConnection, useReadContracts } from 'wagmi'
import { escrowAbi } from '@/lib/abis'
import { formatDuration, formatMon, monadTestnet, sameAddress, shortAddress } from '@/lib/chain'
import { permits, roleOf } from '@/lib/chat/permissions'
import { MSTATE, type ActionContext, type ChainAction, type MState, type Role } from '@/lib/chat/types'
import type { CheckKind, Criteria, Evidence, Report } from '@/lib/verify/types'
import type { TxRequest } from '@/lib/useTxFlow'
import { MilestoneCard } from '@/components/MilestoneCard'
import { Countdown, formatAbsolute, useNow } from '@/components/Countdown'
import { TxButton } from '@/components/TxButton'
import { ConnectButton } from '@/components/ConnectButton'

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

type Address = `0x${string}`

type MilestoneRow = {
  amount: string
  check: CheckKind
  state: MState
  submissions: number
  releasableAt: number
  criteriaHash: string | null
  evidenceHash: string | null
  criteria: Criteria | null
  evidence: Evidence | null
  report: Report | null
}

type JobData = {
  escrow: Address
  title: string
  client: Address
  freelancer: Address
  verifier: Address
  arbiter: Address
  totalAmount: string
  releasedAmount: string
  refundedAmount: string
  deadline: number
  challengeWindow: number
  acceptedAt: number
  cancelled: boolean
  owed: string
  milestones: MilestoneRow[]
}

const ZERO: Address = '0x0000000000000000000000000000000000000000'

const isAddressLike = (v: string): v is Address => /^0x[0-9a-fA-F]{40}$/.test(v)

/** `Escrow.Check` ordinals — ClientApproval, Http, Github, in that order. */
const CHECK_BY_ORDINAL: readonly CheckKind[] = ['clientApproval', 'http', 'github']

const STATE_ORDINALS: readonly MState[] = [
  MSTATE.Pending,
  MSTATE.Submitted,
  MSTATE.Attested,
  MSTATE.Released,
  MSTATE.Disputed,
  MSTATE.Refunded,
]

/* ------------------------------------------------------------------ *
 * The sample job
 * ------------------------------------------------------------------ */

/** A 32-byte hex string built from a seed, so the sample has stable, distinguishable hashes. */
const h = (seed: string): string => `0x${seed.repeat(64).slice(0, 64)}`

const SAMPLE_CLIENT = '0xC11e1700000000000000000000000000000000C1' as Address
const SAMPLE_FREELANCER = '0xF4ee1a00000000000000000000000000000000F1' as Address
const SAMPLE_VERIFIER = '0x7e41F100000000000000000000000000000000E7' as Address
const SAMPLE_ARBITER = '0xA4b17e00000000000000000000000000000000A1' as Address

/**
 * Unix seconds used for the sample before the browser clock is known.
 *
 * `useNow` deliberately returns null until it has mounted, so this keeps the server render and
 * the first client render byte-identical; the timeline then re-anchors to the real clock in an
 * effect. Without the constant the two renders would disagree and React would throw.
 */
const SAMPLE_ANCHOR = 1_760_000_000

const HOUR = 3600
const DAY = 86400

function sampleJob(escrow: Address, anchor: number): JobData {
  const challengeWindow = 48 * HOUR

  const milestones: MilestoneRow[] = [
    // ------------------------------------------------------------------ 1. already released
    {
      amount: '750000000000000000',
      check: 'github',
      state: MSTATE.Released,
      submissions: 1,
      releasableAt: 0,
      criteriaHash: h('a1'),
      evidenceHash: h('b1'),
      criteria: {
        v: 1,
        title: 'Repository scaffolded and CI green',
        check: 'github',
        github: {
          repo: 'acme-co/storefront',
          ref: 'main',
          requireCommit: true,
          requireCheckRun: 'build',
          minStars: null,
        },
      },
      evidence: {
        v: 1,
        milestone: 0,
        repo: 'acme-co/storefront',
        commit: '9f2c1d84a0b7e5c36d18f4a29b0e77c5d3a61e82',
        note: 'Next.js app, Tailwind, CI on every push. Nothing rendered yet beyond the shell.',
        submittedAt: anchor - 8 * DAY,
      },
      report: {
        v: 1,
        escrow,
        milestone: 0,
        submission: 1,
        evidenceHash: h('b1'),
        criteriaHash: h('a1'),
        passed: true,
        checkedAt: anchor - 8 * DAY + 400,
        checks: [
          {
            id: 'commit',
            label: 'The commit exists on the repository',
            passed: true,
            detail: 'acme-co/storefront@9f2c1d8 — found on main.',
          },
          {
            id: 'check-run',
            label: 'A check run named "build" concluded successfully',
            passed: true,
            detail: 'conclusion=success, completed 2 minutes before this check ran.',
          },
        ],
      },
    },

    // ------------------------------------------------- 2. attested, challenge window running
    {
      amount: '1200000000000000000',
      check: 'http',
      state: MSTATE.Attested,
      submissions: 1,
      releasableAt: anchor + 2 * HOUR,
      criteriaHash: h('a2'),
      evidenceHash: h('b2'),
      criteria: {
        v: 1,
        title: 'Sign-in page live on staging',
        check: 'http',
        http: {
          url: 'https://staging.acme.example/sign-in',
          expectStatus: 200,
          mustContain: ['Sign in with Google'],
          mustNotContain: ['Coming soon'],
          timeoutMs: 5000,
        },
      },
      evidence: {
        v: 1,
        milestone: 1,
        url: 'https://staging.acme.example/sign-in',
        note: 'Google and email are both wired up. Password reset is milestone 4, not this one.',
        submittedAt: anchor - 47 * HOUR,
      },
      report: {
        v: 1,
        escrow,
        milestone: 1,
        submission: 1,
        evidenceHash: h('b2'),
        criteriaHash: h('a2'),
        passed: true,
        checkedAt: anchor - 46 * HOUR,
        checks: [
          {
            id: 'status',
            label: 'The page answered HTTP 200',
            passed: true,
            detail: 'GET https://staging.acme.example/sign-in → 200 in 412 ms.',
          },
          {
            id: 'contains',
            label: 'The body contains "Sign in with Google"',
            passed: true,
            detail: 'Found once, at byte offset 4187 of a 22 KB response.',
          },
          {
            id: 'not-contains',
            label: 'The body does not contain "Coming soon"',
            passed: true,
            detail: 'No occurrence in the response body.',
          },
        ],
      },
    },

    // -------------------------------------------- 3. attested, window already closed: unlocked
    {
      amount: '600000000000000000',
      check: 'http',
      state: MSTATE.Attested,
      submissions: 1,
      releasableAt: anchor - 2 * HOUR,
      criteriaHash: h('a3'),
      evidenceHash: h('b3'),
      criteria: {
        v: 1,
        title: 'Public status page responds',
        check: 'http',
        http: {
          url: 'https://staging.acme.example/status',
          expectStatus: 200,
          mustContain: ['All systems'],
          mustNotContain: [],
          timeoutMs: 4000,
        },
      },
      evidence: {
        v: 1,
        milestone: 2,
        url: 'https://staging.acme.example/status',
        note: 'Static for now, reads from the health endpoint in the next milestone.',
        submittedAt: anchor - 51 * HOUR,
      },
      report: {
        v: 1,
        escrow,
        milestone: 2,
        submission: 1,
        evidenceHash: h('b3'),
        criteriaHash: h('a3'),
        passed: true,
        checkedAt: anchor - 50 * HOUR,
        checks: [
          {
            id: 'status',
            label: 'The page answered HTTP 200',
            passed: true,
            detail: 'GET https://staging.acme.example/status → 200 in 198 ms.',
          },
          {
            id: 'contains',
            label: 'The body contains "All systems"',
            passed: true,
            detail: 'Found once, inside the page heading.',
          },
        ],
      },
    },

    // -------------------------------------------------- 4. submitted, the check said no
    {
      amount: '900000000000000000',
      check: 'http',
      state: MSTATE.Submitted,
      submissions: 2,
      releasableAt: 0,
      criteriaHash: h('a4'),
      evidenceHash: h('b4'),
      criteria: {
        v: 1,
        title: 'Password reset flow reachable',
        check: 'http',
        http: {
          url: 'https://staging.acme.example/reset',
          expectStatus: 200,
          mustContain: ['Send me a reset link'],
          mustNotContain: ['stack trace'],
          timeoutMs: 5000,
        },
      },
      evidence: {
        v: 1,
        milestone: 3,
        url: 'https://staging.acme.example/reset',
        note: 'Deployed just now — the mailer key may still be propagating on staging.',
        submittedAt: anchor - 5 * HOUR,
      },
      report: {
        v: 1,
        escrow,
        milestone: 3,
        submission: 2,
        evidenceHash: h('b4'),
        criteriaHash: h('a4'),
        passed: false,
        checkedAt: anchor - 4 * HOUR,
        checks: [
          {
            id: 'status',
            label: 'The page answered HTTP 200',
            passed: false,
            detail: 'GET https://staging.acme.example/reset → 500 in 1 204 ms.',
          },
          {
            id: 'contains',
            label: 'The body contains "Send me a reset link"',
            passed: false,
            detail: 'Not found. The response body was an error page.',
          },
        ],
      },
    },

    // --------------------------------------------------------------- 5. the client objected
    {
      amount: '1500000000000000000',
      check: 'github',
      state: MSTATE.Disputed,
      submissions: 1,
      releasableAt: 0,
      criteriaHash: h('a5'),
      evidenceHash: h('b5'),
      criteria: {
        v: 1,
        title: 'Checkout integrated end to end',
        check: 'github',
        github: {
          repo: 'acme-co/storefront',
          ref: 'release/checkout',
          requireCommit: true,
          requireCheckRun: 'e2e',
          minStars: null,
        },
      },
      evidence: {
        v: 1,
        milestone: 4,
        repo: 'acme-co/storefront',
        commit: '4b7a09e1c25d8f36a1b0e947c3d5628fa10c7e94',
        note: 'e2e suite is green. Two of the cases are skipped on CI because they need a card.',
        submittedAt: anchor - 6 * DAY,
      },
      report: {
        v: 1,
        escrow,
        milestone: 4,
        submission: 1,
        evidenceHash: h('b5'),
        criteriaHash: h('a5'),
        passed: true,
        checkedAt: anchor - 6 * DAY + 900,
        checks: [
          {
            id: 'commit',
            label: 'The commit exists on the repository',
            passed: true,
            detail: 'acme-co/storefront@4b7a09e — found on release/checkout.',
          },
          {
            id: 'check-run',
            label: 'A check run named "e2e" concluded successfully',
            passed: true,
            detail: 'conclusion=success, 31 passed, 2 skipped.',
          },
        ],
      },
    },

    // -------------------------------------------------------------------- 6. nothing yet
    {
      amount: '550000000000000000',
      check: 'clientApproval',
      state: MSTATE.Pending,
      submissions: 0,
      releasableAt: 0,
      criteriaHash: h('a6'),
      evidenceHash: null,
      criteria: {
        v: 1,
        title: 'Handover call and written runbook',
        check: 'clientApproval',
      },
      evidence: null,
      report: null,
    },
  ]

  return {
    escrow,
    title: 'Storefront rebuild — six milestones',
    client: SAMPLE_CLIENT,
    freelancer: SAMPLE_FREELANCER,
    verifier: SAMPLE_VERIFIER,
    arbiter: SAMPLE_ARBITER,
    totalAmount: '5500000000000000000',
    releasedAmount: '750000000000000000',
    refundedAmount: '0',
    deadline: anchor + 12 * DAY,
    challengeWindow,
    acceptedAt: anchor - 9 * DAY,
    cancelled: false,
    owed: '0',
    milestones,
  }
}

/* ------------------------------------------------------------------ *
 * Reading the escrow
 * ------------------------------------------------------------------ */

type ChainSummary = {
  escrow: Address
  client: Address
  freelancer: Address
  verifier: Address
  arbiter: Address
  totalAmount: bigint
  releasedAmount: bigint
  refundedAmount: bigint
  deadline: bigint
  challengeWindow: number
  acceptedAt: bigint
  cancelled: boolean
  termsHash: string
  title: string
  accountOwed: bigint
}

type ChainMilestone = {
  amount: bigint
  check: number
  state: number
  submissions: number
  attestedAt: bigint
  criteriaHash: string
  evidenceHash: string
}

/** `0x000…0` means "never set", and printing 64 zeroes as if it were a commitment is a lie. */
const meaningfulHash = (v: string | null | undefined): string | null =>
  v && /[1-9a-fA-F]/.test(v.slice(2)) ? v : null

function fromChain(
  escrow: Address,
  summary: ChainSummary,
  milestones: readonly ChainMilestone[],
): JobData {
  const challengeWindow = Number(summary.challengeWindow)

  return {
    escrow,
    title: summary.title,
    client: summary.client,
    freelancer: summary.freelancer,
    verifier: summary.verifier,
    arbiter: summary.arbiter,
    totalAmount: summary.totalAmount.toString(),
    releasedAmount: summary.releasedAmount.toString(),
    refundedAmount: summary.refundedAmount.toString(),
    deadline: Number(summary.deadline),
    challengeWindow,
    acceptedAt: Number(summary.acceptedAt),
    cancelled: summary.cancelled,
    owed: summary.accountOwed.toString(),
    milestones: milestones.map((m) => {
      const state = STATE_ORDINALS[m.state] ?? MSTATE.Pending
      return {
        amount: m.amount.toString(),
        check: CHECK_BY_ORDINAL[m.check] ?? 'clientApproval',
        state,
        submissions: Number(m.submissions),
        // Mirrors `Escrow.releasableAt`: zero unless the milestone is Attested.
        releasableAt: state === MSTATE.Attested ? Number(m.attestedAt) + challengeWindow : 0,
        criteriaHash: meaningfulHash(m.criteriaHash),
        evidenceHash: meaningfulHash(m.evidenceHash),
        // Off-chain, and this page has no store for them yet. The card says so rather than
        // rendering a confident blank.
        criteria: null,
        evidence: null,
        report: null,
      }
    }),
  }
}

/* ------------------------------------------------------------------ *
 * Presentational bits
 * ------------------------------------------------------------------ */

const CARD = 'rounded-2xl border border-zinc-800 bg-zinc-900'

const ROLE_HEADLINE: Record<Role, string> = {
  client: 'You are the client on this escrow',
  freelancer: 'You are the freelancer on this escrow',
  arbiter: 'You are the arbiter on this escrow',
  stranger: 'You are not a party to this escrow',
}

const ROLE_DETAIL: Record<Role, string> = {
  client:
    'Your money is in here. You are the only one who can object inside a challenge window, and ' +
    'the only one who can reclaim milestones after the deadline.',
  freelancer:
    'You submit work here. You cannot release your own milestone early, but once a challenge ' +
    'window closes without an objection you can release it yourself — nobody has to sign for you.',
  arbiter:
    'You only matter once somebody objects. Until a milestone is disputed there is nothing here ' +
    'for you to do, and you cannot reach into one that is not.',
  stranger:
    'Everything below is public, because the escrow is. You still hold one real power: once a ' +
    'challenge window closes, anyone at all can release that milestone — including you.',
}

function Party({
  label,
  address,
  you,
  note,
}: {
  label: string
  address: string
  you: boolean
  note?: string
}) {
  const unset = !address || address.toLowerCase() === ZERO
  return (
    <div className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5">
      <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
        {label}
        {you ? (
          <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[0.6875rem] font-semibold text-accent-soft">
            you
          </span>
        ) : null}
      </p>
      <p className="mt-1 font-mono text-sm break-all text-zinc-200" title={address}>
        {unset ? 'not set' : shortAddress(address)}
      </p>
      {note ? <p className="mt-1 text-xs leading-relaxed text-zinc-400">{note}</p> : null}
    </div>
  )
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-zinc-400">{label}</p>
      <p className="mt-0.5 font-mono text-base tabular-nums break-words text-zinc-100">{value}</p>
      {note ? <p className="mt-0.5 text-xs text-zinc-400">{note}</p> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Job-level actions
 * ------------------------------------------------------------------ */

type JobActionSpec = {
  action: Extract<ChainAction, 'accept' | 'cancel' | 'withdraw'>
  label: string
  hint: string
  successNote?: string
  variant: 'primary' | 'secondary' | 'danger'
  functionName: string
}

const JOB_ACTIONS: readonly JobActionSpec[] = [
  {
    action: 'accept',
    label: 'Accept this job',
    hint:
      'Takes the job on. The escrow is already funded — accepting is what starts the clock on ' +
      'the milestones, it does not move any money.',
    variant: 'primary',
    functionName: 'accept',
  },
  {
    action: 'cancel',
    label: 'Cancel this job',
    hint:
      'Only possible before anyone accepts. It credits the whole escrow back to your balance ' +
      'inside the contract, which you then withdraw.',
    successNote:
      'Cancelled. The full amount is credited to your balance inside the escrow — it is not ' +
      'in your wallet until you withdraw it.',
    variant: 'danger',
    functionName: 'cancel',
  },
  {
    action: 'withdraw',
    label: 'Withdraw what you are owed',
    hint:
      'This is the step people miss. Releasing, reclaiming and resolving all credit a balance ' +
      'inside the escrow; this is the transaction that moves it into your wallet.',
    successNote: 'Withdrawn. That transfer went to your wallet — this is the step that pays out.',
    variant: 'primary',
    functionName: 'withdraw',
  },
]

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function JobPage({ params }: { params: Promise<{ address: string }> }) {
  const { address: raw } = use(params)
  const now = useNow()
  const connection = useConnection()
  const account = connection.address ?? null

  const valid = isAddressLike(raw)
  const escrow = (valid ? (raw as Address) : ZERO) as Address

  const reads = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: escrow, abi: escrowAbi, functionName: 'summary', args: [account ?? ZERO] },
      { address: escrow, abi: escrowAbi, functionName: 'milestones' },
    ],
    query: {
      enabled: valid,
      // One attempt. A wrong address is the common case here and a retry storm just delays the
      // honest "this is sample data" message.
      retry: 0,
    },
  })

  // Depends on the query's own stable `refetch`, not on the result object, which is new on every
  // render — an unstable callback would re-arm the Countdown's elapsed effect each tick.
  const { refetch: refetchReads } = reads
  const refetch = useCallback(() => {
    void refetchReads()
  }, [refetchReads])

  const live = useMemo((): JobData | null => {
    const data = reads.data
    if (!valid || !data) return null
    const [summary, milestones] = data as unknown as [ChainSummary, readonly ChainMilestone[]]
    // A contract that answers but names nobody is not an escrow — treat it as a miss.
    if (!summary || summary.client.toLowerCase() === ZERO) return null
    return fromChain(escrow, summary, milestones ?? [])
  }, [reads.data, valid, escrow])

  const job = useMemo(
    () => live ?? sampleJob(escrow, now ?? SAMPLE_ANCHOR),
    [live, escrow, now],
  )
  const isSample = live === null

  const role = roleOf(account, job)
  const accepted = job.acceptedAt > 0
  const ready = now !== null

  const ctx: ActionContext | null = ready
    ? {
        role,
        accepted,
        cancelled: job.cancelled,
        now,
        deadline: job.deadline,
        releasableAt: 0,
        owed: job.owed,
      }
    : null

  const inEscrow =
    BigInt(job.totalAmount) - BigInt(job.releasedAmount) - BigInt(job.refundedAmount)
  const releasedCount = job.milestones.filter((m) => m.state === MSTATE.Released).length
  const explorer = monadTestnet.blockExplorers?.default.url

  /* ------------------------------------------------------- not an address at all */
  if (!valid) {
    return (
      <div className={`${CARD} mx-auto max-w-xl p-5`}>
        <h1 className="text-lg font-semibold text-zinc-100">That is not an escrow address</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          A MonEscrow job lives at its own contract address, so the link should end in a 42
          character address starting <code className="font-mono text-xs">0x</code>. This one ends
          in:
        </p>
        <p className="mt-2 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs break-all text-zinc-300">
          {raw}
        </p>
        <Link
          href="/"
          className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-accent px-4 text-sm font-semibold text-zinc-950 hover:bg-accent/90"
        >
          Back to my jobs
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-2xl lg:max-w-none">
      {/* --------------------------------------------------------------- provenance banner */}
      {isSample ? (
        <p
          role="status"
          className="mb-4 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm leading-relaxed text-zinc-100"
        >
          <span className="font-semibold">
            {reads.isPending
              ? 'Reading this escrow from Monad testnet…'
              : 'Nothing is deployed at this address, so this is a sample job.'}
          </span>{' '}
          <span className="text-zinc-300">
            Every number, report and countdown below is made up to show how the mechanism behaves.
            Nothing here can be sent to a chain, and every button says so instead of failing at
            your wallet.
          </span>
        </p>
      ) : null}

      <div className="lg:grid lg:grid-cols-[22rem_minmax(0,1fr)] lg:items-start lg:gap-6">
        {/* ============================================================= the job, at a glance */}
        <div className="min-w-0 lg:sticky lg:top-24">
          <header className={`${CARD} p-4`}>
            <h1 className="text-xl leading-tight font-bold text-balance text-zinc-100">
              {job.title}
            </h1>

            <p className="mt-2 font-mono text-xs break-all text-zinc-400">{job.escrow}</p>
            {explorer && !isSample ? (
              <a
                href={`${explorer}/address/${job.escrow}`}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-1 inline-flex min-h-11 items-center text-sm text-accent-soft underline underline-offset-4 hover:text-accent"
              >
                Open the contract on MonadVision
              </a>
            ) : null}

            <div className="mt-3 grid grid-cols-2 gap-3">
              <Figure
                label="Funded up front"
                value={`${formatMon(job.totalAmount)} MON`}
                note={`${job.milestones.length} milestones`}
              />
              <Figure
                label="Still in escrow"
                value={`${formatMon(inEscrow)} MON`}
                note={`${releasedCount} of ${job.milestones.length} released`}
              />
              <Figure label="Released" value={`${formatMon(job.releasedAmount)} MON`} />
              <Figure label="Refunded" value={`${formatMon(job.refundedAmount)} MON`} />
            </div>

            <p className="mt-3 text-sm leading-relaxed text-zinc-400">
              The client paid the whole amount into this contract before any work started. Each
              milestone leaves it separately, and only on the terms below.
            </p>

            <dl className="mt-3 space-y-1.5 text-sm">
              <div className="flex flex-wrap justify-between gap-x-3">
                <dt className="text-zinc-400">Deadline</dt>
                <dd className="text-zinc-200">{formatAbsolute(job.deadline)}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-x-3">
                <dt className="text-zinc-400">Challenge window</dt>
                <dd className="text-zinc-200">
                  {formatDuration(job.challengeWindow)} per milestone
                </dd>
              </div>
              <div className="flex flex-wrap justify-between gap-x-3">
                <dt className="text-zinc-400">Accepted</dt>
                <dd className="text-zinc-200">
                  {job.cancelled
                    ? 'cancelled before acceptance'
                    : accepted
                      ? formatAbsolute(job.acceptedAt)
                      : 'not yet'}
                </dd>
              </div>
            </dl>
          </header>

          {/* ------------------------------------------------------------- who you are here */}
          <section className={`${CARD} mt-4 p-4`} aria-labelledby="role-heading">
            <h2 id="role-heading" className="text-sm font-semibold text-zinc-100">
              {ready ? ROLE_HEADLINE[role] : 'Working out who you are here…'}
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
              {ready
                ? ROLE_DETAIL[role]
                : 'Your connected address is compared against the escrow to decide what you can do.'}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-zinc-400">
              Nobody chose this. Your connected address was compared with the client, freelancer
              and arbiter recorded on the contract — the wallet is the login, and the chain would
              ignore any other claim.
            </p>

            {ready && !account ? (
              <div className="mt-3">
                <ConnectButton />
              </div>
            ) : null}

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Party label="Client" address={job.client} you={sameAddress(account, job.client)} />
              <Party
                label="Freelancer"
                address={job.freelancer}
                you={sameAddress(account, job.freelancer)}
              />
              <Party
                label="Arbiter"
                address={job.arbiter}
                you={sameAddress(account, job.arbiter)}
                note="Only reachable on a disputed milestone."
              />
              <Party
                label="Verifier"
                address={job.verifier}
                you={sameAddress(account, job.verifier)}
                note="Proposes. Never decides, and holds no money."
              />
            </div>
          </section>

          {/* ------------------------------------------------------ the mechanism, in four lines */}
          <section className={`${CARD} mt-4 p-4`} aria-labelledby="how-heading">
            <h2 id="how-heading" className="text-sm font-semibold text-zinc-100">
              How a milestone gets paid
            </h2>
            <ol className="mt-2 space-y-2 text-sm leading-relaxed text-zinc-400">
              <li>
                <span className="text-zinc-200">1.</span> The freelancer submits evidence against
                criteria both sides agreed before the work started.
              </li>
              <li>
                <span className="text-zinc-200">2.</span> An off-chain verifier runs the check and{' '}
                <span className="text-zinc-200">proposes</span> a pass. That is a signed opinion,
                not a decision, and it moves no money.
              </li>
              <li>
                <span className="text-zinc-200">3.</span> A pass opens a challenge window. The
                client can object inside it and freeze the milestone for the arbiter.
              </li>
              <li>
                <span className="text-zinc-200">4.</span> If the window closes in silence,{' '}
                <span className="text-zinc-200">anyone</span> can release the milestone. Releasing
                credits a balance inside the contract; the money reaches a wallet only when its
                owner withdraws.
              </li>
            </ol>
          </section>
        </div>

        {/* ================================================================ actions + milestones */}
        <div className="mt-4 min-w-0 lg:mt-0">
          {/* -------------------------------------------------------- what you are owed here */}
          <section className={`${CARD} p-4`} aria-labelledby="job-actions-heading">
            <h2 id="job-actions-heading" className="text-sm font-semibold text-zinc-100">
              This escrow, as a whole
            </h2>

            <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
              Owed to this wallet inside the contract:{' '}
              <span className="font-mono text-zinc-100">{formatMon(job.owed)} MON</span>. That is a
              number in the escrow, not a transfer — withdrawing is what makes it yours.
            </p>

            {!ctx ? (
              <p className="mt-3 text-sm text-zinc-400">Working out what this wallet can do…</p>
            ) : (
              <ul className="mt-3 space-y-4">
                {JOB_ACTIONS.map((spec) => {
                  const permission = permits(spec.action, ctx)
                  const request: TxRequest | null = isSample
                    ? null
                    : { address: job.escrow, abi: escrowAbi, functionName: spec.functionName }
                  const blocked = permission.allowed
                    ? isSample
                      ? 'The chain would accept this from your wallet. It cannot be sent here ' +
                        'because this job is sample data, not a real escrow.'
                      : null
                    : permission.reason

                  return (
                    <li key={spec.action}>
                      <TxButton
                        label={spec.label}
                        request={request}
                        blockedReason={blocked}
                        hint={spec.hint}
                        successNote={spec.successNote}
                        variant={spec.variant}
                        onSuccess={refetch}
                      />
                    </li>
                  )
                })}
              </ul>
            )}

            <p className="mt-4 text-xs leading-relaxed text-zinc-400">
              Blocked actions stay on the page on purpose. Seeing that only the client can cancel,
              and why, is how everybody learns the rules of the thing they signed.
            </p>
          </section>

          {/* ------------------------------------------------------------------- milestones */}
          <section className="mt-4" aria-labelledby="milestones-heading">
            <h2
              id="milestones-heading"
              className="px-1 text-sm font-semibold tracking-wide text-zinc-400 uppercase"
            >
              Milestones
            </h2>

            <ul className="mt-2 space-y-4">
              {job.milestones.map((m, i) => (
                <li key={`${job.escrow}-${i}`}>
                  <MilestoneCard
                    escrow={job.escrow}
                    index={i}
                    milestone={{
                      amount: m.amount,
                      check: m.check,
                      state: m.state,
                      submissions: m.submissions,
                      releasableAt: m.releasableAt,
                      criteriaHash: m.criteriaHash,
                      evidenceHash: m.evidenceHash,
                    }}
                    job={{
                      accepted,
                      cancelled: job.cancelled,
                      deadline: job.deadline,
                      challengeWindow: job.challengeWindow,
                    }}
                    role={role}
                    owed={job.owed}
                    criteria={m.criteria}
                    evidence={m.evidence}
                    report={m.report}
                    sample={isSample}
                    onChanged={refetch}
                  />
                </li>
              ))}
            </ul>
          </section>

          {/* ---------------------------------------------------- the deadline, as a live clock */}
          {!job.cancelled && job.deadline > 0 ? (
            <section className="mt-4">
              <Countdown
                releasableAt={job.deadline}
                runningLabel="Job deadline"
                boundaryVerb="Ends"
                boundaryPastPhrase="The deadline passed"
                elapsedTone="neutral"
                runningDetail={
                  'After this, milestones that were never attested can be reclaimed by the ' +
                  'client. An attested milestone survives the deadline — proven work does not ' +
                  'expire.'
                }
                elapsedLabel="The deadline has passed"
                elapsedDetail={
                  'The client can reclaim any milestone still Pending or Submitted. Anything ' +
                  'already attested is untouched by this and still settles on its own window.'
                }
              />
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}
