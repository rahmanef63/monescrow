'use client'

/**
 * The iOS grouped-list vocabulary, as the app's structural primitives.
 *
 * # Why a list and not cards
 *
 * The screens were a single column of rounded cards, which is what a web page looks like on a
 * phone rather than what a phone app looks like. The difference is not decoration, it is
 * structure: iOS groups *rows* and lets the group carry the corner radius, so a screen reads as
 * a few labelled regions instead of a stack of competing objects. Ten cards are ten things to
 * look at. Ten rows in two groups are two things to look at.
 *
 * The details that actually produce the feeling, none of which are obvious:
 *
 *   - **Separators inset to the text, not the container.** A hairline that starts at the label's
 *     left edge rather than the group's is the single most recognisable signal that this is a
 *     list. Full-width rules read as a table.
 *   - **17px body.** iOS body text is 17pt. Web defaults to 16, and that one pixel is most of
 *     why an otherwise correct layout still reads as a website.
 *   - **Section headers live outside the group**, in the page background, quiet and small.
 *   - **Value right, chevron last.** A row is label / value / affordance, in that order, always.
 *
 * # The signature: the separator is the clock
 *
 * `Row` accepts `drain`, a 0–1 fraction, and shrinks its own separator to that width in the
 * accent colour. The challenge window is the whole argument of this product — a passing check
 * does not pay anybody, it starts a clock, and the client's silence through that clock is what
 * settles it. So the clock is not a widget bolted onto a row; it is the row's own hairline
 * emptying out. A structural element carries the one fact that matters, which is the only good
 * reason to make a structural element unusual.
 *
 * Palette is fixed by C9 and Studio's manifest (#09090b surface, #836EF9 Monad accent). The
 * freedom spent here is in structure and type, not colour.
 */

import Link from 'next/link'
import type { ReactNode } from 'react'

/* ------------------------------------------------------------------ page */

/**
 * The grouped-list backdrop. Deliberately darker than the rows, which is what makes a group
 * read as raised rather than drawn.
 */
export function Screen({ title, trailing, children }: { title: string; trailing?: ReactNode; children: ReactNode }) {
  return (
    <div className="-mx-4 min-h-full bg-zinc-950 px-4 pb-8">
      <header className="flex items-end justify-between gap-3 pt-2 pb-1">
        {/* Large title: iOS opens a screen with the name of the thing, set big and tight. */}
        <h1 className="text-[34px] leading-tight font-bold tracking-[-0.02em] text-zinc-50">{title}</h1>
        {trailing ? <div className="pb-2 shrink-0">{trailing}</div> : null}
      </header>
      {children}
    </div>
  )
}

/** Small, quiet, outside the group — never a heading inside it. */
export function SectionHeader({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 pt-6 pb-2">
      <h2 className="text-[13px] font-medium tracking-[0.02em] text-zinc-500 uppercase">{children}</h2>
      {note ? <span className="text-[13px] text-zinc-600 tabular-nums">{note}</span> : null}
    </div>
  )
}

/** A rounded group of rows. The radius belongs to the group, not to each row. */
export function Group({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-xl bg-zinc-900">{children}</div>
}

/* ------------------------------------------------------------------ rows */

type RowBase = {
  label: ReactNode
  /** Second line under the label. Keep it to one fact. */
  detail?: ReactNode
  /** Right-aligned, before the chevron. Amounts, states, counts. */
  value?: ReactNode
  /** A dot, glyph or icon at the leading edge. */
  leading?: ReactNode
  /** Last row in a group has no separator. */
  last?: boolean
  /**
   * 0–1. Shrinks the separator to that fraction, in the accent colour — the challenge window
   * draining. 1 is a full window remaining, 0 is elapsed.
   */
  drain?: number
}

export type RowProps = RowBase & { href?: string; onClick?: () => void }

export function Row(props: RowProps) {
  const { label, detail, value, leading, last, drain, href, onClick } = props
  const interactive = Boolean(href || onClick)

  const body = (
    <>
      {leading ? <span className="shrink-0">{leading}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[17px] text-zinc-100">{label}</span>
        {detail ? <span className="mt-0.5 block truncate text-[13px] text-zinc-500">{detail}</span> : null}
      </span>
      {value ? <span className="shrink-0 text-[17px] text-zinc-400 tabular-nums">{value}</span> : null}
      {interactive ? <Chevron /> : null}
    </>
  )

  // The separator is a child rather than a border so it can be inset and, when draining, be a
  // different width and colour from the one above it.
  const sep =
    last === true ? null : (
      <span
        aria-hidden
        className={`absolute right-0 bottom-0 left-4 h-px ${drain === undefined ? 'bg-zinc-800' : 'bg-accent'}`}
        style={drain === undefined ? undefined : { width: `${Math.max(0, Math.min(1, drain)) * 100}%`, left: 0 }}
      />
    )

  const shell = 'relative flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left'

  if (href) {
    return (
      <Link href={href} className={`${shell} transition-colors active:bg-zinc-800`}>
        {body}
        {sep}
      </Link>
    )
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${shell} transition-colors active:bg-zinc-800`}>
        {body}
        {sep}
      </button>
    )
  }
  return (
    <div className={shell}>
      {body}
      {sep}
    </div>
  )
}

function Chevron() {
  return (
    <svg viewBox="0 0 8 14" aria-hidden className="size-3.5 shrink-0 text-zinc-600" fill="none">
      <path d="M1 1l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A state pill for the value slot. Colour carries the state; the word carries the meaning. */
export function Pill({ tone, children }: { tone: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'; children: ReactNode }) {
  const map = {
    neutral: 'bg-zinc-800 text-zinc-300',
    ok: 'bg-success/15 text-success',
    warn: 'bg-warning/15 text-warning',
    danger: 'bg-danger/15 text-danger',
    accent: 'bg-accent/15 text-accent',
  } as const
  return <span className={`rounded-md px-2 py-1 text-[13px] font-medium ${map[tone]}`}>{children}</span>
}

/* ------------------------------------------------------------------ segmented control */

/**
 * iOS picks between peer views with a segmented control, not underlined tabs. The distinction
 * matters here: client and freelancer are two views of the same list, not two destinations.
 */
export function Segmented<T extends string>(props: {
  options: readonly { value: T; label: string; count?: number }[]
  value: T
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div role="tablist" aria-label={props.label} className="flex gap-1 rounded-xl bg-zinc-900 p-1">
      {props.options.map((o) => {
        const active = o.value === props.value
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => props.onChange(o.value)}
            className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-[15px] font-medium transition-colors ${
              active ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400'
            }`}
          >
            {o.label}
            {o.count !== undefined ? (
              <span className={`text-[13px] tabular-nums ${active ? 'text-zinc-300' : 'text-zinc-600'}`}>{o.count}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

/** Explanatory text under a group. iOS puts the sentence here, quiet, never inside a row. */
export function GroupNote({ children }: { children: ReactNode }) {
  return <p className="px-4 pt-2 text-[13px] leading-snug text-zinc-500">{children}</p>
}
