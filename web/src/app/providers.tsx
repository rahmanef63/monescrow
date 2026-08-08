'use client'

/**
 * The client-side root: wagmi, then react-query.
 *
 * There is no session, no cookie and no user record anywhere below this file. **The wallet is
 * the login.** Whatever address is connected is who you are, and every screen derives its role
 * from that address against the escrow it is showing — nothing ever asks a user to pick.
 */

import { useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider, createConfig, http, injected } from 'wagmi'
import { monadTestnet } from '@/lib/chain'

/**
 * The Para seam.
 *
 * `NEXT_PUBLIC_PARA_API_KEY` empty — which is the committed default, and what a judge running
 * from a clean clone will have — means injected wallets only. Adding Para later is one
 * connector pushed onto the array below and a dependency; nothing else in the app knows or
 * cares which connector produced the address. Deliberately no `@getpara/*` import today: an
 * unused SDK is bundle weight and a supply-chain surface bought for nothing.
 */
export const PARA_API_KEY: string = process.env.NEXT_PUBLIC_PARA_API_KEY ?? ''

/** True once a Para key is configured. Until then the app is injected-wallet only. */
export const hasParaKey: boolean = PARA_API_KEY.length > 0

/**
 * One config for the whole app, created at module scope.
 *
 * `ssr: true` stops wagmi reading `localStorage` while rendering on the server, so the first
 * client paint matches the server HTML and React does not throw a hydration mismatch. The
 * reconnect happens in an effect afterwards, which is why every wallet-dependent control in
 * this app renders a stable placeholder until it has mounted.
 */
export const wagmiConfig = createConfig({
  chains: [monadTestnet],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [monadTestnet.id]: http(),
  },
  // EIP-6963: lets the browser announce every installed wallet rather than fighting over
  // `window.ethereum`, so a user with two extensions gets a choice instead of a coin flip.
  multiInjectedProviderDiscovery: true,
  ssr: true,
})

/** Types every wagmi hook in the app against the config above, so `chainId` is 10143 or nothing. */
declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}

export function Providers({ children }: { children: ReactNode }) {
  // Held in state, not module scope: a module-level QueryClient is shared between requests on
  // the server, which leaks one user's cached chain reads into the next user's render.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Chain state moves; a stale escrow is a wrong escrow. Short, not zero, so that
            // navigating between the job list and a job does not refetch everything twice.
            staleTime: 5_000,
            retry: 1,
            refetchOnWindowFocus: true,
          },
        },
      }),
  )

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  )
}

export default Providers
