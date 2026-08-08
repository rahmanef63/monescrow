'use client'

/**
 * `/` — my jobs.
 *
 * The first slot in the dock, and the first thing a judge sees. It has to answer one question
 * per card: *what is the single most urgent thing about this job right now?* Everything else —
 * the milestone table, the evidence, the buttons — lives on the job page.
 *
 * ## Three emptinesses, three messages
 *
 * `hasFactory()` false, no wallet, and no jobs are three different facts, and this screen refuses
 * to render any of them as the others. An empty list under a connected wallet means the chain was
 * asked and said none. An empty list with no factory means nothing was ever asked, and saying
 * "you have no jobs" there would be a lie.
 *
 * ## Cards, not a table
 *
 * A five-column table does not survive 380px. It becomes a horizontal scroll or a 10px font, and
 * this app's primary layout is the phone.
 */

import { useMemo, useState } from 'react'
import { EmptyState } from '@/components/EmptyState'
import { Group, GroupNote, Pill, Row, Segmented } from '@/components/ios'
import { formatDuration, formatMon, sameAddress, shortAddress } from '@/lib/chain'
import { MSTATE } from '@/lib/chat/types'
import {
  JobCard,
  SAMPLE_VIEWER,
  useMyJobs,
  type JobWithOwed,
  type MyJobs,
} from '@/components/JobCard'
import { roleOf } from '@/lib/chat/permissions'
import type { Role } from '@/lib/chat/types'

type Tab = 'client' | 'freelancer' | 'arbiter'

const TAB_LABEL: Record<Tab, string> = {
  client: 'As client',
  freelancer: 'As freelancer',
  arbiter: 'As arbiter',
}

const TAB_BLURB: Record<Tab, string> = {
  client: 'Jobs you funded. You approve, you dispute, and you reclaim after the deadline.',
  freelancer: 'Jobs you were hired for. You accept, you submit, and you withdraw what you are owed.',
  arbiter: 'Jobs that named this wallet as the arbiter. You only act once a milestone is frozen.',
}


/* ------------------------------------------------------------------ *
 * One job, as one row
 * ------------------------------------------------------------------ */

/**
 * A list row shows the job and the single most urgent true thing about it — not five fields.
 *
 * A card could afford to show everything; a row cannot, and that constraint is useful. What a
 * person scanning their jobs needs is: which job, how much, and is anything waiting. Everything
 * else is one tap away on the job page, which is where the detail belongs.
 *
 * `drain` is the signature: a live challenge window shrinks the row separator toward zero, so a
 * list of jobs shows at a glance which clocks are running out without a single extra element.
 */
function jobRow(job: JobWithOwed, viewer: string | null, now: number) {
  const total = job.milestones.length
  const closed = job.milestones.filter((m) => m.state === MSTATE.Released || m.state === MSTATE.Refunded).length

  const counterparty = sameAddress(job.client, viewer) ? job.freelancer : job.client
  const title = job.untrusted.title.trim() || `Escrow ${shortAddress(job.escrow)}`

  // The most urgent milestone decides the row: a running window beats a dispute beats waiting.
  const attested = job.milestones.filter((m) => m.state === MSTATE.Attested && m.releasableAt > 0)
  const soonest = attested.sort((a, b) => a.releasableAt - b.releasableAt)[0]
  const disputed = job.milestones.some((m) => m.state === MSTATE.Disputed)

  let value: React.ReactNode = `${formatMon(job.totalAmount)} MON`
  let drain: number | undefined

  if (job.cancelled) {
    value = <Pill tone="neutral">Cancelled</Pill>
  } else if (disputed) {
    value = <Pill tone="danger">Disputed</Pill>
  } else if (soonest) {
    const left = soonest.releasableAt - now
    if (left > 0 && job.challengeWindow > 0) {
      drain = left / job.challengeWindow
      value = <Pill tone="warn">{formatDuration(left)} left</Pill>
    } else {
      value = <Pill tone="ok">Releasable</Pill>
    }
  } else if (closed === total && total > 0) {
    value = <Pill tone="ok">Done</Pill>
  }

  return {
    label: title,
    detail: `${shortAddress(counterparty)} · ${closed}/${total} milestones · ${formatMon(job.totalAmount)} MON`,
    value,
    drain,
  }
}

