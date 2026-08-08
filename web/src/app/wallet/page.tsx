'use client'

/**
 * `/wallet` — the address, the network, the MON, and the money that is *not* MON yet.
 *
 * This screen exists mostly to kill one misreading, which is the single most expensive
 * misunderstanding in the whole product:
 *
 *   **A milestone that reads "Released" has not paid anybody.**
 *
 * Releasing moves a milestone's amount into a ledger entry inside its escrow contract, keyed by
 * address. The MON is still in the escrow. `withdraw()` is a separate transaction, sent by the
 * person who is owed, and it is the only thing on the chain that moves value into a wallet.
 *
 * People skim "Released" as "paid", go and look at their wallet, see nothing, and conclude the
 * app ate their money. So this page states the distinction in plain words at the top, repeats it
 * next to every balance, and labels the withdraw button as the thing that moves the money.
 *
 * The wallet is also the login, so this is where connecting lives. There is no account to create.
 */

import Link from 'next/link'
import { useMemo } from 'react'
import { useBalance } from 'wagmi'
import { ConnectButton } from '@/components/ConnectButton'
import { EmptyState } from '@/components/EmptyState'
import { TxButton } from '@/components/TxButton'
import { contextFor, jobHref, useMyJobs, type JobWithOwed } from '@/components/JobCard'
import { formatMon, monadTestnet, shortAddress } from '@/lib/chain'
import { permits } from '@/lib/chat/permissions'
import type { Permission } from '@/lib/chat/types'

type OwedRow = {
  job: JobWithOwed
  owed: bigint
  permission: Permission
}

