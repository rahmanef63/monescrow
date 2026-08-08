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
import {
  JobCard,
  SAMPLE_VIEWER,
  useMyJobs,
  type JobWithOwed,
  type MyJobs,
} from '@/components/JobCard'
import { shortAddress } from '@/lib/chain'
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
      <header className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-100">Jobs</h1>
        <p className="mt-1 text-sm leading-relaxed text-zinc-400">
          Every escrow this wallet is party to. Which side of a job you are on is worked out from
          your address — nothing here asks you to pick a role.
        </p>
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
          {/* ---------------------------------------------------------------- role tabs */}
          <div
            className="mt-5 flex min-w-0 gap-2 overflow-x-auto pb-1"
            role="group"
            aria-label="Filter jobs by the side you are on"
          >
            {tabs.map((t) => {
              const active = t === tab
              return (
                <button
                  key={t}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setChosen(t)}
                  className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border px-3.5 text-sm font-medium transition-colors ${
                    active
                      ? 'border-accent/60 bg-accent/15 text-zinc-100'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-100'
                  }`}
                >
                  {TAB_LABEL[t]}
                  <span
                    className={`rounded-md px-1.5 py-0.5 text-xs tabular-nums ${
                      active ? 'bg-accent/25 text-zinc-100' : 'bg-zinc-800 text-zinc-400'
                    }`}
                  >
                    {buckets[t].length}
                  </span>
                </button>
              )
            })}
          </div>

          <p className="mt-2 text-xs leading-relaxed text-zinc-400">{TAB_BLURB[tab]}</p>

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
            <ul className="mt-4 flex flex-col gap-3 md:grid md:grid-cols-2 md:gap-4 xl:grid-cols-3">
              {shown.map((job) => (
                <JobCard key={job.escrow} job={job} viewer={renderViewer} now={now} />
              ))}
            </ul>
          )}

          {strangers > 0 ? (
            <p className="mt-4 text-xs text-zinc-400">
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
