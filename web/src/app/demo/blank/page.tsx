import Link from 'next/link'

/**
 * `/demo/blank` — signpost only. The real blank response lives at `/api/blank`.
 *
 * A `page.tsx` is wrapped by the root layout, so it inherits the nav, the dock and the
 * providers. That still passes an `expectStatus: 200` check — which is itself a nice thing to
 * point out on stage — but it is not *visibly* empty, and the demo's punch depends on the
 * audience seeing that there is genuinely nothing at the URL. So the criteria point at
 * `/api/blank`, a route handler with no layout around it, and this page just says so.
 */
export default function BlankSignpost() {
  return (
    <main className="mx-auto max-w-lg px-5 py-16">
      <div className="rounded-2xl border border-amber-500/30 bg-amber-400/10 p-5">
        <p className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-amber-300">
          Demo asset
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">The blank page lives elsewhere</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          Point the milestone at <code className="text-zinc-200">/api/blank</code>. It returns an
          empty document with no layout around it, which is what makes the demonstration land.
        </p>
        <Link
          href="/api/blank"
          className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-[#836EF9] px-4 font-semibold text-black"
        >
          Open /api/blank
        </Link>
      </div>
    </main>
  )
}
