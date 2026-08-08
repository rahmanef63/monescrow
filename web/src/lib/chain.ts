import { defineChain } from 'viem'

/**
 * Monad testnet. Chain id 10143, which is also pinned into the EIP-712 domain in C2 — an
 * attestation signed for one chain cannot be replayed onto another, and that only holds if
 * this number and the contract's agree.
 */
export const monadTestnet = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC || 'https://testnet-rpc.monad.xyz'],
    },
  },
  blockExplorers: {
    default: { name: 'MonadVision', url: 'https://testnet.monadexplorer.com' },
  },
  testnet: true,
})

/**
 * The factory, set by Alfa at integration (A-5).
 *
 * Empty until then, and the UI must say so rather than rendering an empty job list that looks
 * like "you have no jobs" — those are different facts and confusing them wastes somebody's
 * afternoon wondering where their escrow went.
 */
export const FACTORY_ADDRESS = (process.env.NEXT_PUBLIC_FACTORY_ADDRESS || '') as `0x${string}` | ''

export const VERIFIER_ADDRESS = (process.env.NEXT_PUBLIC_VERIFIER_ADDRESS || '') as `0x${string}` | ''

export const hasFactory = (): boolean => /^0x[0-9a-fA-F]{40}$/.test(FACTORY_ADDRESS)

/** Case-insensitive address comparison. Never compare addresses with `===`. */
export const sameAddress = (a?: string | null, b?: string | null): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** `0x1234…abcd`, the only form that fits a phone. */
export const shortAddress = (a?: string | null): string =>
  a && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a ?? '')

/**
 * Gas limit padding.
 *
 * **On Monad the user pays the gas limit, not the gas used**, so a wallet-chosen limit is
 * money taken from them for nothing. Every send in this app estimates, pads by this much for
 * the block-to-block variance, shows the resulting cost, and sends with that explicit limit.
 */
export const GAS_LIMIT_PADDING_PERCENT = 20n

export const withGasPadding = (estimate: bigint): bigint =>
  (estimate * (100n + GAS_LIMIT_PADDING_PERCENT)) / 100n

/** wei -> MON, trimmed, for display only. Never round-trip a displayed value back into a tx. */
export function formatMon(wei: bigint | string, maxDecimals = 4): string {
  const v = typeof wei === 'string' ? BigInt(wei) : wei
  const whole = v / 10n ** 18n
  const frac = v % 10n ** 18n
  if (frac === 0n) return whole.toString()
  const padded = frac.toString().padStart(18, '0').slice(0, maxDecimals).replace(/0+$/, '')
  return padded ? `${whole}.${padded}` : whole.toString()
}
