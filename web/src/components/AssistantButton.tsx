'use client'

/**
 * The assistant's door.
 *
 * The dock used to own it: the raised centre slot fired `monescrow:open-chat` and `ChatSheet`
 * — mounted once in the root layout — listened. Then Studio moved that slot to `/progress`,
 * which is the right call, and the phone lost its only way in. The desktop top bar still had a
 * "Chat" button, so nothing looked broken from a laptop; on the device the demo actually runs
 * on, the assistant had no door at all.
 *
 * So the door is its own component now, and it owns the event name. Whoever renders this button
 * is the only thing in the app that dispatches `OPEN_CHAT_EVENT`, which means the next person to
 * re-shuffle the dock cannot accidentally delete the entrance while leaving the listener behind.
 *
 * Two placements, mutually exclusive by breakpoint:
 *
 *   `floating`  the phone. Fixed above the dock, bottom right, clear of the home indicator.
 *   `bar`       `md:` and up. Inline in the top bar, where a floating circle would be noise.
 *
 * It opens a sheet, it does not navigate and it does not send anything — `aria-haspopup="dialog"`
 * is the literal truth. Every write in this app is still a wallet signature on a button a human
 * pressed; the assistant only ever proposes one.
 */

import type { ReactNode, SVGProps } from 'react'

/** Fired on `window` when the assistant button is pressed. `ChatSheet` listens for it. */
export const OPEN_CHAT_EVENT = 'monescrow:open-chat'

type IconProps = SVGProps<SVGSVGElement>

function ChatIcon(props: IconProps): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z" />
      <path d="M8.5 10.5h7" />
      <path d="M8.5 13.5h4" />
    </svg>
  )
}

export type AssistantButtonProps = {
  /** Where this instance lives. See the header — the two placements never render together. */
  placement?: 'floating' | 'bar'
}

/**
 * 44px exactly, which is the floor rather than a coincidence, and `size-11` instead of `h-11 w-11`
 * so the shape stays circular if somebody changes one number.
 */
const BASE =
  'inline-grid size-11 place-items-center rounded-full bg-accent text-white ' +
  'transition-transform hover:bg-accent/90 active:scale-95 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950'

/**
 * Sits *above* the dock rather than on it.
 *
 * The offset is the dock's own height token plus the safe area plus a gap, so it tracks
 * `--mon-dock-h` instead of re-guessing 4rem — the same technique `UpdateToast` uses to clear
 * the same bar. `z-40` keeps it under the dock's `z-50`, so a tap near the boundary belongs to
 * the Wallet slot, not to this; and because it is a lone 44px circle with no wrapper, there is no
 * invisible full-width strip to swallow taps meant for the dock underneath.
 */
const FLOATING =
  'fixed right-4 z-40 shadow-lg shadow-black/40 ring-4 ring-zinc-950 md:hidden ' +
  'bottom-[calc(env(safe-area-inset-bottom,0px)+var(--mon-dock-h,4rem)+0.75rem)]'

export function AssistantButton({ placement = 'floating' }: AssistantButtonProps) {
  const onClick = () => {
    // Guarded because a stray render on the server must not throw; in practice this is a click
    // handler, so `window` is always there by the time it runs.
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT))
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-label="Open the assistant"
      title="Ask the assistant about your jobs"
      className={placement === 'floating' ? `${BASE} ${FLOATING}` : BASE}
    >
      <ChatIcon className="size-5" />
    </button>
  )
}

export default AssistantButton
