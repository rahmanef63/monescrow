import type { ReactNode } from 'react'
import type { Metadata, Viewport } from 'next'
import './globals.css'
import { Providers } from './providers'
import { Dock } from '@/components/Dock'
import { AssistantButton } from '@/components/AssistantButton'
import { ChatSheet } from '@/components/ChatSheet'
import { DevTools } from '@/components/DevTools'
import { hasFactory } from '@/lib/chain'

/**
 * Studio's progress-lock mark, inlined as a data URI.
 *
 * Deliberately not a path under `/public`: C9 says a renamed file is a broken build, and until
 * `assets/brand/favicon.png` has actually been copied into `web/src/app/icon.png` a path here
 * would be a 404 on every page load. A data URI cannot rot.
 */
const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="14" fill="#09090b"/>' +
  '<path d="M19 28V20c0-8 5-13 13-13s13 5 13 13v3" fill="none" stroke="#f4f4f5" stroke-width="6" stroke-linecap="round"/>' +
  '<rect x="8" y="25" width="48" height="31" rx="9" fill="#18181b" stroke="#f4f4f5" stroke-width="4"/>' +
  '<rect x="15" y="34" width="7" height="13" rx="2.5" fill="#836EF9"/>' +
  '<rect x="26" y="34" width="7" height="13" rx="2.5" fill="#836EF9"/>' +
  '<rect x="37" y="34" width="7" height="13" rx="2.5" fill="#836EF9"/>' +
  '<rect x="48" y="34" width="3" height="13" rx="1.5" fill="#34d399"/>' +
  '</svg>'

const MARK_DATA_URI = `data:image/svg+xml,${encodeURIComponent(MARK_SVG)}`

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

const TAGLINE =
  'Fund a freelance job once, release it milestone by milestone. A verifier proposes that a ' +
  'milestone passed and never decides — silence during the challenge window releases the ' +
  'money, an objection freezes it for an arbiter.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'MonEscrow — milestone escrow on Monad',
    template: '%s · MonEscrow',
  },
  description: TAGLINE,
  applicationName: 'MonEscrow',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [{ url: MARK_DATA_URI, type: 'image/svg+xml' }],
    apple: [{ url: MARK_DATA_URI }],
  },
  appleWebApp: {
    capable: true,
    title: 'MonEscrow',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: { telephone: false, address: false, email: false },
  openGraph: {
    type: 'website',
    siteName: 'MonEscrow',
    title: 'MonEscrow — milestone escrow on Monad',
    description: TAGLINE,
    url: SITE_URL,
    locale: 'en',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'MonEscrow' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'MonEscrow — milestone escrow on Monad',
    description: TAGLINE,
    images: ['/og.png'],
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The dock sits over the iOS home indicator; `cover` is what makes env(safe-area-inset-*)
  // report anything other than zero.
  viewportFit: 'cover',
  themeColor: '#09090b',
  colorScheme: 'dark',
}

/**
 * Typed explicitly rather than with Next 16's generated `LayoutProps<'/'>`.
 *
 * That helper is written into `.next/types/` **during** `next build`, so on a fresh clone it
 * does not exist yet and `tsc --noEmit` fails with `TS2304: Cannot find name 'LayoutProps'`
 * before anything has been built. The documented gate runs typecheck first, which made a
 * perfectly good checkout look broken on someone else's machine — the worst kind of bug,
 * because it only appears for the person you most want to impress.
 *
 * Depending on a build artifact from source is the actual mistake; reordering the commands
 * would only have hidden it. A root layout's props are `{ children: ReactNode }` and nothing
 * about that needs generating.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-dvh bg-zinc-950 font-sans text-zinc-100">
        <Providers>
          <a
            href="#main"
            className="sr-only rounded-xl bg-accent px-4 py-3 text-sm font-medium text-white focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-[60]"
          >
            Skip to content
          </a>

          <Dock />

          {/*
            The assistant, in two halves that have to be mounted together.

            `AssistantButton` fires `monescrow:open-chat`; `ChatSheet` listens for it. Each half
            is useless alone, and this has already gone wrong twice — first the listener was not
            mounted anywhere, then the dock's centre slot became a link and the phone lost the
            button while the desktop bar kept one, so nothing looked broken from a laptop. Both
            halves live here, at the root, so the assistant is reachable from *every* screen. It
            is deliberately not gated on being on a job page: with no escrow it can still draft a
            milestone split, and a door that is only sometimes there is the bug above again.

            The button below is the phone placement only (`md:hidden`); on desktop the same
            component is rendered inline by the top bar inside `Dock`.
          */}
          <AssistantButton />
          <ChatSheet />

          {/*
            The presenter's autofill panel, latched behind a word so it cannot open by accident
            mid-demo. It is not privileged and is not gated on an environment flag, because it
            has nothing to gate: it types into forms the user is already looking at and copies
            addresses that are already public. It signs nothing, calls no route and touches no
            server — `components/DevTools.tsx` says so at the top and `lib/devtools.test.ts`
            checks it. Mounted after the assistant, and at a lower `z-index`, so the assistant
            always wins a tap near the boundary.
          */}
          <DevTools />

          {/*
            Padding, not margin: the dock is fixed, so without `pb-dock` the last control on
            every page hides behind it — and on desktop the top bar is fixed instead.
          */}
          <main id="main" className="mx-auto w-full max-w-6xl px-4 pt-5 pb-dock md:pt-24 md:pb-16">
            {hasFactory() ? null : (
              <p
                role="status"
                className="mb-5 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-zinc-100"
              >
                <span className="font-medium">No escrow factory is configured yet.</span>{' '}
                <span className="text-zinc-400">
                  Set <code className="font-mono text-xs">NEXT_PUBLIC_FACTORY_ADDRESS</code> to
                  read live jobs. Until then anything you see is sample data, not the chain.
                </span>
              </p>
            )}
            {children}
          </main>
        </Providers>
      </body>
    </html>
  )
}
