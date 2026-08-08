'use client'

/**
 * The five-slot dock.
 *
 * On a phone it is a fixed bottom bar and the third slot — the assistant — is raised, larger
 * and accented, because it is the thing the demo is about. On `md:` and up the same five
 * destinations become a top bar with the wordmark, so nothing is learned twice.
 *
 * The chat slot never navigates. It calls `onOpenChat`, and when nobody passed one it fires a
 * `monescrow:open-chat` event on `window` so the assistant sheet can own its own open state
 * without the root layout — a server component — having to hold a callback.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode, SVGProps } from 'react'
import { ConnectButton } from '@/components/ConnectButton'

/** Fired when the dock's centre slot is pressed and no `onOpenChat` was supplied. */
export const OPEN_CHAT_EVENT = 'monescrow:open-chat'

type IconProps = SVGProps<SVGSVGElement>

type Destination = {
  href: string
  label: string
  /** Read out instead of the label where "Actions" alone would not be enough. */
  hint: string
  icon: (props: IconProps) => ReactNode
}

const iconBase: IconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
}

function JobsIcon(props: IconProps) {
  return (
    <svg {...iconBase} {...props}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7" />
      <path d="M3 12h18" />
    </svg>
  )
}

function NewIcon(props: IconProps) {
  return (
    <svg {...iconBase} {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

function ChatIcon(props: IconProps) {
  return (
    <svg {...iconBase} {...props}>
      <path d="M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z" />
      <path d="M8.5 10.5h7" />
      <path d="M8.5 13.5h4" />
    </svg>
  )
}

function ActionsIcon(props: IconProps) {
  return (
    <svg {...iconBase} {...props}>
      <path d="M12 3a7 7 0 0 0-7 7c0 3-1 4.5-1.6 5.2a.6.6 0 0 0 .45 1h16.3a.6.6 0 0 0 .45-1C19.99 14.5 19 13 19 10a7 7 0 0 0-7-7Z" />
      <path d="M10 19.5a2.2 2.2 0 0 0 4 0" />
    </svg>
  )
}

function WalletIcon(props: IconProps) {
  return (
    <svg {...iconBase} {...props}>
      <path d="M3 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2" />
      <rect x="3" y="8" width="18" height="11" rx="2" />
      <path d="M16.5 13.5h.01" />
    </svg>
  )
}

/** Studio's progress-lock mark, inlined so the shell has no asset dependency to break. */
function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <path
        d="M19 28V20c0-8 5-13 13-13s13 5 13 13v3"
        fill="none"
        stroke="#f4f4f5"
        strokeWidth="6"
        strokeLinecap="round"
      />
      <rect x="8" y="25" width="48" height="31" rx="9" fill="#18181b" stroke="#f4f4f5" strokeWidth="4" />
      <rect x="15" y="34" width="7" height="13" rx="2.5" fill="#836EF9" />
      <rect x="26" y="34" width="7" height="13" rx="2.5" fill="#836EF9" />
      <rect x="37" y="34" width="7" height="13" rx="2.5" fill="#836EF9" />
      <rect x="48" y="34" width="3" height="13" rx="1.5" fill="#34d399" />
    </svg>
  )
}

/** Slots 1, 2 and slots 4, 5. The assistant sits between them and is not a destination. */
const LEFT: readonly Destination[] = [
  { href: '/', label: 'Jobs', hint: 'My jobs, as client and as freelancer', icon: JobsIcon },
  { href: '/new', label: 'New', hint: 'Create and fund a job', icon: NewIcon },
]

const RIGHT: readonly Destination[] = [
  {
    href: '/actions',
    label: 'Actions',
    hint: 'Everything currently waiting on me',
    icon: ActionsIcon,
  },
  {
    href: '/wallet',
    label: 'Wallet',
    hint: 'Connect, balance owed, and withdraw',
    icon: WalletIcon,
  },
]

/**
 * `/` is the job list, and a job detail page belongs to it — a user reading `/job/0x…` still
 * came from Jobs, so leaving every tab unlit there would just look broken.
 */
function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/' || pathname.startsWith('/job')
  return pathname === href || pathname.startsWith(`${href}/`)
}

