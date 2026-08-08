'use client'

/**
 * Connect, disconnect, and the two cases people forget.
 *
 * Connecting a wallet **is** signing in — there is no account to create and no password to
 * lose. Which view of a job you get is decided by the connected address, never by a question.
 *
 * The two cases:
 *
 *   wrong chain   the wallet is connected but pointed somewhere else. Offer the switch and
 *                 name the chain, rather than letting every read quietly return nothing.
 *   no wallet     no injected provider at all. A "Connect" button that can only fail is worse
 *                 than a sentence saying what to install, so this renders the sentence.
 *
 * Two renderers, because a header is not a page. `compact` must stay pill-sized in *every*
 * state — a paragraph in the desktop top bar pushes the navigation off the screen.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from 'wagmi'
import { monadTestnet, shortAddress } from '@/lib/chain'

type ConnectButtonProps = {
  /** Pill only, no explanatory copy. For the desktop top bar, where width is scarce. */
  compact?: boolean
  className?: string
}

const BTN =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium ' +
  'whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-60'

const BTN_PRIMARY = `${BTN} bg-accent text-white hover:bg-accent/90 active:bg-accent/80`

const BTN_QUIET =
  `${BTN} border border-zinc-800 bg-zinc-900 text-zinc-100 ` +
  'hover:border-zinc-700 hover:bg-zinc-800'

const BTN_WARN =
  `${BTN} border border-warning/50 bg-warning/10 text-warning hover:bg-warning/20`

/**
 * False while rendering on the server and during hydration, true afterwards.
 *
 * `useSyncExternalStore` with a never-firing subscription rather than a `useState` + `useEffect`
 * mount flag: same two-phase result, but React is told about it through the API meant for
 * "this value differs between server and client", so it does not read as a cascading render.
 */
const neverChanges = () => () => {}
function useHydrated(): boolean {
  return useSyncExternalStore(
    neverChanges,
    () => true,
    () => false,
  )
}

/** Readable text out of an unknown throw, without `any` and without dumping a stack trace. */
function messageOf(error: unknown): string | null {
  if (!error) return null
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Something went wrong. Try again.'
}

/** How to add Monad testnet by hand, for when the wallet refuses the programmatic switch. */
function manualChainHint(): string {
  return (
    `Add it manually if your wallet does not know it yet — chain id ${monadTestnet.id}, ` +
    `RPC ${monadTestnet.rpcUrls.default.http[0]}, currency ${monadTestnet.nativeCurrency.symbol}.`
  )
}

