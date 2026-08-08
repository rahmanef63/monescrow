'use client'

/**
 * The milestone split, editable down to the last wei.
 *
 * Whatever produced the drafts — a model with the user's own key, or the deterministic template
 * that runs with no key at all — the numbers arriving here are **advisory**. Both parties are
 * about to sign them, so every title, every amount and every criterion is an input, not a
 * label, and the banner at the top says so in as many words.
 *
 * ## The one invariant this file exists to hold
 *
 * `sum(amounts) === total`, **exactly**, checked on every keystroke.
 *
 * `EscrowFactory.createEscrow` forwards `msg.value` to the `Escrow` constructor, which reverts
 * `FundingMismatch(sum, msg.value)` if the milestone amounts do not add to the value sent. A
 * split one wei off is therefore not a rounding annoyance — it is a transaction that reverts
 * *after* the user has signed it and paid for the gas. So:
 *
 *   - amounts are `bigint` wei from end to end; nothing here ever touches `Number` for money,
 *     because 6 MON is 6e18 and a single trip through a float silently changes the amount;
 *   - the running total, the target and the difference are all shown, in MON and in exact wei;
 *   - when they differ there is a one-press "put the difference on the last milestone", because
 *     asking somebody to hand-type 18 digits is how you get a revert.
 *
 * The parent owns the total and the create button. This component owns the list and reports its
 * sum; `sumMilestones` is exported so the two can never disagree about what the sum is.
 */

import { useId } from 'react'
import type { MilestoneDraft } from '@/lib/ai/types'
import type { Criteria, CheckKind } from '@/lib/verify/types'

/* ------------------------------------------------------------------ money, as integers */

export const WEI_PER_MON = 10n ** 18n

/** `Escrow.MAX_MILESTONES`. More than this and the constructor reverts `TooManyMilestones`. */
export const MAX_MILESTONES = 20

export type ParsedAmount = { ok: true; wei: bigint } | { ok: false; error: string }

/**
 * A typed MON amount to exact wei, by string surgery.
 *
 * Deliberately not `parseUnits`-by-way-of-float and deliberately not `Number`: the whole point
 * of the exact-sum rule above is that no amount in this form is ever approximated. `"0.1"`
 * becomes `100000000000000000n` and not something ending in `…0000001`.
 */
export function parseMon(input: string): ParsedAmount {
  const text = input.trim()
  if (text === '') return { ok: false, error: 'Enter an amount in MON.' }
  if (!/^\d*\.?\d*$/.test(text) || text === '.') {
    return { ok: false, error: 'Digits and at most one decimal point — no commas, spaces or 1e18.' }
  }

  const [whole = '', fraction = ''] = text.split('.')
  if (fraction.length > 18) {
    return { ok: false, error: 'MON has 18 decimal places, and this has more. Trim it.' }
  }

  const wei =
    BigInt(whole === '' ? '0' : whole) * WEI_PER_MON +
    BigInt(fraction === '' ? '0' : fraction.padEnd(18, '0'))

  if (wei <= 0n) {
    return { ok: false, error: 'Must be more than zero — the contract rejects a zero amount.' }
  }
  return { ok: true, wei }
}

/**
 * wei -> MON with every digit intact.
 *
 * Not `formatMon` from `@/lib/chain`: that one truncates for display, which is right on a job
 * card and wrong here, where the string is round-tripped back into an editable field and a
 * dropped digit is money that quietly stops adding up.
 */
export function weiToMon(wei: bigint): string {
  const negative = wei < 0n
  const value = negative ? -wei : wei
  const whole = value / WEI_PER_MON
  const fraction = value % WEI_PER_MON
  const text =
    fraction === 0n
      ? whole.toString()
      : `${whole}.${fraction.toString().padStart(18, '0').replace(/0+$/, '')}`
  return negative ? `-${text}` : text
}

