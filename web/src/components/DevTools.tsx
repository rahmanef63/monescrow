'use client'

/**
 * The presenter's autofill panel. Nobody types a 42-character address on stage.
 *
 * # The password is a latch, not security, and must never be described as one
 *
 * `rahmann` exists so this panel does not spring open when somebody brushes the corner of the
 * screen during a demo. That is its entire job. The string is compiled into a **public client
 * bundle** — anyone who opens devtools, or reads the JavaScript this page serves, has it in ten
 * seconds. It protects nothing and is not claimed to.
 *
 * That is acceptable for one reason, which is a hard constraint on every future edit here:
 *
 *   **This panel grants no capability its user does not already have.** It types into forms
 *   that are already on their screen and copies addresses that are already public. Nothing else.
 *
 * Concretely, and please keep every line of it true:
 *
 *   - it **never signs** anything and holds no key;
 *   - it **never bypasses a wallet** — every write in MonEscrow stays the ordinary
 *     simulate → estimate → explicit human click → send flow, signed by whoever holds the wallet;
 *   - it **never calls an API route**, with elevated anything or otherwise;
 *   - it **never touches a server**. The only outward call in this file is
 *     `navigator.clipboard.writeText`, which goes to the user's own clipboard.
 *
 * If a later task seems to want this panel to *do* something — send a transaction, mint a demo
 * escrow, act as a party — that is a different feature with a different threat model, and a
 * password baked into a public bundle is not the gate for it. Stop and say so.
 *
 * # Why the fills dispatch events instead of assigning `.value`
 *
 * `input.value = 'x'` updates the DOM and tells React nothing. React keeps a value tracker on
 * the node and compares against it before deciding an `input` event is a real change, so a
 * direct assignment leaves the form **looking** filled while the component still holds the empty
 * string — and the create button then submits blank, on stage, having visibly been filled in.
 *
 * The fix is to write through the prototype's own `value` setter (which the tracker does not
 * shadow) and then dispatch a bubbling `input` event, which is what React's root listener
 * actually reacts to. `setFieldValue` below is the only place that knows this.
 */

import { useCallback, useState, useSyncExternalStore, type FormEvent } from 'react'
import { usePathname } from 'next/navigation'
import { Group, GroupNote, Row, SectionHeader } from '@/components/ios'
import { shortAddress } from '@/lib/chain'
import {
  DEMO_ADDRESSES,
  DEMO_BRIEF,
  DEMO_CRITERIA,
  DEMO_EVIDENCE,
  DEMO_MILESTONES,
  DEMO_TITLE,
  DEMO_TOTAL_MON,
  escrowFromPath,
  isUnlocked,
  lock,
  unlock,
} from '@/lib/devtools'

/* ================================================================== talking to the forms */

type Field = HTMLInputElement | HTMLTextAreaElement

function isField(node: Element | null): node is Field {
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
}

/**
 * Type a value into a field the way a person would, as far as React can tell.
 *
 * See the file header for why the prototype setter and the dispatched event are both required.
 * `change` goes out alongside `input` so a field wired the uncontrolled way is covered too.
 */
function setFieldValue(field: Field, value: string): void {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter) setter.call(field, value)
  else field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.dispatchEvent(new Event('change', { bubbles: true }))
}

function fieldById(id: string): Field | null {
  const node = document.getElementById(id)
  return isField(node) ? node : null
}

/**
 * Fields found by their placeholder text.
 *
 * Not how one would wire two components that could import each other — but `WorkPanel` and
 * `MilestoneEditor` belong to other people this week, and a demo aid is not a reason to make
 * them grow ids for its benefit. The cost is that a renamed placeholder silently stops matching,
 * so every fill below **reports how many fields it found** rather than quietly doing nothing.
 */
function fieldsByPlaceholder(placeholder: string): Field[] {
  const selector = `input[placeholder="${placeholder}"], textarea[placeholder="${placeholder}"]`
  return [...document.querySelectorAll(selector)].filter(isField)
}

function addressOf(role: string): string {
  return DEMO_ADDRESSES.find((party) => party.role === role)?.address ?? ''
}

/**
 * Hand the event loop back so React commits before the next field is written.
 *
 * Not superstition — this was a real bug, caught by checking rather than assuming. Filling the
 * four milestone rows in one synchronous burst left **only the last amount** set and every title
 * untouched, while the status line cheerfully claimed all four were filled.
 *
 * The reason is that `/new` keeps the whole list in one `useState`, and `MilestoneEditor.patch`
 * builds its next array from the `milestones` it closed over at its last render. React batches
 * every update raised inside one task, so all eight writes read the same stale array and the
 * last one won. Separate `useState` cells — the brief, the total, each address — never collide
 * that way, which is exactly why the first fill looked fine and hid the problem.
 *
 * A macrotask between writes lets React re-render and hand the row a fresh closure, so each
 * write builds on the previous one. Every fill yields, not just the list, because the next
 * person to add a field should not have to know which state shape they landed in.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/* ================================================================== the fills */