export default function WalletPage() {
  const state = useMyJobs()
  const { now, source, status, renderViewer, viewer } = state

  const balance = useBalance({
    address: viewer ?? undefined,
    chainId: monadTestnet.id,
    query: { enabled: viewer !== null },
  })

  const rows = useMemo((): OwedRow[] => {
    return state.jobs
      .map((job): OwedRow => {
        const ctx = contextFor(job, renderViewer, now)
        return {
          job,
          // `contextFor` has already refused to hand over a balance that belongs to a different
          // address, so this reads the guarded figure and never the raw record.
          owed: safeWei(ctx.owed),
          // The C1 table, not a local `owed > 0` check. Same function the contract's rule is
          // written against, so the button can never be offered when the call would revert.
          permission: permits('withdraw', ctx),
        }
      })
      .filter((r) => r.owed > 0n)
      .sort((a, b) => (b.owed > a.owed ? 1 : b.owed < a.owed ? -1 : 0))
  }, [state.jobs, renderViewer, now])

  const totalOwed = rows.reduce((sum, r) => sum + r.owed, 0n)
  const emptyEscrows = state.jobs.length - rows.length

  return (
    <div className="min-w-0">
      <header className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-100">Wallet</h1>
        <p className="mt-1 text-sm leading-relaxed text-zinc-400">
          Your address is your sign-in. It is also the ledger key every escrow uses to record what
          it owes you.
        </p>
      </header>

      {/* ============================================================= connect / identity */}
      <section className="mt-5 min-w-0">
        <h2 className="sr-only">Connection</h2>
        <ConnectButton />
      </section>

      {/* ============================================================= network + MON */}
      {viewer !== null ? (
        <section className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <h3 className="text-xs font-medium text-zinc-400">Network</h3>
            <p className="mt-1 text-base font-semibold text-zinc-100">{monadTestnet.name}</p>
            <p className="mt-0.5 text-xs text-zinc-400">
              Chain {monadTestnet.id} · {monadTestnet.nativeCurrency.symbol}
            </p>
          </div>

          <div className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <h3 className="text-xs font-medium text-zinc-400">In your wallet</h3>
            <p className="mt-1 text-base font-semibold tabular-nums break-words text-zinc-100">
              {balance.isPending
                ? '…'
                : balance.isError
                  ? 'unavailable'
                  : `${formatMon(balance.data?.value ?? 0n)} MON`}
            </p>
            <p className="mt-0.5 text-xs text-zinc-400">
              Spendable now, and what pays for gas. Escrow balances are not counted here.
            </p>
          </div>
        </section>
      ) : null}

      {/* ============================================================= the distinction */}
      <section className="mt-5 min-w-0 rounded-2xl border border-accent/40 bg-accent/10 p-4 sm:p-5">
        <h2 className="text-base font-semibold text-zinc-100">
          &ldquo;Released&rdquo; is not &ldquo;paid&rdquo;
        </h2>
        <div className="mt-2 space-y-2 text-sm leading-relaxed text-zinc-300">
          <p>
            When a milestone releases — whether the client approved it, or the challenge window ran
            out and anyone triggered it — the escrow writes the amount to an internal balance under
            the recipient&rsquo;s address. That is all it does.{' '}
            <strong className="font-semibold text-zinc-100">No MON leaves the contract.</strong>
          </p>
          <p>
            Moving it is a second transaction, <code className="font-mono text-xs">withdraw()</code>
            , sent by whoever is owed. Until somebody sends it, a job can read fully Released and
            the wallet balance above will not have moved by a single wei.
          </p>
          <p className="text-zinc-400">
            The same is true of a reclaim and of a resolved dispute: both credit a balance here,
            and both still need a withdraw.
          </p>
        </div>
      </section>

      {/* ============================================================= owed per escrow */}
      <section className="mt-6 min-w-0">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-lg font-semibold text-zinc-100">Owed to you, per escrow</h2>
          {status !== 'booting' && status !== 'loading' && rows.length > 0 ? (
            <p className="text-sm text-zinc-400">
              <span className="font-semibold tabular-nums text-zinc-100">
                {formatMon(totalOwed)} MON
              </span>{' '}
              in total
            </p>
          ) : null}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-zinc-400">
          Each escrow keeps its own ledger, so each one is withdrawn separately. There is no pooled
          balance and nothing sweeps them together.
        </p>

        {source === 'sample' && status !== 'booting' ? (
          <EmptyState
            className="mt-3"
            tone={status === 'no-factory' ? 'warning' : 'accent'}
            title={
              status === 'no-factory'
                ? 'These balances are sample data — no escrow factory is configured'
                : 'These balances are sample data — no wallet is connected'
            }
            body={
              status === 'no-factory' ? (
                <p>
                  MonEscrow has not asked Monad anything, because there is no factory address to
                  ask. Nothing below is a claim about anybody&rsquo;s money, and every withdraw
                  button is disabled.
                </p>
              ) : (
                <p>
                  Balances are looked up by address, and there is no address yet. Connect above and
                  this list becomes yours; until then it is a walkthrough with the buttons off.
                </p>
              )
            }
            footnote={
              status === 'no-factory' ? (
                <>
                  Set <code className="font-mono">NEXT_PUBLIC_FACTORY_ADDRESS</code> and reload to
                  read real balances.
                </>
              ) : null
            }
          />
        ) : null}

        {status === 'booting' || status === 'loading' ? (
          <div className="mt-3 flex flex-col gap-3" aria-busy="true">
            <p className="sr-only" role="status">
              Reading what each escrow owes you.
            </p>
            {[0, 1].map((i) => (
              <div
                key={i}
                aria-hidden="true"
                className="h-40 animate-pulse rounded-2xl border border-zinc-800 bg-zinc-900"
              />
            ))}
          </div>
        ) : status === 'error' ? (
          <EmptyState
            className="mt-3"
            tone="warning"
            title="Monad testnet did not answer"
            body={
              <>
                <p>
                  Your escrow balances could not be read. That is unknown, not zero — do not read
                  this as &ldquo;you are owed nothing&rdquo;.
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
        ) : rows.length === 0 ? (
          <EmptyState
            className="mt-3"
            tone="neutral"
            title={`No escrow is holding a balance for ${shortAddress(renderViewer)}`}
            body={
              state.jobs.length === 0 ? (
                <p>
                  This address is not party to any escrow, so there is nothing anywhere that could
                  owe it.
                </p>
              ) : (
                <p>
                  All {state.jobs.length} of your escrows report a balance of zero for this
                  address. Money appears here after a release, a reclaim, or a resolved dispute —
                  and then it still needs a withdraw.
                </p>
              )
            }
            action={{ href: '/actions', label: 'See what is waiting on you' }}
          />
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {rows.map((row) => (
              <OwedCard key={row.job.escrow} row={row} live={source === 'chain'} />
            ))}
          </ul>
        )}

        {emptyEscrows > 0 && rows.length > 0 ? (
          <p className="mt-3 text-xs text-zinc-400">
            {emptyEscrows} other {emptyEscrows === 1 ? 'escrow holds' : 'escrows hold'} nothing for
            this address.
          </p>
        ) : null}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * One escrow's balance
 * ------------------------------------------------------------------ */

function OwedCard({ row, live }: { row: OwedRow; live: boolean }) {
  const { job, owed, permission } = row

  const blockedReason = !permission.allowed
    ? permission.reason
    : live
      ? null
      : 'This is sample data. There is no contract at this address, so MonEscrow will not pretend it can send anything.'

  const released = BigInt(job.releasedAmount)
  const refunded = BigInt(job.refundedAmount)

  return (
    <li className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Link
          href={jobHref(job)}
          className="min-w-0 text-sm font-medium break-words text-zinc-100 underline-offset-4 hover:underline"
        >
          {job.untrusted.title || 'Untitled job'}
        </Link>
        <span className="shrink-0 font-mono text-[0.6875rem] text-zinc-400">
          {shortAddress(job.escrow)}
        </span>
      </div>

      <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-zinc-100">
        <span className="text-xl font-bold tabular-nums">{formatMon(owed)} MON</span>
        <span className="text-xs text-zinc-400">credited to you inside this escrow</span>
      </p>

      <p className="mt-1 text-xs leading-relaxed text-zinc-400">
        This escrow has released {formatMon(released)} MON
        {refunded > 0n ? ` and refunded ${formatMon(refunded)} MON` : ''} of{' '}
        {formatMon(job.totalAmount)} MON. Released means credited here, not sent — the transaction
        below is what moves it to your wallet.
      </p>

      <div className="mt-3 min-w-0">
        <TxButton
          label={`Withdraw ${formatMon(owed)} MON`}
          request={
            live && permission.allowed
              ? { address: job.escrow, functionName: 'withdraw' }
              : null
          }
          blockedReason={blockedReason}
          hint="Withdraw takes the whole balance this escrow holds for you. There is no partial amount."
          successLabel="Withdrawn"
          successNote="That one really did move MON. Your wallet balance above should change once the block settles."
        />
      </div>
    </li>
  )
}

/** Wei from a decimal string, never `Number`. Unparseable reads as zero and the row disappears. */
function safeWei(value: string): bigint {
  if (!/^\d+$/.test(value.trim())) return 0n
  try {
    return BigInt(value.trim())
  } catch {
    return 0n
  }
}