/** "6000000000000000000 wei", grouped so a human can count the zeros on a phone. */
export function weiLabel(wei: bigint): string {
  const negative = wei < 0n
  const digits = (negative ? -wei : wei).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${negative ? '-' : ''}${digits} wei`
}

/* ------------------------------------------------------------------ the editable shape */

/**
 * One row of the editor.
 *
 * `amount` is the **text the user typed**, in MON, not a parsed number. Keeping the raw string
 * is what lets somebody type "0." on the way to "0.5" without the field fighting them, and it
 * keeps the parse — and therefore the error message — in exactly one place.
 */
export type EditableMilestone = {
  id: string
  title: string
  amount: string
  check: CheckKind
  criteria: Criteria
  /** Why the draft suggested this. Advisory, shown to both parties, never sent on-chain. */
  rationale: string
}

let sequence = 0
/** Ids for React keys. Never generated during render on the server — the list starts empty. */
function nextId(): string {
  sequence += 1
  return `ms-${sequence}`
}

const DEFAULT_HTTP: NonNullable<Criteria['http']> = {
  url: '',
  expectStatus: 200,
  mustContain: [],
  mustNotContain: [],
  timeoutMs: 10_000,
}

const DEFAULT_GITHUB: NonNullable<Criteria['github']> = {
  repo: '',
  ref: 'main',
  requireCommit: true,
  requireCheckRun: null,
  minStars: null,
}

/**
 * Keep `criteria.check` and the block beside it in step, and carry exactly one block.
 *
 * `criteriaHash` is `keccak256(canonicalJson(criteria))`, and `canonicalJson` drops `undefined`
 * members — so an http criteria set that still carried a stale `github` block would hash
 * differently from the identical one built fresh, and the verifier would refuse to check it.
 */
export function withCheck(criteria: Criteria, check: CheckKind): Criteria {
  const base: Criteria = { v: 1, title: criteria.title, check }
  if (check === 'http') return { ...base, http: criteria.http ?? { ...DEFAULT_HTTP } }
  if (check === 'github') return { ...base, github: criteria.github ?? { ...DEFAULT_GITHUB } }
  return base
}

/** A draft from `/api/ai/milestones` becomes an editable row. Amounts arrive as wei strings. */
export function draftToEditable(draft: MilestoneDraft): EditableMilestone {
  let wei = 0n
  try {
    wei = BigInt(draft.amount)
  } catch {
    wei = 0n
  }
  return {
    id: nextId(),
    title: draft.title,
    amount: wei > 0n ? weiToMon(wei) : '',
    check: draft.check,
    criteria: withCheck({ ...draft.criteria, title: draft.criteria.title || draft.title }, draft.check),
    rationale: draft.rationale,
  }
}

export function blankMilestone(index: number): EditableMilestone {
  const title = `Milestone ${index + 1}`
  return {
    id: nextId(),
    title,
    amount: '',
    check: 'clientApproval',
    criteria: { v: 1, title, check: 'clientApproval' },
    rationale: '',
  }
}

export type MilestoneSum = {
  /** The sum of every row that parses. Rows that do not parse contribute nothing. */
  wei: bigint
  /** How many rows currently have an unreadable amount. Non-zero means the sum is incomplete. */
  invalid: number
}

/** The single source of truth for "what do these rows add up to". */
export function sumMilestones(list: readonly EditableMilestone[]): MilestoneSum {
  let wei = 0n
  let invalid = 0
  for (const m of list) {
    const parsed = parseMon(m.amount)
    if (parsed.ok) wei += parsed.wei
    else invalid += 1
  }
  return { wei, invalid }
}

/**
 * Add `delta` wei to the last row that already has a readable amount.
 *
 * The one-press fix for a split that is off by a hair. Refuses to produce a non-positive
 * amount, because a zero-amount milestone reverts `ZeroMilestoneAmount` — trading one revert
 * for another would be worse than doing nothing.
 */
export function applyDifference(
  list: readonly EditableMilestone[],
  delta: bigint,
): EditableMilestone[] | null {
  if (delta === 0n || list.length === 0) return null
  for (let i = list.length - 1; i >= 0; i--) {
    const parsed = parseMon(list[i].amount)
    if (!parsed.ok) continue
    const next = parsed.wei + delta
    if (next <= 0n) return null
    return list.map((m, j) => (j === i ? { ...m, amount: weiToMon(next) } : m))
  }
  return null
}

/* ------------------------------------------------------------------ presentation */

const CHECK_LABEL: Record<CheckKind, string> = {
  clientApproval: 'Client approval — a person decides',
  http: 'HTTP — a URL answers as agreed',
  github: 'GitHub — a commit or check run exists',
}

const CHECK_NOTE: Record<CheckKind, string> = {
  clientApproval:
    'No automated check and no verifier signature. The client approves this milestone by hand, ' +
    'or the arbiter settles it.',
  http:
    'The verifier fetches this URL and reports what it saw. It proposes a pass; it never ' +
    'decides one.',
  github:
    'The verifier asks the GitHub API about this repository and reports what it found. It ' +
    'proposes a pass; it never decides one.',
}

const FIELD =
  'w-full min-h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-[0.9375rem] ' +
  'text-zinc-100 placeholder:text-zinc-600 focus:border-accent focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-60'

const LABEL = 'block text-xs font-medium tracking-wide text-zinc-400 uppercase'

const ICON_BTN =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-zinc-800 ' +
  'text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-100 ' +
  'disabled:cursor-not-allowed disabled:opacity-40'

export type MilestoneEditorProps = {
  milestones: EditableMilestone[]
  onChange: (next: EditableMilestone[]) => void
  /** The job total in wei, or null while the total field itself is unreadable. */
  totalWei: bigint | null
  /** Where the drafts came from, for the advisory banner. Null before anything is proposed. */
  source: 'llm' | 'template' | null
  disabled?: boolean
}

export function MilestoneEditor({
  milestones,
  onChange,
  totalWei,
  source,
  disabled = false,
}: MilestoneEditorProps) {
  const sum = sumMilestones(milestones)
  const difference = totalWei === null ? null : totalWei - sum.wei
  const matches = difference === 0n && sum.invalid === 0 && milestones.length > 0

  const patch = (id: string, changes: Partial<EditableMilestone>) => {
    onChange(milestones.map((m) => (m.id === id ? { ...m, ...changes } : m)))
  }

  const remove = (id: string) => onChange(milestones.filter((m) => m.id !== id))

  const move = (index: number, by: -1 | 1) => {
    const target = index + by
    if (target < 0 || target >= milestones.length) return
    const next = [...milestones]
    const [row] = next.splice(index, 1)
    next.splice(target, 0, row)
    onChange(next)
  }

  const add = () => {
    if (milestones.length >= MAX_MILESTONES) return
    onChange([...milestones, blankMilestone(milestones.length)])
  }

  const balance = () => {
    if (difference === null) return
    const next = applyDifference(milestones, difference)
    if (next) onChange(next)
  }

  return (
    <div className="flex flex-col gap-4">
      {/* --------------------------------------------------------- the advisory banner */}
      {source ? (
        <p className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-400">
          <span className="font-medium text-zinc-100">
            {source === 'llm'
              ? 'These are a language model’s suggestions.'
              : 'No API key, so these came from the built-in template split.'}
          </span>{' '}
          They are advisory and nothing has been agreed. Edit every title, every amount and every
          criterion until this is the deal you actually mean — both of you are about to be bound
          by it.
        </p>
      ) : null}

      {milestones.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-800 px-3 py-6 text-center text-sm text-zinc-400">
          No milestones yet. Propose some from the brief above, or add one by hand.
        </p>
      ) : null}

      <ol className="flex list-none flex-col gap-4">
        {milestones.map((milestone, index) => (
          <MilestoneRow
            key={milestone.id}
            milestone={milestone}
            index={index}
            count={milestones.length}
            disabled={disabled}
            onPatch={(changes) => patch(milestone.id, changes)}
            onRemove={() => remove(milestone.id)}
            onMove={(by) => move(index, by)}
          />
        ))}
      </ol>

      <button
        type="button"
        onClick={add}
        disabled={disabled || milestones.length >= MAX_MILESTONES}
        className={
          'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border ' +
          'border-dashed border-zinc-700 px-4 text-sm font-medium text-zinc-300 ' +
          'transition-colors hover:border-accent hover:text-zinc-100 ' +
          'disabled:cursor-not-allowed disabled:opacity-50'
        }
      >
        + Add a milestone
        {milestones.length >= MAX_MILESTONES ? ` (${MAX_MILESTONES} is the contract’s limit)` : ''}
      </button>

      {/* --------------------------------------------------------- the running total */}
      <div
        className={`rounded-xl border px-3 py-3 ${
          matches ? 'border-success/40 bg-success/5' : 'border-warning/40 bg-warning/5'
        }`}
      >
        <dl className="flex flex-col gap-2 text-sm">
          <Line label="Milestones add up to" value={`${weiToMon(sum.wei)} MON`} exact={weiLabel(sum.wei)} />
          <Line
            label="Job total"
            value={totalWei === null ? '—' : `${weiToMon(totalWei)} MON`}
            exact={totalWei === null ? 'Enter a total above' : weiLabel(totalWei)}
          />
          {difference !== null && difference !== 0n ? (
            <Line
              label={difference > 0n ? 'Still unallocated' : 'Over the total by'}
              value={`${weiToMon(difference > 0n ? difference : -difference)} MON`}
              exact={weiLabel(difference > 0n ? difference : -difference)}
              tone="warning"
            />
          ) : null}
        </dl>

        <p aria-live="polite" className="mt-3 text-sm">
          {matches ? (
            <span className="text-success">
              Exact match. The create transaction will not revert on the amounts.
            </span>
          ) : sum.invalid > 0 ? (
            <span className="text-warning">
              {sum.invalid} milestone{sum.invalid === 1 ? ' has' : 's have'} an amount MonEscrow
              cannot read, so this does not add up yet.
            </span>
          ) : totalWei === null ? (
            <span className="text-warning">Set the job total above to check the split.</span>
          ) : (
            <span className="text-warning">
              The split has to match the total to the wei.{' '}
              <code className="font-mono">createEscrow</code> forwards what you send to the escrow
              constructor, which reverts <code className="font-mono">FundingMismatch</code> on any
              difference — after you have signed and paid the gas.
            </span>
          )}
        </p>

        {!matches && difference !== null && difference !== 0n && milestones.length > 0 ? (
          <button
            type="button"
            onClick={balance}
            disabled={disabled}
            className={
              'mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-xl ' +
              'border border-zinc-700 bg-zinc-900 px-4 text-sm font-medium text-zinc-100 ' +
              'transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-50'
            }
          >
            {difference > 0n ? 'Add' : 'Take'} {weiToMon(difference > 0n ? difference : -difference)}{' '}
            MON {difference > 0n ? 'to' : 'from'} the last milestone
          </button>
        ) : null}
      </div>
    </div>
  )
}

function Line({
  label,
  value,
  exact,
  tone,
}: {
  label: string
  value: string
  exact: string
  tone?: 'warning'
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <dt className="text-zinc-400">{label}</dt>
      <dd className="text-right">
        <span
          className={`font-semibold tabular-nums ${tone === 'warning' ? 'text-warning' : 'text-zinc-100'}`}
        >
          {value}
        </span>
        <span className="block font-mono text-[0.6875rem] break-all text-zinc-500">{exact}</span>
      </dd>
    </div>
  )
}

/* ------------------------------------------------------------------ one milestone */

type RowProps = {
  milestone: EditableMilestone
  index: number
  count: number
  disabled: boolean
  onPatch: (changes: Partial<EditableMilestone>) => void
  onRemove: () => void
  onMove: (by: -1 | 1) => void
}

function MilestoneRow({ milestone, index, count, disabled, onPatch, onRemove, onMove }: RowProps) {
  const uid = useId()
  const amount = parseMon(milestone.amount)

  const setCriteria = (changes: Partial<Criteria>) =>
    onPatch({ criteria: { ...milestone.criteria, ...changes } })

  return (
    <li className="rounded-2xl border border-zinc-800 bg-zinc-900 p-3">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent/15 text-sm font-semibold text-accent-soft">
          {index + 1}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-400">
          Milestone {index + 1} of {count}
        </span>
        <button
          type="button"
          className={ICON_BTN}
          onClick={() => onMove(-1)}
          disabled={disabled || index === 0}
          aria-label={`Move milestone ${index + 1} earlier`}
        >
          <span aria-hidden="true">↑</span>
        </button>
        <button
          type="button"
          className={ICON_BTN}
          onClick={() => onMove(1)}
          disabled={disabled || index === count - 1}
          aria-label={`Move milestone ${index + 1} later`}
        >
          <span aria-hidden="true">↓</span>
        </button>
        <button
          type="button"
          className={`${ICON_BTN} hover:border-danger/60 hover:text-danger`}
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove milestone ${index + 1}`}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <label className={LABEL} htmlFor={`${uid}-title`}>
            Title
          </label>
          <input
            id={`${uid}-title`}
            className={`${FIELD} mt-1`}
            value={milestone.title}
            disabled={disabled}
            placeholder="What this milestone delivers"
            onChange={(e) => onPatch({ title: e.target.value })}
          />
        </div>

        <div>
          <label className={LABEL} htmlFor={`${uid}-amount`}>
            Amount (MON)
          </label>
          <input
            id={`${uid}-amount`}
            className={`${FIELD} mt-1 tabular-nums`}
            value={milestone.amount}
            disabled={disabled}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.0"
            aria-invalid={amount.ok ? undefined : true}
            aria-describedby={`${uid}-amount-note`}
            onChange={(e) => onPatch({ amount: e.target.value })}
          />
          <p id={`${uid}-amount-note`} className="mt-1 font-mono text-[0.6875rem] break-all">
            {amount.ok ? (
              <span className="text-zinc-500">{weiLabel(amount.wei)}</span>
            ) : (
              <span className="text-danger">{amount.error}</span>
            )}
          </p>
        </div>

        <div>
          <label className={LABEL} htmlFor={`${uid}-check`}>
            How it is checked
          </label>
          <select
            id={`${uid}-check`}
            className={`${FIELD} mt-1`}
            value={milestone.check}
            disabled={disabled}
            onChange={(e) => {
              const check = e.target.value as CheckKind
              onPatch({ check, criteria: withCheck(milestone.criteria, check) })
            }}
          >
            {(Object.keys(CHECK_LABEL) as CheckKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {CHECK_LABEL[kind]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-sm leading-relaxed text-zinc-500">{CHECK_NOTE[milestone.check]}</p>
        </div>

        <div>
          <label className={LABEL} htmlFor={`${uid}-criteria`}>
            Acceptance criterion
          </label>
          <input
            id={`${uid}-criteria`}
            className={`${FIELD} mt-1`}
            value={milestone.criteria.title}
            disabled={disabled}
            placeholder="What has to be true for this to pass"
            onChange={(e) => setCriteria({ title: e.target.value })}
          />
          <p className="mt-1 text-xs text-zinc-500">
            Only the keccak256 of this whole criteria object goes on-chain. Both sides keep the
            text; neither can change it afterwards without the hash disagreeing.
          </p>
        </div>

        {milestone.check === 'http' ? (
          <HttpCriteria
            uid={uid}
            disabled={disabled}
            value={milestone.criteria.http ?? DEFAULT_HTTP}
            onChange={(http) => setCriteria({ http })}
          />
        ) : null}

        {milestone.check === 'github' ? (
          <GithubCriteria
            uid={uid}
            disabled={disabled}
            value={milestone.criteria.github ?? DEFAULT_GITHUB}
            onChange={(github) => setCriteria({ github })}
          />
        ) : null}

        {milestone.rationale ? (
          <p className="rounded-xl bg-zinc-950 px-3 py-2 text-xs leading-relaxed text-zinc-500">
            <span className="font-medium text-zinc-400">Why this was suggested: </span>
            {milestone.rationale}
          </p>
        ) : null}
      </div>
    </li>
  )
}

/* ------------------------------------------------------------------ check-specific blocks */

type HttpBlock = NonNullable<Criteria['http']>
type GithubBlock = NonNullable<Criteria['github']>

/** Newline-separated text <-> string[]. Blank lines are dropped so the hash stays stable. */
function toLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function HttpCriteria({
  uid,
  value,
  disabled,
  onChange,
}: {
  uid: string
  value: HttpBlock
  disabled: boolean
  onChange: (next: HttpBlock) => void
}) {
  return (
    <fieldset className="rounded-xl border border-zinc-800 p-3">
      <legend className="px-1 text-xs font-medium tracking-wide text-zinc-400 uppercase">
        HTTP check
      </legend>
      <div className="flex flex-col gap-3">
        <div>
          <label className={LABEL} htmlFor={`${uid}-url`}>
            URL
          </label>
          <input
            id={`${uid}-url`}
            className={`${FIELD} mt-1`}
            type="url"
            inputMode="url"
            placeholder="https://example.com/health"
            value={value.url}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, url: e.target.value })}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL} htmlFor={`${uid}-status`}>
              Expect status
            </label>
            <input
              id={`${uid}-status`}
              className={`${FIELD} mt-1 tabular-nums`}
              type="number"
              inputMode="numeric"
              min={100}
              max={599}
              value={value.expectStatus}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...value, expectStatus: Number.parseInt(e.target.value, 10) || 0 })
              }
            />
          </div>
          <div>
            <label className={LABEL} htmlFor={`${uid}-timeout`}>
              Timeout (ms)
            </label>
            <input
              id={`${uid}-timeout`}
              className={`${FIELD} mt-1 tabular-nums`}
              type="number"
              inputMode="numeric"
              min={1000}
              max={60000}
              step={1000}
              value={value.timeoutMs}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...value, timeoutMs: Number.parseInt(e.target.value, 10) || 0 })
              }
            />
          </div>
        </div>

        <div>
          <label className={LABEL} htmlFor={`${uid}-contain`}>
            Body must contain (one per line)
          </label>
          <textarea
            id={`${uid}-contain`}
            className={`${FIELD} mt-1 min-h-[5.5rem] resize-y`}
            value={value.mustContain.join('\n')}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, mustContain: toLines(e.target.value) })}
          />
        </div>

        <div>
          <label className={LABEL} htmlFor={`${uid}-notcontain`}>
            Body must not contain (one per line)
          </label>
          <textarea
            id={`${uid}-notcontain`}
            className={`${FIELD} mt-1 min-h-[4rem] resize-y`}
            value={value.mustNotContain.join('\n')}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, mustNotContain: toLines(e.target.value) })}
          />
        </div>
      </div>
    </fieldset>
  )
}

