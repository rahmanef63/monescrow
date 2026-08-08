'use client'

/**
 * The three steps that make this product what it is, and which had no UI at all.
 *
 *     submit evidence  ->  run the check  ->  relay the attestation  ->  the window opens
 *
 * Everything either side of this worked — create, accept, approve, release, dispute, reclaim,
 * withdraw — but `submit` and `attest` rendered as permanently disabled buttons whose text sent
 * you to the assistant, whose own card sent you back here. A closed loop.
 *
 * Two of these steps are unusual and the panel says so rather than hiding it:
 *
 *   - **The check is not a verdict.** It fetches a URL, or asks GitHub about a commit, and
 *     signs what it saw. An HTTP 200 is satisfied by a blank page. A pass does not move money;
 *     it opens a window in which the client can object.
 *   - **Anybody may relay the attestation.** The signature is the authority, not the sender, so
 *     a freelancer can carry their own passing result to the chain and pay the gas themselves.
 *     That is what stops the verifier being a gatekeeper who can stall a payout by going quiet.
 */

import { useMemo, useState } from 'react'
import { TxButton } from '@/components/TxButton'
import { escrowAbi } from '@/lib/abis'
import { acceptPastedDocument, getDocument, putDocument } from '@/lib/documents'
import type { Criteria, Evidence, Report } from '@/lib/verify/types'
import type { ChainAction } from '@/lib/chat/types'

export type WorkPanelProps = {
  escrow: `0x${string}`
  /** Which of the two handed-off actions the card asked for. */
  action: Extract<ChainAction, 'submit' | 'attest'>
  index: number
  /** The milestone's current submission counter, which the attestation must match. */
  submissions: number
  /** Null before anything is submitted, and on a milestone with no criteria recorded. */
  criteriaHash: string | null
  evidenceHash: string | null
  onClose: () => void
  onChanged?: () => void
}

type CheckOutcome =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'passed'; report: Report; reportHash: `0x${string}`; signature: `0x${string}` }
  | { kind: 'failed'; report: Report }
  /** Ours, not the freelancer's: we could not reach the target, or we are misconfigured. */
  | { kind: 'unreachable'; detail: string }
  | { kind: 'rejected'; detail: string }

const field =
  'min-h-11 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 ' +
  'placeholder:text-zinc-600 focus:border-accent focus:outline-none'

