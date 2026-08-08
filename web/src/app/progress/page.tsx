'use client'

/**
 * `/progress` — the milestone in flight, seen from wherever you are standing.
 *
 * Studio's docked-workflow direction, and the centre slot of the dock. The mockup shows three
 * columns — client, shared, freelancer — which are **not three screens**. They are this one
 * screen seen by three people, and the role comes from the connected address rather than a
 * picker. A stranger with the link gets the shared view, which is the same view minus the
 * decisions, because the mechanism is worth understanding whether or not you can act on it.
 *
 * What lands here rather than on the job page: the *live* milestone. The job page is a record
 * of everything; this is the one thing happening now, which is what somebody opens an app to
 * check. When nothing is in flight it says so and points at the record.
 */

import Link from 'next/link'
import { useMemo } from 'react'
import { useConnection } from 'wagmi'
import { Group, GroupNote, Pill, Row, SectionHeader } from '@/components/ios'
import {
  DecisionRow,
  Outcomes,
  ProgressHeader,
  Stepper,
  WindowBand,
  clock,
  stepsFor,
} from '@/components/Progress'
import { useNow } from '@/components/Countdown'
import { EmptyState } from '@/components/EmptyState'
import { SAMPLE_VIEWER, useMyJobs, type JobWithOwed } from '@/components/JobCard'
import { formatMon, sameAddress, shortAddress } from '@/lib/chain'
import { roleOf } from '@/lib/chat/permissions'
import { MSTATE, type MilestoneView, type Role } from '@/lib/chat/types'

/** The milestone a person actually wants: a running clock first, then anything unfinished. */
function inFlight(jobs: readonly JobWithOwed[], now: number) {
  type Hit = { job: JobWithOwed; m: MilestoneView; rank: number; left: number }
  const hits: Hit[] = []

  for (const job of jobs) {
    if (job.cancelled) continue
    for (const m of job.milestones) {
      const left = m.releasableAt > 0 ? m.releasableAt - now : 0
      if (m.state === MSTATE.Attested) hits.push({ job, m, rank: 0, left })
      else if (m.state === MSTATE.Disputed) hits.push({ job, m, rank: 1, left: 0 })
      else if (m.state === MSTATE.Submitted) hits.push({ job, m, rank: 2, left: 0 })
      else if (m.state === MSTATE.Pending) hits.push({ job, m, rank: 3, left: 0 })
    }
  }

  // A window that is nearly out beats one that just opened; that is the whole ordering.
  hits.sort((a, b) => a.rank - b.rank || a.left - b.left)
  return hits[0] ?? null
}