export default function JobsPage() {
  const state = useMyJobs()
  const { now, source, status, renderViewer } = state

  const buckets = useMemo(() => {
    const out: Record<Tab, JobWithOwed[]> = { client: [], freelancer: [], arbiter: [] }
    for (const job of state.jobs) {
      const role: Role = roleOf(renderViewer, job)
      if (role === 'stranger') continue
      out[role].push(job)
    }
    return out
  }, [state.jobs, renderViewer])

  // Never asked, always derived: the tab that actually has something in it wins on first paint.
  const preferred: Tab =
    buckets.client.length >= buckets.freelancer.length && buckets.client.length > 0
      ? 'client'
      : buckets.freelancer.length > 0
        ? 'freelancer'
        : buckets.arbiter.length > 0
          ? 'arbiter'
          : 'client'

  const [chosen, setChosen] = useState<Tab | null>(null)
  const tab: Tab = chosen ?? preferred

  const tabs: Tab[] = buckets.arbiter.length > 0 ? ['client', 'freelancer', 'arbiter'] : ['client', 'freelancer']
  const shown = buckets[tab]
  const strangers = state.jobs.length - (buckets.client.length + buckets.freelancer.length + buckets.arbiter.length)

  return (
    <div className="min-w-0">
      <header className="min-w-0 pt-1 pb-1">
        <h1 className="text-4xl leading-tight font-bold tracking-[-0.02em] text-zinc-50">Jobs</h1>
      </header>

      <SourceNotice state={state} />

      {status === 'booting' || status === 'loading' ? (
        <Skeleton
          label={
            status === 'loading'
              ? 'Reading your escrows from Monad testnet…'
              : 'Loading your jobs…'
          }
        />
      ) : status === 'error' ? (
        <EmptyState
          className="mt-4"
          tone="warning"
          title="Monad testnet did not answer"
          body={
            <>
              <p>
                The factory is configured and your wallet is connected, but the read failed. This
                is a network or RPC problem, not a statement about your jobs — you may well have
                some.
              </p>
              <p className="font-mono text-xs break-words text-zinc-400">{state.error}</p>
            </>
          }
        >
          <button
            type="button"
            onClick={state.refetch}
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-medium text-zinc-100 hover:bg-zinc-800"
          >
            Try the read again
          </button>
        </EmptyState>
      ) : state.jobs.length === 0 ? (
        <EmptyState
          className="mt-4"
          tone="neutral"
          title={`${shortAddress(renderViewer)} is not party to any escrow yet`}
          body={
            <>
              <p>
                The factory answered, and it has no jobs indexed against this address — not as a
                client, not as a freelancer, not as an arbiter.
              </p>
              <p>
                If you were expecting one, check you are connected with the address the other side
                actually named.
              </p>
            </>
          }
          action={{ href: '/new', label: 'Create and fund a job' }}
          secondaryAction={{ href: '/wallet', label: 'Check the connected address' }}
        />
      ) : (
        <>
          <div className="mt-4">
            <Segmented
              label="Which side of a job you are on"
              value={tab}
              onChange={setChosen}
              options={tabs.map((t) => ({ value: t, label: TAB_LABEL[t], count: buckets[t].length }))}
            />
          </div>

          <GroupNote>{TAB_BLURB[tab]}</GroupNote>

          {shown.length === 0 ? (
            <EmptyState
              className="mt-4"
              tone="neutral"
              title={`No jobs where ${shortAddress(renderViewer)} is the ${tab}`}
              body={
                <p>
                  This address is party to {state.jobs.length}{' '}
                  {state.jobs.length === 1 ? 'job' : 'jobs'}, just not on this side. Try the other
                  tab.
                </p>
              }
            />
          ) : (
            <div className="mt-4">
              <Group>
                {shown.map((job, i) => {
                  const r = jobRow(job, renderViewer, now)
                  return (
                    <Row
                      key={job.escrow}
                      href={`/job/${job.escrow}`}
                      label={r.label}
                      detail={r.detail}
                      value={r.value}
                      drain={r.drain}
                      last={i === shown.length - 1}
                    />
                  )
                })}
              </Group>
            </div>
          )}

          {strangers > 0 ? (
            <p className="mt-4 text-sm text-zinc-400">
              {strangers} more {strangers === 1 ? 'escrow is' : 'escrows are'} indexed against this
              address without giving it a role. Nothing on them is actionable by this wallet.
            </p>
          ) : null}
        </>
      )}

      {source === 'sample' && status !== 'booting' ? (
        <p className="mt-6 text-xs leading-relaxed text-zinc-400">
          Sample jobs are told from{' '}
          <span className="font-mono break-all">{SAMPLE_VIEWER}</span>. They are not on any chain
          and no button on them will send a transaction.
        </p>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * The three empties, stated as themselves
 * ------------------------------------------------------------------ */

function SourceNotice({ state }: { state: MyJobs }) {
  if (state.status === 'no-factory') {
    return (
      <EmptyState
        className="mt-4"
        tone="warning"
        title="No escrow factory is configured, so nothing has been read from the chain"
        body={
          <>
            <p>
              This is <strong className="font-semibold text-zinc-300">not</strong> the same as
              having no jobs. MonEscrow has not asked Monad anything — there is no factory address
              to ask.
            </p>
            <p>
              Everything below is sample data, shown so the screens are legible before the
              contracts are wired up.
            </p>
          </>
        }
        footnote={
          <>
            Set <code className="font-mono">NEXT_PUBLIC_FACTORY_ADDRESS</code> to the deployed
            EscrowFactory and reload to read real jobs.
          </>
        }
      />
    )
  }

  if (state.status === 'disconnected') {
    return (
      <EmptyState
        className="mt-4"
        tone="accent"
        title="No wallet connected, so there is no address to look jobs up by"
        body={
          <>
            <p>
              Connecting a wallet <strong className="font-semibold text-zinc-300">is</strong>{' '}
              signing in here. There is no username and no password, and your address is what
              decides whether you see the client view, the freelancer view or the arbiter view of
              any job.
            </p>
            <p>Until then, the jobs below are sample data rather than an empty list.</p>
          </>
        }
        action={{ href: '/wallet', label: 'Connect a wallet' }}
      />
    )
  }

  return null
}

function Skeleton({ label }: { label: string }) {
  return (
    <div className="mt-4" aria-busy="true">
      <p className="sr-only" role="status">
        {label}
      </p>
      <ul className="flex flex-col gap-3 md:grid md:grid-cols-2 md:gap-4 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <li
            key={i}
            aria-hidden="true"
            className="h-52 animate-pulse rounded-2xl border border-zinc-800 bg-zinc-900"
          />
        ))}
      </ul>
      <p className="mt-3 text-xs text-zinc-400">{label}</p>
    </div>
  )
}
