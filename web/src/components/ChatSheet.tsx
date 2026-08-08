'use client'

/**
 * The assistant — a bottom sheet on a phone, a side panel on a desktop.
 *
 * It is opened by the raised centre slot of the dock, which fires `monescrow:open-chat` on
 * `window` when nobody passed it a callback. This component listens for that, so the root
 * layout — a server component — never has to hold the open state.
 *
 * ## The cards are the whole point
 *
 * `POST /api/chat` returns `{ messages, cards, source }`. The cards are built server-side by the
 * permission layer from tool results, and this file renders **only** what came back in that
 * array. Nothing in the model's prose is parsed, scanned, matched or turned into a control: a
 * model that writes out a beautiful-looking button in its answer produces exactly zero buttons
 * here, because the only constructor of a card is `permits`.
 *
 * An `ActionCard` with `enabled: false` renders as a **disabled button carrying
 * `blockedBecause`**, never as a missing one. "The challenge window has two hours left" teaches
 * somebody how the escrow works; a button that quietly is not there teaches them nothing and
 * leaves them wondering whether the app is broken.
 *
 * A `DraftCard` is the same rule applied to the one thing the assistant most obviously cannot do.
 * Creating an escrow costs money and needs a signature, so a draft renders as a read-only split
 * and a link that opens `/new` with the fields filled in — the human edits it there and funds it
 * themselves. A `JobsCard` is a list of links and nothing else.
 *
 * An enabled card renders a real `TxButton`, which is the same simulate -> estimate gas -> show
 * the cost -> explicit click -> send with an explicit gas limit flow as every other write in the
 * app. There is no second path, and the assistant is not on this one: it put the button there,
 * and a human presses it. The first time a card appears the UI says so out loud, because it is
 * the same argument the whole product makes about the verifier.
 *
 * ## Degrading
 *
 * `source: "unavailable"` means there is no API key — no `x-llm-key` header and no
 * `ANTHROPIC_API_KEY` on the server. That is a normal state, not an error: the sheet says the
 * assistant needs a key, offers a field for one that is used per request and never stored, and
 * points out that every button on the job pages keeps working, since those are the only things
 * that can move money anyway.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useConnection } from 'wagmi'
import { OPEN_CHAT_EVENT } from '@/components/Dock'
import { Group, GroupNote, Row } from '@/components/ios'
import { TxButton } from '@/components/TxButton'
import { formatMon, shortAddress } from '@/lib/chain'
import type { TxRequest } from '@/lib/useTxFlow'
import type { ActionCard, Card, ChainAction, DraftCard, InfoCard, JobsCard, Role } from '@/lib/chat/types'
import type { CheckKind } from '@/lib/verify/types'

/* ------------------------------------------------------------------ wire shapes */

type ChatMessage = { role: 'user' | 'assistant'; content: string }

type ChatSource = 'llm' | 'unavailable'

type ChatBody = { messages: ChatMessage[]; cards: Card[]; source: ChatSource }

/** One thing in the transcript. Cards are entries in their own right, in arrival order. */
type Entry =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; content: string }
  | { kind: 'card'; id: string; card: Card }

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

let entrySeq = 0
function nextEntryId(): string {
  entrySeq += 1
  return `e${entrySeq}`
}

function isAddressString(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && ADDRESS_RE.test(value)
}

function isRole(value: unknown): value is Role {
  return value === 'client' || value === 'freelancer' || value === 'arbiter' || value === 'stranger'
}

function isCheckKind(value: unknown): value is CheckKind {
  return value === 'http' || value === 'github' || value === 'clientApproval'
}

/**
 * A draft, field by field.
 *
 * Checked properly rather than cast, because unlike an `ActionCard` — whose whole body is fed
 * to `TxButton`, which simulates before it will do anything — a draft is *rendered*, and
 * `card.milestones.map` on something that is not an array is a blank sheet with a stack trace
 * behind it. A malformed draft is dropped and the prose above it still stands.
 */