export default function ProgressPage() {
  const { address } = useConnection()
  const state = useMyJobs()
  const tick = useNow()
  const now = tick ?? Math.floor(Date.now() / 1000)

  const viewer = state.source === 'sample' ? SAMPLE_VIEWER : (address ?? null)
  const hit = useMemo(() => inFlight(state.jobs, now), [state.jobs, now])

  if (state.status === 'booting' || state.status === 'loading') {
    return <p className="pt-6 text-[17px] text-zinc-400">Reading your milestones…</p>
  }

  if (!hit) {
    return (
      <EmptyState
        className="mt-6"
        tone="neutral"
        title="Nothing in flight"
        body={
          <p>
            No milestone is waiting on anybody right now. Every job you are party to is on the
            Jobs tab, with its full record.
          </p>
        }
      />
    )
  }

  const { job, m } = hit
  const role: Role = roleOf(viewer ?? '0x0000000000000000000000000000000000000000', job)
  const left = m.releasableAt > 0 ? Math.max(0, m.releasableAt - now) : 0
  const windowRunning = m.state === MSTATE.Attested && left > 0

  // `Paid` is never inferred: release credits `owed`, and only `withdraw` moves it.
  const paid = m.state === MSTATE.Released && job.owed === '0'

  const amountLabel =
    role === 'freelancer' ? 'Amount to receive' : role === 'client' ? 'Amount locked' : 'Amount'

  return (
    <div className="-mx-4 min-h-full bg-zinc-950 px-4 pb-8">
      {/* -------------------------------------------------------------- who is looking */}
      <div className="flex items-center justify-between gap-3 pt-1">
        <span className="text-[13px] font-medium text-accent">{ROLE_LABEL[role]}</span>
        <Pill tone="neutral">Testnet</Pill>
      </div>

      <ProgressHeader
        project={job.untrusted.title.trim() || `Escrow ${shortAddress(job.escrow)}`}
        milestone={`Milestone ${m.index + 1}`}
        amount={`${formatMon(m.amount)} MON`}
        amountLabel={amountLabel}
      />

      {/* -------------------------------------------------------------- the state machine */}
      <div className="mt-4 rounded-xl bg-zinc-900">
        <Stepper
          steps={stepsFor(m.state, paid)}
          caption={windowRunning ? `Challenge window ends in ${clock(left)}` : undefined}
        />
      </div>

      {windowRunning ? (
        <div className="mt-3">
          <WindowBand secondsLeft={left} role={role} />
        </div>
      ) : null}

      {/* -------------------------------------------------------------- the fork */}
      {windowRunning ? (
        <>
          <SectionHeader>Outcomes</SectionHeader>
          <Outcomes />
        </>
      ) : null}

      {/* -------------------------------------------------------------- the record */}
      <SectionHeader>This milestone</SectionHeader>
      <Group>
        <Row label="State" value={<StatePill state={m.state} />} />
        <Row label="Submissions" value={String(m.submissions)} />
        <Row label="Check" value={m.check} />
        <Row
          label="Full record"
          detail="Evidence, the verifier report, and every action"
          href={`/job/${job.escrow}`}
          last
        />
      </Group>
      <GroupNote>
        A milestone reading Released has credited a balance inside the escrow. Withdrawing it to
        a wallet is a separate step, which is why Paid is its own stage above.
      </GroupNote>

      {/* -------------------------------------------------------------- what you can do */}
      <SectionHeader>{role === 'stranger' ? 'What happens next' : 'Your decision'}</SectionHeader>
      {role === 'stranger' ? (
        <GroupNote>
          You are not a party to this job, so nothing here is yours to press. Once the window
          ends with no objection, <em>anyone</em> can trigger the release — including you.
        </GroupNote>
      ) : (
        <div className="grid gap-2">
          <DecisionRow
            tone={role === 'client' ? 'primary' : 'plain'}
            label={role === 'client' ? 'Object & freeze' : 'Release'}
            detail={
              role === 'client'
                ? 'Start a dispute and freeze the funds for the arbiter'
                : 'Available to anyone once the window ends with no objection'
            }
            disabled={role === 'freelancer' && windowRunning}
            disabledNote="Available when the timer ends with no objection"
            onClick={() => {
              window.location.href = `/job/${job.escrow}`
            }}
          />
          <DecisionRow
            label={role === 'client' ? 'Approve early' : 'View evidence'}
            detail={
              role === 'client'
                ? 'Skip the rest of the timer and release now'
                : 'What was handed in, and what the verifier saw'
            }
            onClick={() => {
              window.location.href = `/job/${job.escrow}`
            }}
          />
        </div>
      )}

      <p className="px-4 pt-4 text-[13px] text-zinc-600">
        <Link href="/" className="underline decoration-zinc-700 underline-offset-2">
          All jobs
        </Link>
      </p>
    </div>
  )
}

const ROLE_LABEL: Record<Role, string> = {
  client: 'Client',
  freelancer: 'Freelancer',
  arbiter: 'Arbiter',
  stranger: 'Shared progress',
}

function StatePill({ state }: { state: number }) {
  if (state === MSTATE.Attested) return <Pill tone="warn">Verified</Pill>
  if (state === MSTATE.Released) return <Pill tone="ok">Released</Pill>
  if (state === MSTATE.Disputed) return <Pill tone="danger">Disputed</Pill>
  if (state === MSTATE.Refunded) return <Pill tone="neutral">Refunded</Pill>
  if (state === MSTATE.Submitted) return <Pill tone="accent">Submitted</Pill>
  return <Pill tone="neutral">Open</Pill>
}