/** Each returns one sentence for the status line — what it did, or why it could not. */
type FillAction = {
  key: string
  label: string
  detail: string
  run: () => Promise<string>
}

async function fillBrief(): Promise<string> {
  const pairs: readonly (readonly [string, string])[] = [
    ['job-title', DEMO_TITLE],
    ['job-brief', DEMO_BRIEF],
    ['job-total', DEMO_TOTAL_MON],
    ['freelancer', addressOf('Freelancer')],
    ['arbiter', addressOf('Arbiter')],
  ]

  let filled = 0
  for (const [id, value] of pairs) {
    const field = fieldById(id)
    if (field === null || value === '') continue
    setFieldValue(field, value)
    filled += 1
    await settle()
  }

  if (filled === 0) return 'None of those fields are on this screen — the brief form lives on /new.'
  if (filled < pairs.length) return `Filled ${filled} of ${pairs.length} fields; the rest are not on screen.`
  return `Filled the brief, ${DEMO_TOTAL_MON} MON, the freelancer and the arbiter.`
}

const MILESTONE_TITLE_PLACEHOLDER = 'What this milestone delivers'
const MILESTONE_AMOUNT_PLACEHOLDER = '0.0'

async function fillMilestones(): Promise<string> {
  const onScreen = Math.max(
    fieldsByPlaceholder(MILESTONE_TITLE_PLACEHOLDER).length,
    fieldsByPlaceholder(MILESTONE_AMOUNT_PLACEHOLDER).length,
  )

  if (onScreen === 0) {
    return 'No milestone rows on screen. Propose them from the brief first, or add one by hand.'
  }

  const rows = Math.min(DEMO_MILESTONES.length, onScreen)
  for (let i = 0; i < rows; i++) {
    // Re-queried each time rather than captured up front: a commit happens between writes, and
    // a node list from before it is a list that may no longer be attached to anything.
    const title = fieldsByPlaceholder(MILESTONE_TITLE_PLACEHOLDER)[i]
    if (title !== undefined) {
      setFieldValue(title, DEMO_MILESTONES[i].title)
      await settle()
    }
    const amount = fieldsByPlaceholder(MILESTONE_AMOUNT_PLACEHOLDER)[i]
    if (amount !== undefined) {
      setFieldValue(amount, DEMO_MILESTONES[i].amountMon)
      await settle()
    }
  }

  if (onScreen !== DEMO_MILESTONES.length) {
    return (
      `Filled ${rows} rows, but there are ${onScreen} on screen and the fixture has ` +
      `${DEMO_MILESTONES.length}. The split will not add up to ${DEMO_TOTAL_MON} MON until that matches.`
    )
  }
  return `Filled all ${rows} milestones. They add up to exactly ${DEMO_TOTAL_MON} MON.`
}

async function fillEvidence(): Promise<string> {
  // The deployed-URL placeholder is the marker that this really is the submit form: `owner/name`
  // alone would also match the GitHub criteria field over on /new.
  if (fieldsByPlaceholder('https://demo.example.com').length === 0) {
    return 'The submit-work form is not open. Start a submission on a job first.'
  }

  const pairs: readonly (readonly [string, string | undefined])[] = [
    ['https://demo.example.com', DEMO_EVIDENCE.url],
    ['owner/name', DEMO_EVIDENCE.repo],
    ['abc123…', DEMO_EVIDENCE.commit],
    ['Deployed to Vercel, OAuth configured', DEMO_EVIDENCE.note],
  ]

  let filled = 0
  for (const [placeholder, value] of pairs) {
    const field = fieldsByPlaceholder(placeholder)[0]
    if (field === undefined || value === undefined) continue
    setFieldValue(field, value)
    filled += 1
    await settle()
  }
  return `Filled ${filled} of ${pairs.length} evidence fields.`
}

async function fillPastedJson(): Promise<string> {
  const boxes = [...document.querySelectorAll('textarea[placeholder^="Paste the "]')].filter(isField)
  const box = boxes[0]
  if (box === undefined) {
    return 'No paste box on screen. It only appears when this browser is missing the document.'
  }

  // The panel asks for whichever document this browser is missing, and says which in its own
  // placeholder — so read that rather than guessing, or the paste will never match the hash.
  const wantsEvidence = box.placeholder.toLowerCase().includes('evidence')
  setFieldValue(box, JSON.stringify(wantsEvidence ? DEMO_EVIDENCE : DEMO_CRITERIA.http, null, 2))
  await settle()
  return wantsEvidence
    ? 'Pasted the demo evidence JSON. It is still checked against the hash on chain.'
    : 'Pasted the demo criteria JSON. It is still checked against the hash on chain.'
}