function readDraftCard(value: object): DraftCard | null {
  const c = value as { title?: unknown; totalAmount?: unknown; milestones?: unknown; source?: unknown }
  if (typeof c.title !== 'string' || typeof c.totalAmount !== 'string') return null
  if (c.source !== 'llm' && c.source !== 'template') return null
  if (!Array.isArray(c.milestones)) return null

  const milestones: DraftCard['milestones'] = []
  for (const entry of c.milestones) {
    if (typeof entry !== 'object' || entry === null) return null
    const m = entry as { title?: unknown; amount?: unknown; check?: unknown; rationale?: unknown }
    if (typeof m.title !== 'string' || typeof m.amount !== 'string') return null
    if (!isCheckKind(m.check) || typeof m.rationale !== 'string') return null
    milestones.push({ title: m.title, amount: m.amount, check: m.check, rationale: m.rationale })
  }

  return { kind: 'draft', title: c.title, totalAmount: c.totalAmount, milestones, source: c.source }
}

function readJobsCard(value: object): JobsCard | null {
  const c = value as { jobs?: unknown }
  if (!Array.isArray(c.jobs)) return null

  const jobs: JobsCard['jobs'] = []
  for (const entry of c.jobs) {
    if (typeof entry !== 'object' || entry === null) return null
    const j = entry as {
      escrow?: unknown
      title?: unknown
      role?: unknown
      milestones?: unknown
      totalAmount?: unknown
    }
    if (!isAddressString(j.escrow) || !isRole(j.role)) return null
    if (typeof j.title !== 'string' || typeof j.totalAmount !== 'string') return null
    if (typeof j.milestones !== 'number' || !Number.isInteger(j.milestones)) return null
    jobs.push({
      escrow: j.escrow,
      title: j.title,
      role: j.role,
      milestones: j.milestones,
      totalAmount: j.totalAmount,
    })
  }

  return { kind: 'jobs', jobs }
}

/** Narrow the route's 200 body without trusting it and without `any`. */
function readChatBody(value: unknown): ChatBody | null {
  if (typeof value !== 'object' || value === null) return null
  const body = value as { messages?: unknown; cards?: unknown; source?: unknown }
  if (!Array.isArray(body.messages) || !Array.isArray(body.cards)) return null
  if (body.source !== 'llm' && body.source !== 'unavailable') return null

  const messages: ChatMessage[] = []
  for (const entry of body.messages) {
    if (typeof entry !== 'object' || entry === null) return null
    const m = entry as { role?: unknown; content?: unknown }
    if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null
    messages.push({ role: m.role, content: m.content })
  }

  // Still the only place a card is ever constructed on this side: `body.cards`, by `kind`.
  // Two more kinds are recognised than were before; there is no second source and the prose
  // in `body.messages` is not looked at.
  const cards: Card[] = []
  for (const entry of body.cards) {
    if (typeof entry !== 'object' || entry === null) continue
    const c = entry as { kind?: unknown }
    if (c.kind === 'action' || c.kind === 'info') {
      cards.push(entry as Card)
      continue
    }
    if (c.kind === 'draft') {
      const draft = readDraftCard(entry)
      if (draft) cards.push(draft)
      continue
    }
    if (c.kind === 'jobs') {
      const jobs = readJobsCard(entry)
      if (jobs) cards.push(jobs)
    }
  }

  return { messages, cards, source: body.source }
}

function readError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const body = value as { error?: unknown }
  return typeof body.error === 'string' ? body.error : null
}

/* ------------------------------------------------------------------ cards -> calls */

/**
 * The call behind an action card, or the reason there is not one.
 *
 * Three of the ten chain actions carry arguments a card cannot: `submit` needs the hash of the
 * evidence being submitted, `resolveDispute` needs the arbiter's actual ruling, and `attest`
 * needs a verifier signature the assistant has no way to obtain — which is why the permission
 * layer never proposes it at all. Rather than build a button that would simulate to a revert,
 * those render disabled with a sentence saying which screen holds the missing input.
 */