export type DockProps = {
  /** Called instead of navigating when the centre slot is pressed. */
  onOpenChat?: () => void
}

export function Dock({ onOpenChat }: DockProps) {
  const pathname = usePathname() ?? '/'

  const openChat = () => {
    if (onOpenChat) {
      onOpenChat()
      return
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT))
    }
  }

  return (
    <>
      {/* ------------------------------------------------------------------ phone: bottom dock */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-50 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur-sm px-safe pb-safe md:hidden"
      >
        <ul className="mx-auto grid max-w-md grid-cols-5">
          {LEFT.map((d) => (
            <DockSlot key={d.href} destination={d} active={isActive(pathname, d.href)} />
          ))}

          <li className="relative">
            <button
              type="button"
              onClick={openChat}
              aria-haspopup="dialog"
              aria-label="Open the MonEscrow assistant"
              className="group flex h-16 w-full flex-col items-center justify-end gap-1 pb-2 text-[11px] font-medium text-zinc-100"
            >
              <span className="absolute -top-5 left-1/2 grid size-14 -translate-x-1/2 place-items-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 ring-4 ring-zinc-950 transition-transform group-active:scale-95">
                <ChatIcon className="size-6" strokeWidth={2} />
              </span>
              <span>Chat</span>
            </button>
          </li>

          {RIGHT.map((d) => (
            <DockSlot key={d.href} destination={d} active={isActive(pathname, d.href)} />
          ))}
        </ul>
      </nav>

      {/* ------------------------------------------------------------------- desktop: top bar */}
      <header className="fixed inset-x-0 top-0 z-50 hidden border-b border-zinc-800 bg-zinc-950/95 backdrop-blur-sm md:block">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-1 px-4">
          <Link
            href="/"
            className="mr-2 inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl px-1 text-zinc-100"
          >
            <Mark className="size-7" />
            <span className="hidden text-base font-bold tracking-tight lg:inline">MonEscrow</span>
            <span className="sr-only lg:hidden">MonEscrow — home</span>
          </Link>

          {/* The navigation never yields width — anything that has to give is on the right. */}
          <nav aria-label="Primary" className="shrink-0">
            <ul className="flex items-center gap-0.5">
              {LEFT.map((d) => (
                <BarSlot key={d.href} destination={d} active={isActive(pathname, d.href)} />
              ))}

              <li>
                <button
                  type="button"
                  onClick={openChat}
                  aria-haspopup="dialog"
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-3 text-sm font-medium text-white transition-colors hover:bg-accent/90"
                >
                  <ChatIcon className="size-5" />
                  Chat
                </button>
              </li>

              {RIGHT.map((d) => (
                <BarSlot key={d.href} destination={d} active={isActive(pathname, d.href)} />
              ))}
            </ul>
          </nav>

          <div className="ml-auto flex min-w-0 justify-end pl-2">
            <ConnectButton compact />
          </div>
        </div>
      </header>
    </>
  )
}

function DockSlot({ destination, active }: { destination: Destination; active: boolean }) {
  const { href, label, hint, icon: Icon } = destination
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? 'page' : undefined}
        className={`flex h-16 min-h-11 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors ${
          active ? 'text-accent' : 'text-zinc-400 hover:text-zinc-100'
        }`}
      >
        <Icon className="size-6" strokeWidth={active ? 2.1 : 1.75} />
        <span>{label}</span>
        <span className="sr-only">. {hint}</span>
      </Link>
    </li>
  )
}

function BarSlot({ destination, active }: { destination: Destination; active: boolean }) {
  const { href, label, hint, icon: Icon } = destination
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? 'page' : undefined}
        title={hint}
        className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium transition-colors ${
          active
            ? 'bg-zinc-900 text-accent'
            : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'
        }`}
      >
        <Icon className="size-5" />
        {label}
      </Link>
    </li>
  )
}

export default Dock
