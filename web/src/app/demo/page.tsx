'use client'

/**
 * `/demo` — the presenter's control room.
 *
 * Not a marketing page. This is the thing you keep open on a second screen while you talk:
 * the running order, what to say at each beat, and a copy button beside every value you will
 * need to paste. Presentations fail on small things — a URL you cannot find, an address you
 * mistype, a wallet you forgot to switch. Everything that could go wrong that way is one
 * click here.
 *
 * Design follows C11 (`docs/05-DESIGN.md`): one primary action per step, state carried by a
 * coloured block rather than a sentence, numbers big and labels small.
 *
 * New route, no existing file touched — `web/src/**` is Taskforce's under C10.
 */

import { useEffect, useState } from 'react'
import { QR_TARGETS, type QrTargetKey } from '@/lib/qr'

// ── copy-paste kit ───────────────────────────────────────────────────────────

const VERIFIER = '0x87B9AfEafA109e96c41504E0ce84e08c055D5eaf'

const BRIEF = `Rebuild our marketing site. Three milestones: a deployed staging URL that
loads, the source pushed to GitHub with CI green, and a final sign-off from us.
Budget 4.5 MON, four weeks.`

const CRITERIA_HTTP = JSON.stringify(
  {
    v: 1,
    title: 'Deployed and reachable',
    check: 'http',
    http: {
      url: 'https://monescrow.vercel.app/api/blank',
      expectStatus: 200,
      mustContain: [],
      mustNotContain: [],
      timeoutMs: 15000,
    },
  },
  null,
  2,
)

const EVIDENCE = JSON.stringify(
  {
    v: 1,
    milestone: 0,
    url: 'https://monescrow.vercel.app/api/blank',
    repo: '',
    commit: '',
    note: 'Staging is up.',
    submittedAt: 1800000000,
  },
  null,
  2,
)

type Step = {
  n: number
  title: string
  say: string
  state: 'neutral' | 'accent' | 'warning' | 'success' | 'danger'
  badge: string
  copies?: { label: string; value: string; multiline?: boolean }[]
}

const SCENARIOS: { id: string; name: string; point: string; steps: Step[] }[] = [
  {
    id: 'happy',
    name: 'Happy path',
    point: 'Silence pays the freelancer. Nobody had to chase anybody.',
    steps: [
      {
        n: 1,
        title: 'Client funds the whole job',
        say: 'The client escrows everything up front. The freelancer can see the money is real before writing a line.',
        state: 'neutral',
        badge: 'PENDING',
        copies: [{ label: 'Brief for /new', value: BRIEF, multiline: true }],
      },
      {
        n: 2,
        title: 'Freelancer accepts, then submits',
        say: 'Nothing could be submitted before acceptance — the money is never at work under terms one side has not seen.',
        state: 'accent',
        badge: 'SUBMITTED',
        copies: [{ label: 'Evidence JSON', value: EVIDENCE, multiline: true }],
      },
      {
        n: 3,
        title: 'Verifier signs a pass',
        say: 'Watch carefully: no money moved. The pass opened a challenge window. The verifier proposes — it never decides.',
        state: 'warning',
        badge: 'ATTESTED',
        copies: [{ label: 'Verifier address', value: VERIFIER }],
      },
      {
        n: 4,
        title: 'Window elapses — anyone releases',
        say: 'The client did nothing. Release is callable by anyone — try it from a third wallet. Silence is a decision, and it favours the person who did the work.',
        state: 'success',
        badge: 'RELEASED',
      },
      {
        n: 5,
        title: 'Freelancer withdraws',
        say: 'Released credited a balance. Money is never pushed in this contract — the freelancer pulls. One reentrancy surface instead of six.',
        state: 'success',
        badge: 'PAID',
      },
    ],
  },
  {
    id: 'adversarial',
    name: 'The blank page',
    point: 'The check was wrong and the client still kept their money. This is the whole argument.',
    steps: [
      {
        n: 1,
        title: 'Point a milestone at an empty page',
        say: 'Criteria: HTTP 200, nothing required in the body. This is what every automated check on earth actually looks like.',
        state: 'neutral',
        badge: 'SETUP',
        copies: [
          { label: 'Blank page URL', value: 'https://monescrow.vercel.app/api/blank' },
          { label: 'Criteria JSON', value: CRITERIA_HTTP, multiline: true },
        ],
      },
      {
        n: 2,
        title: 'It passes. Honestly.',
        say: 'Green tick, valid signature from the real verifier key. Not a bug — HTTP 200 and Lighthouse over 80 are both satisfied by an empty file.',
        state: 'warning',
        badge: 'ATTESTED',
      },
      {
        n: 3,
        title: 'Client objects inside the window',
        say: 'Frozen. Release now reverts for everyone, including the freelancer, until an arbiter rules.',
        state: 'danger',
        badge: 'DISPUTED',
      },
      {
        n: 4,
        title: 'Land it',
        say: 'The automated check said pass. The client said no. The client won. The design survives a weak check because it never depended on the check being strong.',
        state: 'success',
        badge: 'THE POINT',
      },
    ],
  },
  {
    id: 'dispute',
    name: 'Arbiter resolves',
    point: 'A frozen milestone has exactly one exit, and it is not the verifier.',
    steps: [
      {
        n: 1,
        title: 'Switch to the arbiter wallet',
        say: 'Named at creation, immutable. Neither party can appoint themselves later.',
        state: 'danger',
        badge: 'DISPUTED',
      },
      {
        n: 2,
        title: 'Resolve — either way',
        say: 'Show both. For the freelancer it releases; for the client it refunds. The arbiter cannot invent a third outcome or take a cut.',
        state: 'success',
        badge: 'RESOLVED',
      },
    ],
  },
]