const FILLS: readonly FillAction[] = [
  {
    key: 'brief',
    label: 'Brief, total and parties',
    detail: 'Title, brief, 6 MON, freelancer, arbiter — the /new form',
    run: fillBrief,
  },
  {
    key: 'milestones',
    label: 'Milestone titles and amounts',
    detail: 'Overwrites the rows on screen with the fixture split',
    run: fillMilestones,
  },
  {
    key: 'evidence',
    label: 'Evidence form',
    detail: 'URL, repo, commit and note in the submit panel',
    run: fillEvidence,
  },
  {
    key: 'json',
    label: 'Criteria or evidence JSON',
    detail: 'Into the paste box, when a document is missing locally',
    run: fillPastedJson,
  },
]

/* ================================================================== the latch, as a store */

/**
 * The latch read the way React wants an external value read.
 *
 * `sessionStorage` does not exist on the server, so the state cannot be seeded during render
 * without a hydration mismatch — and seeding it from an effect is a cascading render React now
 * warns about, rightly. `useSyncExternalStore` is the primitive for exactly this shape: a server
 * snapshot of `false`, a client snapshot read straight from storage, and an explicit notify when
 * we are the ones who changed it. `/new` reads the wall clock the same way.
 */
const latchListeners = new Set<() => void>()

function subscribeToLatch(onChange: () => void): () => void {
  latchListeners.add(onChange)
  return () => {
    latchListeners.delete(onChange)
  }
}

/** Called after `unlock`/`lock`, which are the only things in the app that move the latch. */
function latchChanged(): void {
  for (const listener of latchListeners) listener()
}

/** The server has no tab, so it has no latch. */
const latchOnServer = (): boolean => false

/* ================================================================== the panel */

const PANEL_FIELD =
  'min-h-11 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-[17px] text-zinc-100 ' +
  'placeholder:text-zinc-600 focus:border-accent focus:outline-none'

