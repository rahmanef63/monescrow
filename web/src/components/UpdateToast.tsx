'use client'

import { useCallback, useEffect, useState } from 'react'
import { applyUpdate, useAppVersion } from '@/lib/useAppVersion'

/**
 * "A new version is available."
 *
 * Two rules shape everything below.
 *
 * **It never reloads by itself.** Somebody is three paragraphs into a brief, or halfway through
 * reading a gas estimate before signing. Throwing the page away under them to save them a click
 * is not a courtesy. The toast asks; the user decides; the app waits as long as it takes.
 *
 * **Dismiss means dismissed.** The dismissal is stored against the specific build id, so
 * "Later" silences this build permanently and the *next* deploy still gets to speak. A toast
 * that reappears every minute trains people to close it without reading, which is how the one
 * that actually matters gets closed too.
 *
 * It also registers the service worker, because it is the one component in this slice mounted
 * on every page and it owns the code that tears that worker down again (`applyUpdate`). Keeping
 * both ends of the worker's life in one file is worth more than the tidier separation.
 */

const DISMISSED_KEY = 'monescrow.update-dismissed-build'

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null // Private mode, blocked storage. Worst case the toast is shown again.
  }
}

function rememberDismissed(buildId: string): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, buildId)
  } catch {
    // Nothing to do. Losing the dismissal is a mild annoyance, not a failure worth surfacing.
  }
}

export function UpdateToast() {
  const { latestBuildId, updateAvailable } = useAppVersion()
  const [dismissedBuildId, setDismissedBuildId] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)

  // Read after mount, never during render: `localStorage` does not exist on the server and a
  // value read during render would make the first client paint disagree with the HTML.
  useEffect(() => {
    setDismissedBuildId(readDismissed())
  }, [])

  useEffect(() => {
    // Development only ever hurts here: `/_next/static/*` is not immutable under `next dev`,
    // so a cache-first worker fights HMR and serves chunks that no longer exist.
    if (process.env.NODE_ENV !== 'production') return
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

    const register = () => {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // An unregistrable worker costs us installability and nothing else. The app works.
      })
    }

    // Registering during load contends with the requests that paint the first screen.
    if (document.readyState === 'complete') {
      register()
      return
    }
    window.addEventListener('load', register, { once: true })
    return () => window.removeEventListener('load', register)
  }, [])

  const onReload = useCallback(() => {
    setReloading(true)
    void applyUpdate()
  }, [])

  const onDismiss = useCallback(() => {
    if (!latestBuildId) return
    rememberDismissed(latestBuildId)
    setDismissedBuildId(latestBuildId)
  }, [latestBuildId])

  const show = updateAvailable && latestBuildId !== null && dismissedBuildId !== latestBuildId

  return (
    // The live region stays mounted whether or not there is anything in it, so screen readers
    // announce the toast when it arrives rather than missing a region that appeared with it.
    //
    // Bottom of the screen, clear of the five-slot dock and of the home indicator under it.
    // The dock's height comes from `--dock-height` if whoever owns the dock sets it, and falls
    // back to 5rem otherwise, so this never has to be re-guessed when the dock changes. Above
    // `sm` the dock becomes a top/side nav and only the safe area is left to clear.
    //
    // `pointer-events-none` on the wrapper means the invisible strip never eats a tap meant for
    // the dock; only the card itself is interactive.
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-3 pb-[calc(env(safe-area-inset-bottom,0px)+var(--dock-height,5rem)+0.75rem)] sm:pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]"
    >
      {show ? (
        <div className="pointer-events-auto w-full max-w-sm rounded-xl border border-[#27272a] bg-[#18181b] p-3 shadow-lg shadow-black/50">
          <p className="text-sm font-semibold text-[#f4f4f5]">A new version is available</p>
          <p className="mt-1 text-sm leading-relaxed text-[#a1a1aa]">
            Reloading clears the cached app files and starts the new build. Nothing on this page
            is saved for you, so finish what you are typing first.
          </p>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={onReload}
              disabled={reloading}
              className="min-h-11 flex-1 rounded-lg bg-[#836EF9] px-4 text-sm font-semibold text-[#09090b] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#836EF9] focus-visible:ring-offset-2 focus-visible:ring-offset-[#09090b] disabled:cursor-wait disabled:opacity-70"
            >
              {reloading ? 'Reloading…' : 'Reload'}
            </button>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss this update notice until the next version"
              className="min-h-11 min-w-11 rounded-lg border border-[#27272a] px-4 text-sm font-medium text-[#a1a1aa] transition-colors hover:text-[#f4f4f5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#836EF9] focus-visible:ring-offset-2 focus-visible:ring-offset-[#09090b]"
            >
              Later
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default UpdateToast