export function ConnectButton({ compact = false, className }: ConnectButtonProps) {
  const connection = useConnection()
  const connectors = useConnectors()
  const { mutate: connect, isPending: isConnecting, error: connectError, reset } = useConnect()
  const { mutate: disconnect } = useDisconnect()
  const { mutate: switchChain, isPending: isSwitching, error: switchError } = useSwitchChain()

  // wagmi reconnects in an effect after hydration, so anything address-dependent has to wait
  // for this or the first client render will not match the server HTML.
  const mounted = useHydrated()

  /**
   * Which connectors actually have a provider behind them. `connectors` always contains the
   * base injected connector even in a browser with no wallet at all, so its presence proves
   * nothing — asking each one for its provider does. `null` means the probe has not finished;
   * an empty array means there is genuinely no wallet here.
   */
  const [usableUids, setUsableUids] = useState<readonly string[] | null>(null)
  useEffect(() => {
    let cancelled = false
    void Promise.all(
      connectors.map((c) =>
        c
          .getProvider()
          .then((provider) => (provider ? c.uid : null))
          .catch(() => null),
      ),
    ).then((results) => {
      if (!cancelled) setUsableUids(results.filter((uid): uid is string => uid !== null))
    })
    return () => {
      cancelled = true
    }
  }, [connectors])

  const usable = usableUids === null ? null : connectors.filter((c) => usableUids.includes(c.uid))
  const onMonad = connection.chainId === monadTestnet.id
  const connectErrorText = messageOf(connectError)

  const wrap = (children: React.ReactNode) => <div className={className}>{children}</div>

  // ============================================================== compact — the desktop bar
  if (compact) {
    if (!mounted) {
      return wrap(
        <span className={`${BTN_QUIET} pointer-events-none`} aria-hidden="true">
          Connect wallet
        </span>,
      )
    }

    if (connection.isConnected && !onMonad) {
      return wrap(
        <button
          type="button"
          className={BTN_WARN}
          onClick={() => switchChain({ chainId: monadTestnet.id })}
          disabled={isSwitching}
          title={`This wallet is on chain ${connection.chainId ?? 'unknown'}. MonEscrow escrows live on ${monadTestnet.name}, chain ${monadTestnet.id}. ${manualChainHint()}`}
        >
          {isSwitching ? 'Switching…' : 'Wrong network'}
        </button>,
      )
    }

    if (connection.isConnected) {
      return wrap(
        <div className="flex items-center gap-2">
          <span
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 font-mono text-sm whitespace-nowrap text-zinc-100"
            title={connection.address}
          >
            <span aria-hidden="true" className="size-2 rounded-full bg-success" />
            {shortAddress(connection.address)}
          </span>
          <button
            type="button"
            className={`${BTN_QUIET} px-3`}
            onClick={() => disconnect()}
            aria-label={`Disconnect ${shortAddress(connection.address)}`}
          >
            Sign out
          </button>
        </div>,
      )
    }

    if (usable === null) {
      return wrap(
        <span className={`${BTN_QUIET} pointer-events-none`}>Looking for a wallet…</span>,
      )
    }

    // A short sentence, not a button that could only fail. The full explanation is on /wallet.
    if (usable.length === 0) {
      return wrap(
        <p className="max-w-56 text-sm text-zinc-400" title="MonEscrow signs you in with a wallet instead of a password. Install MetaMask, Rabby or another injected wallet and reload.">
          No wallet in this browser.
        </p>,
      )
    }

    if (usable.length === 1) {
      return wrap(
        <button
          type="button"
          className={BTN_PRIMARY}
          disabled={isConnecting}
          onClick={() => {
            reset()
            connect({ connector: usable[0] })
          }}
        >
          {isConnecting ? 'Check your wallet…' : 'Connect wallet'}
        </button>,
      )
    }

    // More than one wallet announced itself. Native disclosure, no JS state, no dependency.
    return wrap(
      <details className="relative">
        <summary
          className={`${BTN_PRIMARY} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
        >
          Connect wallet
        </summary>
        <ul className="absolute top-full right-0 z-50 mt-2 w-56 rounded-xl border border-zinc-800 bg-zinc-900 p-1 shadow-xl">
          {usable.map((connector) => (
            <li key={connector.uid}>
              <button
                type="button"
                className="flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm text-zinc-100 hover:bg-zinc-800"
                disabled={isConnecting}
                onClick={() => {
                  reset()
                  connect({ connector })
                }}
              >
                {connector.name}
              </button>
            </li>
          ))}
        </ul>
      </details>,
    )
  }

  // ================================================================= full — the wallet page
  if (!mounted) {
    return wrap(
      <span
        className={`${BTN_QUIET} pointer-events-none w-full sm:w-auto`}
        aria-hidden="true"
      >
        Connect wallet
      </span>,
    )
  }

  if (connection.isConnected && !onMonad) {
    return wrap(
      <div
        className="flex flex-col gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4"
        role="status"
      >
        <p className="text-sm text-zinc-100">
          <span className="font-mono">{shortAddress(connection.address)}</span> is connected, but
          this wallet is on chain {connection.chainId ?? 'unknown'}. MonEscrow escrows live on{' '}
          {monadTestnet.name}, chain {monadTestnet.id} — nothing will load until you switch.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={() => switchChain({ chainId: monadTestnet.id })}
            disabled={isSwitching}
          >
            {isSwitching ? 'Waiting for your wallet…' : `Switch to ${monadTestnet.name}`}
          </button>
          <button type="button" className={BTN_QUIET} onClick={() => disconnect()}>
            Disconnect
          </button>
        </div>
        {switchError ? (
          <p role="alert" className="text-sm text-danger">
            {messageOf(switchError)} {manualChainHint()}
          </p>
        ) : null}
      </div>,
    )
  }

  if (connection.isConnected) {
    return wrap(
      <div className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div>
          <p className="text-xs text-zinc-400">Signed in as</p>
          <p className="mt-1 flex items-center gap-2 font-mono text-base break-all text-zinc-100">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-success" />
            {shortAddress(connection.address)}
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            {monadTestnet.name} · chain {monadTestnet.id}
            {connection.connector ? ` · ${connection.connector.name}` : ''}
          </p>
        </div>
        <p className="text-xs text-zinc-400">
          This address is your whole identity here. What you can do on any job is worked out from
          it — nobody picks a role.
        </p>
        <button type="button" className={`${BTN_QUIET} w-full`} onClick={() => disconnect()}>
          Disconnect
        </button>
      </div>,
    )
  }

  if (usable === null) {
    return wrap(
      <span className={`${BTN_QUIET} pointer-events-none w-full sm:w-auto`}>
        Looking for a wallet…
      </span>,
    )
  }

  // A sentence, not a dead button. Nothing here would work if it were pressed.
  if (usable.length === 0) {
    return wrap(
      <p className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-400">
        No wallet found in this browser. MonEscrow signs you in with a wallet instead of a
        password, so you will need one — install MetaMask, Rabby or another injected wallet, or
        open this page inside your wallet&apos;s own browser, then reload.
      </p>,
    )
  }

  return wrap(
    <div className="flex flex-col gap-2">
      {usable.map((connector) => (
        <button
          key={connector.uid}
          type="button"
          className={`${BTN_PRIMARY} w-full sm:w-auto`}
          disabled={isConnecting}
          onClick={() => {
            reset()
            connect({ connector })
          }}
        >
          {isConnecting
            ? 'Check your wallet…'
            : usable.length > 1
              ? `Connect ${connector.name}`
              : 'Connect wallet'}
        </button>
      ))}

      <p className="text-xs text-zinc-400">
        Connecting is signing in. There is no account and no password — your address is the login.
      </p>

      {connectErrorText ? (
        <p role="alert" className="text-sm text-danger">
          {connectErrorText}
        </p>
      ) : null}
    </div>,
  )
}

export default ConnectButton