export function DevTools() {
  const pathname = usePathname() ?? '/'
  const escrow = escrowFromPath(pathname)

  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState('')
  const [refused, setRefused] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const unlocked = useSyncExternalStore(subscribeToLatch, isUnlocked, latchOnServer)

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (unlock(attempt)) {
        latchChanged()
        setAttempt('')
        setRefused(false)
        setStatus(null)
      } else {
        setRefused(true)
      }
    },
    [attempt],
  )

  const copy = useCallback((text: string, what: string) => {
    // The clipboard is the user's own; nothing leaves the machine.
    //
    // `navigator.clipboard` is *absent*, not merely unwilling, outside a secure context — which
    // is the ordinary case for a laptop serving over plain http at a venue, exactly where this
    // panel gets used. Reaching straight for `.writeText` there throws synchronously and takes
    // the click with it, so the absence is checked before the refusal is handled. Either way the
    // address is written out in full in the row above, so nobody is stuck.
    const refused = `This browser will not give a page the clipboard. The ${what} is spelled out above.`
    if (typeof navigator.clipboard === 'undefined') {
      setStatus(refused)
      return
    }
    navigator.clipboard.writeText(text).then(
      () => setStatus(`Copied the ${what}.`),
      () => setStatus(refused),
    )
  }, [])

  return (
    /*
      One fixed rail along the bottom, sitting above everything that already lives down there.

      The offset is deliberate arithmetic, not a guess. `AssistantButton` is `size-11` (2.75rem)
      at `bottom-[calc(safe + var(--mon-dock-h) + 0.75rem)]`, so its top edge is 3.5rem above the
      dock; 4rem clears it with room to spare. The trigger is on the left and the assistant on the
      right, so only the open panel — which is full width — would ever have reached it. On `md:`
      the dock becomes a top bar and the assistant button is hidden, so the bottom is simply free.

      `z-20` keeps the whole thing under the dock (`z-50`) and under the assistant's backdrop
      (`z-30`): opening the assistant covers this panel rather than fighting it for taps.
    */
    <div
      className={
        'pointer-events-none fixed inset-x-0 z-20 flex justify-start px-3 md:bottom-4 ' +
        'bottom-[calc(env(safe-area-inset-bottom,0px)+var(--mon-dock-h,4rem)+4rem)]'
      }
    >
      {open ? (
        <aside
          aria-label="Presenter tools"
          className="pointer-events-auto max-h-[70dvh] w-full max-w-sm overflow-y-auto overscroll-contain rounded-2xl border border-zinc-800 bg-zinc-950/95 p-3 shadow-2xl backdrop-blur-sm"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[17px] font-semibold text-zinc-100">Presenter tools</h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="min-h-11 shrink-0 rounded-xl px-3 text-[13px] font-medium text-zinc-400 hover:text-zinc-100"
            >
              Close
            </button>
          </div>

          {unlocked ? (
            <>
              <SectionHeader>Fill this screen</SectionHeader>
              <Group>
                {FILLS.map((fill, index) => (
                  <Row
                    key={fill.key}
                    label={fill.label}
                    detail={fill.detail}
                    wrap
                    last={index === FILLS.length - 1}
                    onClick={() => {
                      setStatus('Filling…')
                      // A fill yields between fields (see `settle`), so it finishes on a later
                      // task. Nothing here can reject — every branch of every fill returns a
                      // sentence — but a rejection would be a bug worth seeing rather than
                      // losing, so it lands in the status line too.
                      fill.run().then(setStatus, (reason: unknown) =>
                        setStatus(`That fill stopped: ${String(reason)}`),
                      )
                    }}
                  />
                ))}
              </Group>
              <GroupNote>
                These type into the form for you. Nothing is signed and nothing is sent — every
                write still needs your wallet.
              </GroupNote>

              <SectionHeader note="anvil">Copy an address</SectionHeader>
              <Group>
                {DEMO_ADDRESSES.map((party, index) => (
                  <Row
                    key={party.address}
                    label={party.role}
                    detail={party.address}
                    wrap
                    value={shortAddress(party.address)}
                    last={index === DEMO_ADDRESSES.length - 1 && escrow === null}
                    onClick={() => copy(party.address, `${party.role.toLowerCase()} address`)}
                  />
                ))}
                {escrow === null ? null : (
                  <Row
                    label="This escrow"
                    detail={escrow}
                    wrap
                    value={shortAddress(escrow)}
                    last
                    onClick={() => copy(escrow, 'escrow address')}
                  />
                )}
              </Group>
              <GroupNote>
                {escrow === null
                  ? 'Open a job to get its escrow address here too. These four are anvil’s own accounts — every developer already has their keys, so they guard nothing.'
                  : 'The four parties are anvil’s own accounts — every developer already has their keys, so they guard nothing.'}
              </GroupNote>

              <div className="mt-4 border-t border-zinc-800 pt-3">
                <button
                  type="button"
                  onClick={() => {
                    lock()
                    latchChanged()
                    setStatus(null)
                  }}
                  className="min-h-11 w-full rounded-xl border border-zinc-800 px-4 text-[13px] font-medium text-zinc-400 hover:text-zinc-100"
                >
                  Lock the panel
                </button>
              </div>
            </>
          ) : (
            <form onSubmit={submit} className="mt-3 flex flex-col gap-2">
              <label className="text-[13px] leading-snug text-zinc-500" htmlFor="devtools-word">
                A word to open this. It is a latch so the panel does not open by accident — not a
                password: it is in this page’s public JavaScript, and it guards nothing, because
                everything here only types into forms you can already type into.
              </label>
              <input
                id="devtools-word"
                type="password"
                className={PANEL_FIELD}
                value={attempt}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={refused ? true : undefined}
                onChange={(event) => {
                  setAttempt(event.target.value)
                  setRefused(false)
                }}
              />
              <button
                type="submit"
                className="min-h-11 w-full rounded-xl bg-accent px-4 text-[17px] font-semibold text-zinc-950 transition-colors hover:bg-accent/90"
              >
                Open
              </button>
              <p aria-live="polite" className="min-h-5 text-[13px] text-danger">
                {refused ? 'Not that word.' : ''}
              </p>
            </form>
          )}

          <p aria-live="polite" className="mt-3 text-[13px] leading-snug text-zinc-400">
            {status ?? ''}
          </p>
        </aside>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          aria-label="Presenter tools"
          className="pointer-events-auto grid size-11 place-items-center rounded-xl border border-zinc-800 bg-zinc-950/80 text-zinc-600 opacity-40 backdrop-blur-sm transition-opacity hover:opacity-100 focus-visible:opacity-100"
        >
          <svg viewBox="0 0 24 24" aria-hidden className="size-5" fill="currentColor">
            <circle cx="12" cy="5" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="12" cy="19" r="1.6" />
          </svg>
        </button>
      )}
    </div>
  )
}

export default DevTools