export function WorkPanel(props: WorkPanelProps) {
  const { escrow, action, index, submissions, criteriaHash, evidenceHash } = props

  const [url, setUrl] = useState('')
  const [repo, setRepo] = useState('')
  const [commit, setCommit] = useState('')
  const [note, setNote] = useState('')
  const [pasted, setPasted] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<CheckOutcome>({ kind: 'idle' })

  /**
   * The evidence object, built fresh from the form. `submittedAt` is part of what the hash
   * commits to, so it is fixed when the form is first rendered rather than read at click time —
   * otherwise the hash the user is about to sign for changes between the preview and the send.
   */
  const [submittedAt] = useState(() => Math.floor(Date.now() / 1000))
  const evidence: Evidence = useMemo(
    () => ({
      v: 1,
      milestone: index,
      ...(url.trim() ? { url: url.trim() } : {}),
      ...(repo.trim() ? { repo: repo.trim() } : {}),
      ...(commit.trim() ? { commit: commit.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      submittedAt,
    }),
    [index, url, repo, commit, note, submittedAt],
  )

  const criteriaLookup = getDocument<Criteria>(criteriaHash)
  const submittedEvidence = getDocument<Evidence>(evidenceHash)

  /* ---------------------------------------------------------------- submit */

  if (action === 'submit') {
    const empty = !url.trim() && !repo.trim() && !commit.trim() && !note.trim()

    return (
      <Frame title={`Submit work for milestone ${index + 1}`} onClose={props.onClose}>
        <p className="text-sm text-zinc-400">
          What goes on chain is a hash of this, not the text itself. Both sides can prove later
          what was handed in, and nobody has to trust our servers to keep it.
        </p>

        <div className="mt-4 grid gap-3">
          <Labelled label="Deployed URL">
            <input
              className={field}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://demo.example.com"
              inputMode="url"
            />
          </Labelled>
          <Labelled label="Repository">
            <input
              className={field}
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/name"
            />
          </Labelled>
          <Labelled label="Commit">
            <input
              className={field}
              value={commit}
              onChange={(e) => setCommit(e.target.value)}
              placeholder="abc123…"
            />
          </Labelled>
          <Labelled label="Note">
            <input
              className={field}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Deployed to Vercel, OAuth configured"
            />
          </Labelled>
        </div>

        <p className="mt-3 text-sm break-all text-zinc-500">
          Evidence hash <span className="font-mono">{hashPreview(evidence)}</span>
        </p>

        <div className="mt-4">
          <TxButton
            label={`Submit milestone ${index + 1}`}
            request={
              empty
                ? null
                : {
                    address: escrow,
                    abi: escrowAbi,
                    functionName: 'submit',
                    args: [BigInt(index), putDocumentReturningHash(evidence)],
                  }
            }
            blockedReason={empty ? 'Fill in at least one field — an empty submission proves nothing.' : null}
            hint="Bumps the submission counter, which invalidates any attestation signed against your previous attempt."
            successNote="Submitted. The verifier can now check it against the agreed criteria — that check proposes a result, it does not release the money."
            onSuccess={() => {
              props.onChanged?.()
              props.onClose()
            }}
          />
        </div>
      </Frame>
    )
  }

  /* ---------------------------------------------------------------- check + relay */

  const criteria = criteriaLookup.status === 'found' ? criteriaLookup.document : null
  const evidenceDoc = submittedEvidence.status === 'found' ? submittedEvidence.document : null

  async function runCheck() {
    if (!criteria || !evidenceDoc) return
    setOutcome({ kind: 'running' })
    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ escrow, milestone: index, submission: submissions, criteria, evidence: evidenceDoc }),
        signal: AbortSignal.timeout(60_000),
      })
      const body = await res.json().catch(() => ({}))

      if (res.status === 200) {
        setOutcome({ kind: 'passed', report: body.report, reportHash: body.reportHash, signature: body.signature })
      } else if (res.status === 422) {
        setOutcome({ kind: 'failed', report: body.report })
      } else if (res.status === 502) {
        setOutcome({ kind: 'unreachable', detail: String(body.error ?? 'the target could not be reached') })
      } else {
        setOutcome({ kind: 'rejected', detail: String(body.error ?? 'the request did not match the chain') })
      }
    } catch {
      setOutcome({ kind: 'unreachable', detail: 'the checker did not answer in time' })
    }
  }

  return (
    <Frame title={`Check milestone ${index + 1}`} onClose={props.onClose}>
      <p className="text-sm text-zinc-400">
        The checker fetches what the criteria name and signs what it saw. It never moves money:
        a pass opens the challenge window, and the client can object for as long as it runs.
      </p>

      {criteria && evidenceDoc ? null : (
        <MissingDocuments
          criteriaStatus={criteriaLookup.status}
          evidenceStatus={submittedEvidence.status}
          value={pasted}
          error={pasteError}
          onChange={(v) => {
            setPasted(v)
            setPasteError(null)
          }}
          onAccept={() => {
            // Which document is missing decides which hash the paste has to match. If the
            // chain never recorded that hash there is nothing to check a paste against, so
            // there is nothing to accept either — better to refuse than to store something
            // unverifiable under a name it may not deserve.
            const target = criteriaLookup.status === 'found' ? evidenceHash : criteriaHash
            if (!target) {
              setPasteError('This milestone has no hash recorded on chain for that document.')
              return
            }
            const r = acceptPastedDocument(target, pasted)
            if (r.status === 'found') {
              setPasted('')
              setPasteError(null)
            } else {
              setPasteError('That does not hash to what this milestone committed to on chain.')
            }
          }}
        />
      )}

      <div className="mt-4">
        <button
          type="button"
          onClick={runCheck}
          disabled={!criteria || !evidenceDoc || outcome.kind === 'running'}
          className="flex min-h-11 w-full items-center justify-center rounded-xl bg-accent px-4 text-sm font-semibold text-zinc-950 transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {outcome.kind === 'running' ? 'Checking…' : 'Run the check'}
        </button>
      </div>

      <Outcome outcome={outcome} />

      {outcome.kind === 'passed' ? (
        <div className="mt-4">
          <p className="mb-2 text-sm text-zinc-400">
            The verifier signed a pass. Anyone can carry it to the chain — the signature is the
            authority, not the sender, so you do not have to wait for anybody.
          </p>
          <TxButton
            label={`Relay the attestation for milestone ${index + 1}`}
            request={{
              address: escrow,
              abi: escrowAbi,
              functionName: 'attest',
              args: [BigInt(index), submissions, true, outcome.reportHash, outcome.signature],
            }}
            hint="Starts the challenge window. The client can still object for its whole length."
            successNote="Attested. No money has moved — the challenge window is now running, and the milestone releases only if the client stays silent through it."
            onSuccess={() => {
              props.onChanged?.()
              props.onClose()
            }}
          />
        </div>
      ) : null}
    </Frame>
  )
}

/* ------------------------------------------------------------------ pieces */

