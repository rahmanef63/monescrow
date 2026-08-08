'use client'

/**
 * The Progress screen — Studio's docked-workflow direction, built.
 *
 * One milestone, rendered for whoever is looking at it. The three columns in the mockup are not
 * three screens: they are the same screen seen by the client, the freelancer and a bystander,
 * and the role is derived from the connected address rather than chosen. That is why the dock's
 * centre slot can be a single destination.
 *
 * # What the design is actually doing, and why it is right for this product
 *
 * A milestone in this system is a **state machine with a clock in the middle**, and every
 * previous screen described that in sentences. The mockup replaces the sentences with two
 * structures that carry the same information without being read:
 *
 *   - **The stepper.** Open → Submitted → Challenge → Released → Paid. Five dots and a line say
 *     where the money is, what already happened, and what is next. `Paid` is deliberately a
 *     separate step after `Released`, because the thing people get wrong about this contract is
 *     believing a released milestone has reached a wallet. It has not; `withdraw` is a second
 *     transaction. Making it a fifth dot teaches that without a paragraph.
 *   - **Outcomes, stated as a fork.** Silence → releasable. Objection → frozen. That is the
 *     entire argument of the product, drawn rather than argued, and it is shown *while the
 *     window is running* — the only moment when a person actually cares.
 */

import type { ReactNode } from 'react'
import { Group, GroupNote, Row, SectionHeader } from '@/components/ios'
import { MSTATE, type MState, type Role } from '@/lib/chat/types'
import { formatDuration } from '@/lib/chain'

/* ------------------------------------------------------------------ stepper */

export type Step = { key: string; label: string; state: 'done' | 'active' | 'todo' }

/**
 * Five states, and which one a milestone is in.
 *
 * `Paid` can never be derived from the milestone alone — the contract credits `owed` on release
 * and only `withdraw` moves it — so it is passed in. A stepper that guessed would be lying at
 * exactly the point the product is trying to be honest.
 */
export function stepsFor(state: MState, paid: boolean): Step[] {
  const order: MState[] = [MSTATE.Pending, MSTATE.Submitted, MSTATE.Attested, MSTATE.Released]
  const at = order.indexOf(state)

  const mark = (i: number): Step['state'] => {
    if (state === MSTATE.Released) return i < 4 ? 'done' : paid ? 'done' : 'active'
    if (at < 0) return 'todo' // Disputed or Refunded — off the happy path entirely
    return i < at ? 'done' : i === at ? 'active' : 'todo'
  }

  return [
    { key: 'open', label: 'Open', state: mark(0) },
    { key: 'submitted', label: 'Submitted', state: mark(1) },
    { key: 'challenge', label: 'Challenge', state: mark(2) },
    { key: 'released', label: 'Released', state: mark(3) },
    { key: 'paid', label: 'Paid', state: paid ? 'done' : 'todo' },
  ]
}

