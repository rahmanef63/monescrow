/**
 * `GET /api/blank` — a genuinely empty 200. The adversarial demo's ammunition.
 *
 * A route handler rather than a page, for a reason worth stating: a `page.tsx` is wrapped by
 * the root layout, so it would ship the nav, the dock and the providers. That still passes an
 * `expectStatus: 200` check, but it is no longer *blank*, and the demo's punch depends on the
 * audience seeing that there is truly nothing there. This returns an empty document and
 * nothing else.
 *
 * Point a milestone's `http` criteria here with `expectStatus: 200` and no `mustContain`, and
 * the verifier reports a pass — honestly, because the check it was asked to run did pass.
 * That is the argument: `HTTP 200` and `Lighthouse > 80` are both satisfied by an empty file,
 * so treating an automated check as a verdict is one blank page away from paying for nothing.
 * MonEscrow treats it as a proposal with a deadline, so the client can still object.
 *
 * Do not add content. The emptiness is the feature.
 */
export const dynamic = 'force-static'

export function GET() {
  return new Response('<!doctype html><html><head><title></title></head><body></body></html>', {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
    },
  })
}