function callForCard(card: ActionCard): { request: TxRequest } | { needs: string } {
  const address = card.escrow
  const milestone = card.milestone

  switch (card.action) {
    case 'accept':
      return { request: { address, functionName: 'accept' } }
    case 'cancel':
      return { request: { address, functionName: 'cancel' } }
    case 'withdraw':
      return { request: { address, functionName: 'withdraw' } }

    case 'approve':
    case 'dispute':
    case 'release':
    case 'reclaim': {
      if (milestone === undefined) {
        return { needs: 'This card does not say which milestone it means, so there is nothing to send.' }
      }
      return { request: { address, functionName: card.action, args: [BigInt(milestone)] } }
    }

    case 'submit':
      return {
        needs:
          'Submitting needs the evidence itself, which the assistant does not have. Open the ' +
          'milestone on the job page and submit it there — that screen hashes your evidence and ' +
          'commits the hash on-chain.',
      }

    case 'resolveDispute':
      return {
        needs:
          'Resolving a dispute means ruling for one side, and that is your decision to make, not ' +
          'something a card can carry. Open the disputed milestone on the job page.',
      }

    case 'attest':
      return {
        needs:
          'An attestation carries a verifier signature the assistant has no way to produce. The ' +
          'checker on the milestone page is what generates it.',
      }
  }
}

/**
 * What to say once the receipt lands.
 *
 * `release` and `approve` get the sentence people get wrong: a released milestone credits a
 * balance **inside the escrow**. It does not move MON to anybody's wallet. The recipient
 * withdraws it afterwards, which is a second transaction they have to send themselves.
 */
const SUCCESS_NOTE: Partial<Record<ChainAction, string>> = {
  release:
    'Released. That credits the freelancer’s balance inside the escrow — no MON has reached ' +
    'their wallet yet. They withdraw it separately, from the Wallet tab.',
  approve:
    'Approved. That credits the freelancer’s balance inside the escrow — no MON has reached ' +
    'their wallet yet. They withdraw it separately, from the Wallet tab.',
  reclaim:
    'Reclaimed. The amount is credited to your balance inside the escrow; withdraw it from the ' +
    'Wallet tab to get it back into your wallet.',
  withdraw: 'Withdrawn. This is the step that actually moves MON into your wallet.',
  cancel:
    'Cancelled. Your funding is credited back to your balance inside the escrow — withdraw it ' +
    'from the Wallet tab.',
  accept: 'Accepted. The job is live and its milestones can now be submitted.',
  dispute:
    'Disputed. The milestone is frozen and neither side can move it until the arbiter rules.',
}

const ROLE_LABEL: Record<Role, string> = {
  client: 'client',
  freelancer: 'freelancer',
  arbiter: 'arbiter',
  stranger: 'not a party',
}

const CHECK_LABEL: Record<CheckKind, string> = {
  clientApproval: 'client approval',
  http: 'automated HTTP check',
  github: 'automated GitHub check',
}

/**
 * wei -> "1.5 MON", or a visible refusal.
 *
 * Amounts arrive as decimal strings and `BigInt` throws on anything that is not one, which in
 * the middle of a render is a blank sheet. A string that is not a whole number of wei is a bug
 * worth showing rather than crashing over — and worth *not* silently rendering as 0.
 */
function monLabel(wei: string): string {
  return /^\d+$/.test(wei) ? `${formatMon(wei)} MON` : 'unreadable amount'
}

/**
 * How a draft gets to `/new`: one query parameter carrying the card as JSON.
 *
 * A query param rather than `sessionStorage` because a URL is stateless — it survives a
 * reload, a back/forward and being opened in a new tab, and there is no write-then-navigate
 * ordering to get wrong. `/new` parses it if it can and ignores it if it cannot, so the worst
 * case is the empty form somebody would have got anyway, never a half-filled one.
 *
 * A draft long enough to threaten a URL length limit is left behind deliberately, and the card
 * says so out loud, because a truncated `draft=` is exactly the broken form this avoids.
 */
const DRAFT_PARAM = 'draft'

const MAX_DRAFT_URL = 4000

function draftHref(card: DraftCard): string | null {
  const encoded = encodeURIComponent(JSON.stringify(card))
  return encoded.length > MAX_DRAFT_URL ? null : `/new?${DRAFT_PARAM}=${encoded}`
}

/* ------------------------------------------------------------------ classes */

const FIELD =
  'w-full min-h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-[0.9375rem] ' +
  'text-zinc-100 placeholder:text-zinc-600 focus:border-accent focus:outline-none'