export function Stepper({ steps, caption }: { steps: Step[]; caption?: string }) {
  return (
    <div className="px-4 py-4">
      <ol className="flex items-center">
        {steps.map((s, i) => (
          <li key={s.key} className="flex min-w-0 flex-1 items-center last:flex-none">
            <span className="flex flex-col items-center gap-1.5">
              <span
                aria-hidden
                className={`size-3.5 rounded-full ring-4 ring-zinc-950 ${
                  s.state === 'done'
                    ? 'bg-accent'
                    : s.state === 'active'
                      ? 'bg-warning'
                      : 'bg-zinc-700'
                }`}
              />
              <span
                className={`text-[13px] whitespace-nowrap ${
                  s.state === 'todo' ? 'text-zinc-600' : s.state === 'active' ? 'text-warning' : 'text-zinc-400'
                }`}
              >
                {s.label}
              </span>
            </span>
            {i < steps.length - 1 ? (
              <span
                aria-hidden
                className={`-mt-5 h-0.5 min-w-2 flex-1 ${s.state === 'done' ? 'bg-accent' : 'bg-zinc-800'}`}
              />
            ) : null}
          </li>
        ))}
      </ol>
      {caption ? <p className="mt-3 text-center text-[13px] text-warning tabular-nums">{caption}</p> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ the clock */

/**
 * The window, given the size it deserves.
 *
 * Every other number on this screen is a fact. This one is the only number that is *changing*,
 * and it is the one the whole design exists to make impossible to miss.
 */
export function WindowBand({ secondsLeft, role }: { secondsLeft: number; role: Role }) {
  const line =
    role === 'client'
      ? 'You can object within'
      : role === 'freelancer'
        ? 'Releasable when this ends, with no objection'
        : 'Either party can object before this ends'

  return (
    <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[17px] font-semibold text-warning">Challenge window</p>
          <p className="mt-0.5 text-[13px] text-zinc-400">{line}</p>
        </div>
        <p className="shrink-0 text-[28px] leading-none font-bold text-warning tabular-nums">
          {clock(secondsLeft)}
        </p>
      </div>
    </div>
  )
}

/** mm:ss under an hour, then h:mm:ss. A countdown people watch needs a colon, not prose. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`
}

/* ------------------------------------------------------------------ outcomes */

/**
 * The fork, drawn. This is the product's argument and it belongs on screen while the clock is
 * running, not in a help page.
 */
export function Outcomes() {
  return (
    <Group>
      <Row
        leading={<Dot tone="ok" />}
        label="Silence releases it"
        detail="If nobody objects before the timer ends, anyone can release the funds."
        last={false}
      />
      <Row
        leading={<Dot tone="danger" />}
        label="An objection freezes it"
        detail="If the client objects, the milestone is frozen until the arbiter rules."
        last
      />
    </Group>
  )
}

function Dot({ tone }: { tone: 'ok' | 'danger' }) {
  return (
    <span
      aria-hidden
      className={`grid size-7 place-items-center rounded-full ${
        tone === 'ok' ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'
      }`}
    >
      <span className="text-[13px]">{tone === 'ok' ? '↑' : '✕'}</span>
    </span>
  )
}

/* ------------------------------------------------------------------ decision */

/**
 * A decision is two full-width rows, not two buttons in a line.
 *
 * The mockup is right about this: on a phone, the destructive-but-correct action and the
 * shortcut are both meaningful choices, and cramming them side by side makes the wider one look
 * like the default. Stacked rows with a subtitle each say what happens *before* it happens.
 */
export function DecisionRow(props: {
  label: string
  detail: string
  onClick?: () => void
  tone?: 'primary' | 'plain'
  disabled?: boolean
  disabledNote?: string
}) {
  const primary = props.tone === 'primary'
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors ${
        props.disabled
          ? 'cursor-not-allowed bg-zinc-900 opacity-50'
          : primary
            ? 'bg-accent text-zinc-950 hover:bg-accent/90'
            : 'bg-zinc-900 text-zinc-100 hover:bg-zinc-800'
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[17px] font-semibold">{props.label}</span>
        <span className={`mt-0.5 block text-[13px] ${primary ? 'text-zinc-950/70' : 'text-zinc-500'}`}>
          {props.disabled && props.disabledNote ? props.disabledNote : props.detail}
        </span>
      </span>
    </button>
  )
}

/* ------------------------------------------------------------------ shell */

export function ProgressHeader(props: { project: string; milestone: string; amount: string; amountLabel: string }) {
  return (
    <div className="pt-1">
      <p className="text-[13px] text-zinc-500">Project</p>
      <h1 className="text-[28px] leading-tight font-bold tracking-[-0.02em] text-zinc-50">{props.project}</h1>
      <div className="mt-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[13px] text-zinc-500">Milestone</p>
          <p className="truncate text-[20px] font-semibold text-zinc-100">{props.milestone}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[13px] text-zinc-500">{props.amountLabel}</p>
          <p className="text-[20px] font-semibold text-zinc-100 tabular-nums">{props.amount}</p>
        </div>
      </div>
    </div>
  )
}

export function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <>
      <SectionHeader note={note}>{title}</SectionHeader>
      {children}
    </>
  )
}

export { GroupNote, formatDuration }
