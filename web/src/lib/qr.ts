/**
 * QR codes are **pre-generated SVGs**, not encoded at runtime. See `web/public/qr/`.
 *
 * ## Why there is no encoder here
 *
 * There was one. A hand-rolled byte-mode encoder, ~200 lines, no dependencies — attractive
 * because it put nothing on the network during a live talk and touched no `package.json`.
 *
 * It was wrong. Verified against the `qrcode` package on the exact URLs used: 13 modules off
 * on two of them, 302 off on a third. Right version, right size, right-looking square, and it
 * would have scanned as nothing — or worse, as something else. The comment in that file
 * literally warned about this failure mode and it happened anyway, which is the argument for
 * checking rather than reasoning about correctness.
 *
 * ## What replaced it
 *
 * The four URLs the demo needs are fixed and known at build time, so there is no reason to
 * encode anything at runtime. They were generated once with the reference encoder and
 * committed as static SVGs:
 *
 *   /qr/app.svg     https://monescrow.vercel.app/
 *   /qr/demo.svg    https://monescrow.vercel.app/demo
 *   /qr/blank.svg   https://monescrow.vercel.app/api/blank
 *   /qr/repo.svg    https://github.com/rahmanef63/monescrow
 *
 * All version 3, 29×29, level M, with a 4-module quiet zone. Zero runtime dependencies, zero
 * network calls, and correct — which the clever version was not.
 *
 * To regenerate after a URL changes:
 *
 *   npx qrcode -o web/public/qr/<name>.svg -t svg -e M "<url>"
 */

/** The QR assets the demo console renders, and what each one points at. */
export const QR_TARGETS = {
  app: { src: '/qr/app.svg', url: 'https://monescrow.vercel.app/', label: 'The app' },
  demo: { src: '/qr/demo.svg', url: 'https://monescrow.vercel.app/demo', label: 'This console' },
  blank: {
    src: '/qr/blank.svg',
    url: 'https://monescrow.vercel.app/api/blank',
    label: 'The blank page',
  },
  repo: { src: '/qr/repo.svg', url: 'https://github.com/rahmanef63/monescrow', label: 'The code' },
} as const

export type QrTargetKey = keyof typeof QR_TARGETS