const QUIET =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-zinc-800 ' +
  'bg-zinc-950 px-3 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-700 ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

const PRIMARY =
  'inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-accent px-4 ' +
  'text-[17px] font-semibold text-zinc-950 transition-colors hover:bg-accent/90'

/* ================================================================== the sheet */

export type ChatSheetProps = {
  /** Controlled open state. Omit and the sheet listens for the dock's `monescrow:open-chat`. */
  open?: boolean
  onClose?: () => void
  /** The escrow to talk about. Falls back to the `/job/0x…` route, then to a field in the sheet. */
  escrow?: `0x${string}`
}

export function ChatSheet({ open, onClose, escrow }: ChatSheetProps) {
  const controlled = open !== undefined
  const [selfOpen, setSelfOpen] = useState(false)
  const isOpen = controlled ? open : selfOpen

  const close = useCallback(() => {
    if (onClose) onClose()
    if (!controlled) setSelfOpen(false)
  }, [controlled, onClose])

  // The dock's centre slot. It dispatches this rather than holding a callback, so a server
  // component can render the dock without owning the sheet's state.
  useEffect(() => {
    if (controlled) return
    const openSheet = () => setSelfOpen(true)
    window.addEventListener(OPEN_CHAT_EVENT, openSheet)
    return () => window.removeEventListener(OPEN_CHAT_EVENT, openSheet)
  }, [controlled])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, close])

  if (!isOpen) return null
  return <Sheet onClose={close} escrowProp={escrow} />
}

/**
 * The sheet body, mounted only while open.
 *
 * Split out so the transcript, the draft and the drag offset are all created fresh when it
 * opens and thrown away when it closes — no stale conversation reappearing three screens later
 * attached to a different escrow.
 */