function GithubCriteria({
  uid,
  value,
  disabled,
  onChange,
}: {
  uid: string
  value: GithubBlock
  disabled: boolean
  onChange: (next: GithubBlock) => void
}) {
  return (
    <fieldset className="rounded-xl border border-zinc-800 p-3">
      <legend className="px-1 text-xs font-medium tracking-wide text-zinc-400 uppercase">
        GitHub check
      </legend>
      <div className="flex flex-col gap-3">
        <div>
          <label className={LABEL} htmlFor={`${uid}-repo`}>
            Repository
          </label>
          <input
            id={`${uid}-repo`}
            className={`${FIELD} mt-1`}
            placeholder="owner/name"
            value={value.repo}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, repo: e.target.value })}
          />
        </div>

        <div>
          <label className={LABEL} htmlFor={`${uid}-ref`}>
            Branch or ref
          </label>
          <input
            id={`${uid}-ref`}
            className={`${FIELD} mt-1`}
            placeholder="main"
            value={value.ref}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, ref: e.target.value })}
          />
        </div>

        <div>
          <label className={LABEL} htmlFor={`${uid}-checkrun`}>
            Required check run (blank for none)
          </label>
          <input
            id={`${uid}-checkrun`}
            className={`${FIELD} mt-1`}
            placeholder="build"
            value={value.requireCheckRun ?? ''}
            disabled={disabled}
            onChange={(e) =>
              onChange({ ...value, requireCheckRun: e.target.value.trim() === '' ? null : e.target.value })
            }
          />
        </div>

        <label className="flex min-h-11 items-center gap-3 text-sm text-zinc-100">
          <input
            type="checkbox"
            className="size-5 accent-[#836EF9]"
            checked={value.requireCommit}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, requireCommit: e.target.checked })}
          />
          The submitted commit must exist on that ref
        </label>
      </div>
    </fieldset>
  )
}

export default MilestoneEditor