function Frame(props: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <section className="mt-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="mb-2 flex items-start justify-between gap-3">
        <h3 className="text-lg font-semibold text-zinc-100">{props.title}</h3>
        <button
          type="button"
          onClick={props.onClose}
          className="min-h-11 min-w-11 shrink-0 rounded-xl px-3 text-sm text-zinc-400 hover:text-zinc-100"
          aria-label="Close"
        >
          Close
        </button>
      </div>
      {props.children}
    </section>
  )
}

function Labelled(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-sm text-zinc-400">{props.label}</span>
      {props.children}
    </label>
  )
}

/**
 * "Nobody stored it" and "we could not read the store" are different facts and must not share a
 * sentence. The first is expected on a shared link; the second is our problem.
 */
function MissingDocuments(props: {
  criteriaStatus: string
  evidenceStatus: string
  value: string
  error: string | null
  onChange: (v: string) => void
  onAccept: () => void
}) {
  const which = props.criteriaStatus !== 'found' ? 'criteria' : 'evidence'
  const status = props.criteriaStatus !== 'found' ? props.criteriaStatus : props.evidenceStatus

  const explanation =
    status === 'mismatch'
      ? `The ${which} stored in this browser does not hash to what the milestone committed to. It was edited, or it belongs to a different attempt.`
      : status === 'unavailable'
        ? `This browser will not let us read local storage, so the ${which} cannot be loaded here.`
        : `The ${which} was written in whoever's browser created this, and there is no shared store yet. Paste the JSON and it will be checked against the hash on chain.`

  return (
    <div className="mt-4 rounded-xl border border-warning/40 bg-warning/10 p-3">
      <p className="text-sm text-zinc-100">{explanation}</p>
      <textarea
        className={`${field} mt-3 min-h-24 py-2 font-mono`}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={`Paste the ${which} JSON`}
      />
      {props.error ? <p className="mt-2 text-sm text-danger">{props.error}</p> : null}
      <button
        type="button"
        onClick={props.onAccept}
        disabled={!props.value.trim()}
        className="mt-3 min-h-11 w-full rounded-xl border border-zinc-700 px-4 text-sm font-medium text-zinc-100 disabled:opacity-40"
      >
        Check it against the hash
      </button>
    </div>
  )
}

function Outcome({ outcome }: { outcome: CheckOutcome }) {
  if (outcome.kind === 'idle' || outcome.kind === 'running') return null

  if (outcome.kind === 'unreachable') {
    return (
      <Banner tone="warning" title="We could not reach it">
        {outcome.detail}. That is our problem, not a failed milestone — nothing was signed, and
        running the check again is the right move.
      </Banner>
    )
  }

  if (outcome.kind === 'rejected') {
    return (
      <Banner tone="danger" title="The checker refused">
        {outcome.detail}
      </Banner>
    )
  }

  const { report } = outcome
  return (
    <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
      <p className="text-sm font-semibold text-zinc-100">
        {outcome.kind === 'passed' ? 'Every check passed' : 'The milestone did not pass'}
      </p>
      <ul className="mt-2 grid gap-1.5">
        {(report?.checks ?? []).map((c) => (
          <li key={c.id} className="flex gap-2 text-sm">
            <span aria-hidden>{c.passed ? '✓' : '✗'}</span>
            <span className={c.passed ? 'text-zinc-300' : 'text-danger'}>
              {c.label} — <span className="text-zinc-500">{c.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      {outcome.kind === 'passed' ? (
        <p className="mt-3 text-sm text-zinc-500">
          Worth being honest about what that proves: the page answered, and it contained what was
          agreed. A blank page can pass a status check. That is exactly why this opens a window
          instead of paying out.
        </p>
      ) : (
        <p className="mt-3 text-sm text-zinc-500">
          Nothing was signed and nothing changed on chain. Fix it and submit again — resubmitting
          invalidates this result.
        </p>
      )}
    </div>
  )
}

function Banner(props: { tone: 'warning' | 'danger'; title: string; children: React.ReactNode }) {
  const border = props.tone === 'warning' ? 'border-warning/40 bg-warning/10' : 'border-danger/40 bg-danger/10'
  return (
    <div className={`mt-4 rounded-xl border p-3 ${border}`}>
      <p className="text-sm font-semibold text-zinc-100">{props.title}</p>
      <p className="mt-1 text-sm text-zinc-300">{props.children}</p>
    </div>
  )
}

/* ------------------------------------------------------------------ helpers */

/** Preview only — never used as the value that gets sent. */
function hashPreview(evidence: Evidence): string {
  const h = putDocumentReturningHash(evidence)
  return `${h.slice(0, 10)}…${h.slice(-8)}`
}

/**
 * Storing on the way to hashing is deliberate: the hash goes on chain in the same click, and a
 * hash whose preimage was never kept is a commitment nobody can ever open.
 */
function putDocumentReturningHash(document: unknown): `0x${string}` {
  return putDocument(document)
}