function Sheet({ onClose, escrowProp }: { onClose: () => void; escrowProp?: `0x${string}` }) {
  const uid = useId()
  const pathname = usePathname() ?? '/'
  const connection = useConnection()

  const routeEscrow = /^\/job\/(0x[0-9a-fA-F]{40})/.exec(pathname)?.[1]
  const [typedEscrow, setTypedEscrow] = useState('')
  const escrow = escrowProp ?? (routeEscrow as `0x${string}` | undefined) ?? undefined
  const target: `0x${string}` | null = escrow ?? (ADDRESS_RE.test(typedEscrow.trim()) ? (typedEscrow.trim() as `0x${string}`) : null)

  const [entries, setEntries] = useState<Entry[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<ChatSource | null>(null)
  const [llmKey, setLlmKey] = useState('')

  const [dragY, setDragY] = useState(0)
  const dragStart = useRef<number | null>(null)

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Focus the composer on open. A sheet that appears without focus is a sheet a keyboard user
  // has to go looking for.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Lock the page behind the sheet so a scroll gesture inside it does not drag the job list.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [entries])

  /**
   * Keep Tab inside the sheet.
   *
   * `aria-modal` tells a screen reader the rest of the page is inert; it does nothing at all to
   * the tab order. Without this, a keyboard user tabs out of an open dialog into a job list they
   * cannot see and has no way back.
   */
  const trapTab = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const root = dialogRef.current
    if (!root) return
    const focusable = root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), ' +
        'select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const history = entries.filter((e): e is Extract<Entry, { kind: 'message' }> => e.kind === 'message')
  const firstCardIndex = entries.findIndex((e) => e.kind === 'card')

  const send = useCallback(async () => {
    const text = draft.trim()
    if (text === '' || sending) return

    const outgoing: ChatMessage[] = [
      ...history.map((e) => ({ role: e.role, content: e.content })),
      { role: 'user' as const, content: text },
    ]

    setEntries((current) => [
      ...current,
      { kind: 'message', id: nextEntryId(), role: 'user', content: text },
    ])
    setDraft('')
    setSending(true)
    setError(null)

    try {
      const key = llmKey.trim()
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Per request only. Never stored, never logged, never echoed back.
          ...(key ? { 'x-llm-key': key } : {}),
        },
        body: JSON.stringify({
          // Omitted, not null, when there is no escrow. The route reads that as global mode:
          // no chain read, no action proposer, and an assistant that says what it cannot see
          // instead of describing a job nobody named. Sending a placeholder address here would
          // be the opposite — a plausible-looking escrow it would go and read.
          ...(target ? { escrow: target } : {}),
          // Claimed, not authenticated — and safe only because nothing behind this route
          // writes. With no wallet connected the zero address is honest: the assistant answers
          // as a stranger to this escrow, which is exactly what an unconnected reader is.
          account: connection.address ?? ZERO_ADDRESS,
          messages: outgoing,
        }),
      })

      const payload: unknown = await response.json()

      if (!response.ok) {
        setError(readError(payload) ?? 'The assistant could not read that request.')
        return
      }

      const body = readChatBody(payload)
      if (!body) {
        setError('The assistant answered in a shape MonEscrow does not recognise.')
        return
      }

      setSource(body.source)
      setEntries((current) => [
        ...current,
        ...body.messages.map(
          (m): Entry => ({ kind: 'message', id: nextEntryId(), role: m.role, content: m.content }),
        ),
        // Cards come from `body.cards` and from nowhere else. The prose above is never scanned.
        ...body.cards.map((card): Entry => ({ kind: 'card', id: nextEntryId(), card })),
      ])
    } catch {
      setError(
        'Could not reach the assistant. Nothing was sent on chain — the assistant never sends ' +
          'anything. The buttons on the job pages are unaffected.',
      )
    } finally {
      setSending(false)
    }
  }, [connection.address, draft, history, llmKey, sending, target])

  return (
    <>
      {/* Tap anywhere outside to dismiss. Under the dock (z-50) so the dock stays usable. */}
      <button
        type="button"
        aria-label="Close the assistant"
        onClick={onClose}
        className="fixed inset-0 z-30 cursor-default bg-zinc-950/70 backdrop-blur-[2px]"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        onKeyDown={trapTab}
        style={dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined}
        className={
          // phone: a sheet from the bottom, starting below the status area.
          'fixed inset-x-0 top-12 bottom-0 z-40 flex flex-col overflow-hidden rounded-t-2xl ' +
          'border border-zinc-800 bg-zinc-900 shadow-2xl ' +
          // desktop: a panel down the right-hand side, under the fixed top bar.
          'md:top-16 md:left-auto md:w-[26rem] md:rounded-t-none md:rounded-l-2xl md:border-r-0'
        }
      >
        {/* ------------------------------------------------------------ header + grab handle */}
        <div
          className="shrink-0 border-b border-zinc-800 px-3 pb-3"
          onTouchStart={(e) => {
            dragStart.current = e.touches[0].clientY
          }}
          onTouchMove={(e) => {
            if (dragStart.current === null) return
            const delta = e.touches[0].clientY - dragStart.current
            setDragY(delta > 0 ? delta : 0)
          }}
          onTouchEnd={() => {
            if (dragY > 96) onClose()
            dragStart.current = null
            setDragY(0)
          }}
        >
          <div className="flex justify-center py-2 md:hidden">
            <span aria-hidden="true" className="h-1.5 w-10 rounded-full bg-zinc-700" />
          </div>

          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 id={`${uid}-title`} className="text-base font-semibold text-zinc-100">
                Assistant
              </h2>
              <p className="mt-0.5 truncate text-xs text-zinc-500">
                {target ? (
                  <>
                    Escrow {shortAddress(target)} ·{' '}
                    {connection.address ? shortAddress(connection.address) : 'no wallet connected'}
                  </>
                ) : (
                  <>
                    No job selected ·{' '}
                    {connection.address ? shortAddress(connection.address) : 'no wallet connected'}
                  </>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close the assistant"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
            >
              <span aria-hidden="true" className="text-lg">
                ✕
              </span>
            </button>
          </div>
        </div>

        {/* ------------------------------------------------------------ transcript */}
        <div ref={logRef} className="flex-1 overflow-y-auto overscroll-contain px-3 py-4">
          <div className="flex flex-col gap-3">
            {entries.length === 0 ? <Intro connected={Boolean(connection.address)} /> : null}

            {escrow === undefined && entries.length === 0 ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                <label className="block text-xs font-medium tracking-wide text-zinc-400 uppercase" htmlFor={`${uid}-escrow`}>
                  Which escrow?
                </label>
                <input
                  id={`${uid}-escrow`}
                  className={`${FIELD} mt-1 font-mono text-sm`}
                  value={typedEscrow}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="0x…"
                  onChange={(e) => setTypedEscrow(e.target.value)}
                />
                <p className="mt-1 text-xs text-zinc-500">
                  Optional. Open a job and this fills itself in. Without one the assistant can
                  explain how MonEscrow works and draft a job for you, but it reads no chain
                  state at all and will say so rather than guess.
                </p>
              </div>
            ) : null}

            {entries.map((entry, index) =>
              entry.kind === 'message' ? (
                <Bubble key={entry.id} role={entry.role} content={entry.content} />
              ) : (
                <div key={entry.id} className="flex flex-col gap-2">
                  {index === firstCardIndex ? <ProposeNotice /> : null}
                  <CardView card={entry.card} />
                </div>
              ),
            )}

            {sending ? (
              <p className="text-sm text-zinc-500" aria-live="polite">
                {target ? 'Reading the chain…' : 'Thinking…'}
              </p>
            ) : null}

            {error ? (
              <p
                role="alert"
                className="rounded-xl border border-danger/50 bg-danger/10 px-3 py-2.5 text-sm text-[#fca5a5]"
              >
                {error}
              </p>
            ) : null}

            {source === 'unavailable' ? <KeyPrompt value={llmKey} onChange={setLlmKey} /> : null}
          </div>
        </div>

        {/* ------------------------------------------------------------ composer */}
        <div className="shrink-0 border-t border-zinc-800 bg-zinc-900 px-3 pt-3 pb-dock md:pb-3">
          <div className="flex items-end gap-2">
            <label className="sr-only" htmlFor={`${uid}-draft`}>
              {target ? 'Ask the assistant about this escrow' : 'Ask the assistant'}
            </label>
            <textarea
              id={`${uid}-draft`}
              ref={inputRef}
              rows={1}
              className={`${FIELD} max-h-32 min-h-11 resize-none py-3`}
              value={draft}
              placeholder={
                target ? 'What can I do with milestone 2?' : 'Help me set up a job for a new site'
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending || draft.trim() === ''}
              className={
                'inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent ' +
                'text-zinc-950 transition-colors hover:bg-accent/90 disabled:bg-zinc-800 ' +
                'disabled:text-zinc-500'
              }
              aria-label="Send"
            >
              <span aria-hidden="true">↑</span>
            </button>
          </div>
          <p className="mt-2 text-[0.6875rem] leading-relaxed text-zinc-500">
            The assistant reads chain state and proposes buttons. It cannot sign, send or move
            anything.
          </p>
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ pieces */

function Intro({ connected }: { connected: boolean }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm leading-relaxed text-zinc-400">
      <p className="text-zinc-100">Ask about this escrow.</p>
      <p className="mt-2">
        It reads the milestone states, the deadline and the challenge window straight off the
        chain, and it will tell you what this wallet can and cannot do — and why not, when it
        cannot.
      </p>
      <p className="mt-2">
        It will not tell you a milestone is complete. It did not look at the work, and neither did
        the verifier decide anything: a passing attestation is a proposal that opens your window
        to object.
      </p>
      {connected ? null : (
        <p className="mt-2 text-zinc-500">
          No wallet is connected, so it answers as a stranger to this escrow. Connect one and it
          derives your role from the address.
        </p>
      )}
    </div>
  )
}

/** Said once, the first time a card shows up. It is the argument the whole product makes. */
function ProposeNotice() {
  return (
    <p className="rounded-xl border border-accent/40 bg-accent/10 px-3 py-2.5 text-sm leading-relaxed text-zinc-100">
      <span className="font-semibold">The assistant proposes; you press.</span> A card is a
      description of a button, checked against the escrow’s own rules before it was built. Pressing
      one simulates the call, shows you the exact gas cost, and waits for a second, deliberate
      click before anything is signed.
    </p>
  )
}

function Bubble({ role, content }: { role: 'user' | 'assistant'; content: string }) {
  const mine = role === 'user'
  return (
    <div className={mine ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          'max-w-[85%] rounded-2xl px-3 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ' +
          (mine
            ? 'rounded-br-sm bg-accent/20 text-zinc-100'
            : 'rounded-bl-sm border border-zinc-800 bg-zinc-950 text-zinc-200')
        }
      >
        <span className="sr-only">{mine ? 'You said: ' : 'Assistant said: '}</span>
        {content}
      </div>
    </div>
  )
}

function CardView({ card }: { card: Card }) {
  if (card.kind === 'info') return <InfoCardView card={card} />
  if (card.kind === 'action') return <ActionCardView card={card} />
  if (card.kind === 'draft') return <DraftCardView card={card} />
  return <JobsCardView card={card} />
}

function InfoCardView({ card }: { card: InfoCard }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 text-sm font-semibold text-zinc-100">{card.title}</h3>
        <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[0.6875rem] text-zinc-400">
          you are the {ROLE_LABEL[card.role]}
        </span>
      </div>
      <dl className="flex flex-col gap-1.5 text-sm">
        {card.lines.map((line, i) => (
          <div key={`${line.label}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-3">
            <dt className="text-zinc-400">{line.label}</dt>
            <dd className="text-right break-all text-zinc-100">{line.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 font-mono text-[0.6875rem] break-all text-zinc-600">{card.escrow}</p>
    </div>
  )
}

function ActionCardView({ card }: { card: ActionCard }) {
  const call = callForCard(card)

  // Two different reasons a button can be dead, and they are not interchangeable. The escrow's
  // own rules said no — that is `blockedBecause`, written by the permission layer — or the call
  // needs an input a card cannot carry. Both render as a disabled button with the sentence.
  const blockedReason = !card.enabled
    ? (card.blockedBecause ??
      'The escrow’s rules do not allow this from your wallet right now, and the assistant did ' +
        'not say why. Open the job page for the current state.')
    : 'needs' in call
      ? call.needs
      : null

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3">
      <TxButton
        label={card.label}
        request={'request' in call ? call.request : null}
        blockedReason={blockedReason}
        hint={card.rationale}
        successNote={SUCCESS_NOTE[card.action]}
        variant={card.action === 'dispute' || card.action === 'cancel' ? 'danger' : 'primary'}
      />
      <p className="mt-2 font-mono text-[0.6875rem] break-all text-zinc-600">
        {card.action}
        {card.milestone !== undefined ? `(${card.milestone})` : '()'} · {card.escrow}
      </p>
    </div>
  )
}

/** The milestones added up, or null if any one of them is unreadable. */
function draftSum(card: DraftCard): bigint | null {
  let sum = 0n
  for (const m of card.milestones) {
    if (!/^\d+$/.test(m.amount)) return null
    sum += BigInt(m.amount)
  }
  return sum
}

/**
 * A proposed job.
 *
 * The one card with a button that is not a transaction, and it is not a transaction on purpose:
 * creating an escrow costs money and needs a signature, so the assistant hands over a filled-in
 * form and stops. Every number here is a suggestion the human overwrites in `/new`, and the
 * escrow does not exist until they fund it themselves.
 */
function DraftCardView({ card }: { card: DraftCard }) {
  const href = draftHref(card)
  const total = /^\d+$/.test(card.totalAmount) ? BigInt(card.totalAmount) : null
  const sum = draftSum(card)
  // Only worth saying when both sides are readable and they disagree — `/new` re-checks this
  // anyway, but finding out here beats finding out at the disabled create button.
  const mismatch = total !== null && sum !== null && sum !== total ? monLabel(sum.toString()) : null

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="min-w-0 text-[17px] font-semibold text-zinc-100">{card.title}</h3>
        <span className="shrink-0 text-[17px] font-semibold text-zinc-100 tabular-nums">
          {monLabel(card.totalAmount)}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-zinc-500">
          {card.milestones.length} milestone{card.milestones.length === 1 ? '' : 's'} · nothing on
          chain yet
        </span>
        <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[13px] text-zinc-400">
          {card.source === 'template' ? 'template split' : 'model split'}
        </span>
      </div>

      {card.milestones.length === 0 ? (
        <p className="mt-3 text-[13px] leading-relaxed text-zinc-500">
          This draft has no milestones in it, so there is nothing to carry over. Add them by hand in
          New job.
        </p>
      ) : (
        <ol className="mt-3 flex flex-col">
          {card.milestones.map((m, i) => (
            <li
              key={`${i}-${m.title}`}
              className="border-t border-zinc-800 py-3 first:border-t-0 first:pt-0 last:pb-0"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-[17px] text-zinc-100">
                  {i + 1}. {m.title}
                </span>
                <span className="shrink-0 text-[17px] text-zinc-400 tabular-nums">
                  {monLabel(m.amount)}
                </span>
              </div>
              <p className="mt-0.5 text-[13px] text-zinc-500">{CHECK_LABEL[m.check]}</p>
              {m.rationale ? (
                <p className="mt-1 text-[13px] leading-relaxed text-zinc-400">{m.rationale}</p>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {mismatch ? (
        <p className="mt-3 text-[13px] leading-relaxed text-warning">
          These add up to {mismatch}, not the total above. The constructor reverts on any
          difference, so New job holds the create button until you have squared it.
        </p>
      ) : null}

      {href === null ? (
        <p className="mt-3 text-[13px] leading-relaxed text-zinc-400">
          This draft is too long to carry in a link, so{' '}
          <Link href="/new" className="text-accent-soft underline underline-offset-4">
            New job
          </Link>{' '}
          opens empty. The split above stays here to copy from.
        </p>
      ) : (
        <Link href={href} className={`${PRIMARY} mt-3`}>
          Open in New job
        </Link>
      )}

      <p className="mt-2 text-[13px] leading-relaxed text-zinc-500">
        Advisory only. Every title, amount and check is editable there, and nothing exists on chain
        until you fund it yourself.{' '}
        {card.source === 'template'
          ? 'This split came from the deterministic template — no key, no model, no judgement about the work.'
          : 'This split came from a model, which did not look at the work and cannot be held to it.'}
      </p>
    </div>
  )
}

/**
 * Every escrow this wallet is party to. Read-only, and from the chain rather than a database —
 * there is no account here to have a list attached to it.
 */
function JobsCardView({ card }: { card: JobsCard }) {
  if (card.jobs.length === 0) {
    return (
      <p className="text-[17px] leading-relaxed text-zinc-400">
        This wallet is not a party to any escrow yet — not as a client, a freelancer or an arbiter.
      </p>
    )
  }

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-2">
      <Group>
        {card.jobs.map((job, i) => (
          <Row
            key={`${job.escrow}-${i}`}
            label={job.title}
            detail={`${ROLE_LABEL[job.role]} · ${job.milestones} milestone${job.milestones === 1 ? '' : 's'}`}
            value={monLabel(job.totalAmount)}
            href={`/job/${job.escrow}`}
            last={i === card.jobs.length - 1}
          />
        ))}
      </Group>
      <GroupNote>Opening one shows what this wallet can do there, and why not when it cannot.</GroupNote>
    </div>
  )
}

function KeyPrompt({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const uid = useId()
  const [visible, setVisible] = useState(false)
  return (
    <div className="rounded-xl border border-warning/40 bg-warning/5 p-3">
      <p className="text-sm leading-relaxed text-zinc-100">
        <span className="font-semibold">The assistant needs an API key.</span> This deployment has
        none. Paste your own below and it is used for that request only — never stored, never
        logged.
      </p>
      <div className="mt-3 flex gap-2">
        <label className="sr-only" htmlFor={`${uid}-key`}>
          Anthropic API key, used for this request only
        </label>
        <input
          id={`${uid}-key`}
          className={FIELD}
          type={visible ? 'text' : 'password'}
          value={value}
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-…"
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className={QUIET} onClick={() => setVisible((v) => !v)} aria-pressed={visible}>
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-zinc-400">
        Everything else keeps working without one. The buttons on the job pages read the same chain
        state, and they are the only things that can move money anyway.
      </p>
    </div>
  )
}

export default ChatSheet