// ── UI ───────────────────────────────────────────────────────────────────────

const STATE_BG: Record<Step['state'], string> = {
  neutral: 'bg-zinc-800 text-zinc-300',
  accent: 'bg-[#836EF9]/15 text-[#a996ff]',
  warning: 'bg-amber-400/15 text-amber-300',
  success: 'bg-emerald-400/15 text-emerald-300',
  danger: 'bg-red-400/15 text-red-300',
}

function Copy({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value)
        setDone(true)
        setTimeout(() => setDone(false), 1400)
      }}
      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-black/40 px-4 py-3 text-left transition hover:border-[#836EF9]"
    >
      <span className="min-w-0">
        <span className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          {label}
        </span>
        <span className="block truncate font-mono text-sm text-zinc-300">
          {multiline ? value.split('\n')[0] + ' …' : value}
        </span>
      </span>
      <span className={`shrink-0 text-xs font-semibold ${done ? 'text-emerald-400' : 'text-zinc-500'}`}>
        {done ? 'copied' : 'copy'}
      </span>
    </button>
  )
}

export default function DemoConsole() {
  const [active, setActive] = useState(SCENARIOS[0].id)
  const [health, setHealth] = useState<Record<string, string>>({})
  /** Which QR is blown up for the room. `null` shows the four-up grid. */
  const [bigQr, setBigQr] = useState<QrTargetKey | null>(null)

  useEffect(() => {
    const probe = async () => {
      const out: Record<string, string> = {}
      try {
        const v = await fetch('/api/version').then((r) => r.json())
        out.build = String(v.buildId ?? 'unknown').slice(0, 14)
      } catch {
        out.build = 'unreachable'
      }
      try {
        const r = await fetch('/api/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        // 400 means the key loaded and it is rejecting our empty body — healthy.
        // 502 means the key or RPC is missing — that is our configuration, not the caller's.
        out.verifier = r.status === 502 ? 'not configured' : 'ready'
      } catch {
        out.verifier = 'unreachable'
      }
      try {
        const r = await fetch('/api/blank')
        out.blank = r.ok ? 'serving 200' : `HTTP ${r.status}`
      } catch {
        out.blank = 'unreachable'
      }
      setHealth(out)
    }
    probe()
  }, [])

  const scenario = SCENARIOS.find((s) => s.id === active)!

  return (
    <main className="mx-auto max-w-3xl px-5 pb-24 pt-8">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
        Presenter console
      </p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight">Demo script</h1>

      {/* Scan targets. Put this on the projector when you want the room to follow along —
          it is the one screen where an audience can act, so it stays above the fold. */}
      <section className="mt-6">
        <button
          type="button"
          onClick={() => setBigQr(bigQr ? null : 'app')}
          className="min-h-11 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 hover:text-zinc-300"
        >
          {bigQr ? '← back to the script' : 'Scan to follow along ↓'}
        </button>

        {bigQr ? (
          <div className="mt-3 flex flex-col items-center rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={QR_TARGETS[bigQr].src}
              alt={`QR code for ${QR_TARGETS[bigQr].url}`}
              className="h-64 w-64 rounded-xl bg-white p-3"
            />
            <p className="mt-4 text-2xl font-bold">{QR_TARGETS[bigQr].label}</p>
            <p className="mt-1 break-all font-mono text-sm text-zinc-400">
              {QR_TARGETS[bigQr].url}
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {(Object.keys(QR_TARGETS) as QrTargetKey[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setBigQr(k)}
                  className={`min-h-11 rounded-full px-4 text-sm font-semibold transition ${
                    k === bigQr
                      ? 'bg-[#836EF9] text-black'
                      : 'border border-zinc-800 bg-zinc-900 text-zinc-300'
                  }`}
                >
                  {QR_TARGETS[k].label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(Object.keys(QR_TARGETS) as QrTargetKey[]).map((k) => (
              <button
                key={k}
                onClick={() => setBigQr(k)}
                className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-3 transition hover:border-[#836EF9]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={QR_TARGETS[k].src}
                  alt={`QR code for ${QR_TARGETS[k].url}`}
                  className="w-full rounded-lg bg-white p-1.5"
                />
                <span className="mt-2 block text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                  {QR_TARGETS[k].label}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* preflight — the numbers row, per C11 */}
      <section className="mt-6 grid grid-cols-3 gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
        {[
          ['Build', health.build ?? '…'],
          ['Verifier', health.verifier ?? '…'],
          ['Blank page', health.blank ?? '…'],
        ].map(([label, value]) => (
          <div key={label}>
            <div className="truncate font-mono text-base font-semibold text-zinc-100">{value}</div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              {label}
            </div>
          </div>
        ))}
      </section>

      {/* scenario picker */}
      <nav className="mt-6 flex gap-2 overflow-x-auto pb-1">
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            onClick={() => setActive(s.id)}
            className={`min-h-11 shrink-0 rounded-full px-4 text-sm font-semibold transition ${
              s.id === active
                ? 'bg-[#836EF9] text-black'
                : 'border border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700'
            }`}
          >
            {s.name}
          </button>
        ))}
      </nav>

      <p className="mt-5 text-lg leading-snug text-zinc-200">{scenario.point}</p>

      <ol className="mt-6 space-y-3">
        {scenario.steps.map((step) => (
          <li key={step.n} className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className={`mb-3 rounded-xl px-3 py-2 ${STATE_BG[step.state]}`}>
              <span className="font-mono text-[11px] font-bold uppercase tracking-[0.12em]">
                {step.badge}
              </span>
            </div>
            <div className="flex gap-3">
              <span className="mt-0.5 font-mono text-2xl font-bold leading-none text-zinc-600">
                {step.n}
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-zinc-100">{step.title}</h2>
                <p className="mt-1 text-sm leading-relaxed text-zinc-400">{step.say}</p>
                {step.copies?.length ? (
                  <div className="mt-3 space-y-2">
                    {step.copies.map((c) => (
                      <Copy key={c.label} {...c} />
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ol>

      <section className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
        <h2 className="text-base font-semibold">If something breaks on stage</h2>
        <dl className="mt-3 space-y-2 text-sm text-zinc-400">
          <div>
            <dt className="inline font-semibold text-zinc-300">Verifier says 502 — </dt>
            <dd className="inline">
              that is our configuration, not the freelancer. Say so; it is the honest failure
              mode and it is in the design.
            </dd>
          </div>
          <div>
            <dt className="inline font-semibold text-zinc-300">Wallet asks for a huge limit — </dt>
            <dd className="inline">
              on Monad you pay the limit, not the gas used. The app sets it explicitly; never
              let the wallet pick.
            </dd>
          </div>
          <div>
            <dt className="inline font-semibold text-zinc-300">Chain is slow — </dt>
            <dd className="inline">
              talk over it. The challenge window is a real timer, and waiting for it is the
              product working, not the demo stalling.
            </dd>
          </div>
        </dl>
      </section>
    </main>
  )
}
