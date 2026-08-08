'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Knowing that the build in this tab is no longer the build on the server.
 *
 * A wallet app is one people leave open. A phone goes in a pocket with a job page on screen and
 * comes out an hour later still running JavaScript from before lunch — which matters more here
 * than in most apps, because the code that decides which actions are offered, and which are
 * disabled with a reason, ships in that bundle. An old bundle offering an action the chain will
 * now reject is exactly the failure the C1 table exists to prevent.
 *
 * So: record the id at load, ask the server for it every minute, and ask again the moment the
 * tab comes back to the foreground. Then *tell* the user and stop. Nothing here reloads
 * anything — see `applyUpdate`, which only ever runs from a click.
 */

export const VERSION_ENDPOINT = '/api/version'

/** A minute. The window between shipping and noticing is not a metric anybody is grading. */
export const POLL_INTERVAL_MS = 60_000

export interface AppVersion {
  /** The build this tab is running. Null until the first poll answers. */
  buildId: string | null
  /** The build the server most recently reported. Null until the first poll answers. */
  latestBuildId: string | null
  /** True once the two differ. Latches — it never flips back on its own. */
  updateAvailable: boolean
}

/**
 * Inlined by Next at build time when `NEXT_PUBLIC_BUILD_ID` is set, which makes it the id of the
 * bundle actually executing in this tab. That is a better baseline than the first poll's answer:
 * the first poll happens milliseconds after load, but a deploy landing inside those milliseconds
 * would otherwise be adopted as the baseline and never reported.
 *
 * Unset (the default), this is `undefined` and the first poll establishes the baseline instead.
 */
const COMPILED_BUILD_ID: string | null = process.env.NEXT_PUBLIC_BUILD_ID || null

function readBuildId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const value = (body as { buildId?: unknown }).buildId
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function useAppVersion(pollIntervalMs: number = POLL_INTERVAL_MS): AppVersion {
  const [state, setState] = useState<AppVersion>({
    buildId: COMPILED_BUILD_ID,
    latestBuildId: null,
    updateAvailable: false,
  })

  /** The id we are comparing against. Written exactly once. */
  const baselineRef = useRef<string | null>(COMPILED_BUILD_ID)

  /** Once an update is found there is nothing left to learn, so stop asking. */
  const settledRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const inFlight = new Set<AbortController>()

    async function poll(): Promise<void> {
      if (cancelled || settledRef.current) return
      // A hidden tab is a tab nobody can read a toast in, and on a phone it is a tab whose
      // radio we should leave alone. The visibilitychange listener below covers the return.
      if (document.visibilityState === 'hidden') return

      const controller = new AbortController()
      inFlight.add(controller)
      try {
        const res = await fetch(VERSION_ENDPOINT, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
          headers: { accept: 'application/json' },
        })
        if (!res.ok) return

        const latest = readBuildId(await res.json())
        if (!latest || cancelled) return

        if (baselineRef.current === null) {
          baselineRef.current = latest
        }
        const baseline = baselineRef.current
        const changed = latest !== baseline
        if (changed) settledRef.current = true

        setState((prev) =>
          prev.buildId === baseline &&
          prev.latestBuildId === latest &&
          prev.updateAvailable === changed
            ? prev // Same answer as last minute: no state change, no re-render.
            : { buildId: baseline, latestBuildId: latest, updateAvailable: changed },
        )
      } catch {
        // Offline, aborted, or the endpoint returned something that is not our JSON. All three
        // are silent on purpose: a failed version check is not news the user can act on, and a
        // toast that says "could not check for updates" is pure noise on a flaky train.
      } finally {
        inFlight.delete(controller)
      }
    }

    void poll()

    const timer = window.setInterval(() => void poll(), pollIntervalMs)

    // The pocket case. `setInterval` in a backgrounded tab is throttled to minutes or frozen
    // outright, so without this the user stares at a stale page for a while after unlocking.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void poll()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      inFlight.forEach((controller) => controller.abort())
    }
  }, [pollIntervalMs])

  return state
}

/**
 * Take the new build. Called from a click and from nowhere else.
 *
 * `location.reload()` on its own is not enough and is the reason this function exists. The
 * stale service worker is still installed and still answering from a cache generation it
 * populated; a plain reload can hand the user the same bundle it just told them was old, and
 * they learn the Reload button is a lie. So, in order:
 *
 *   1. tell any waiting worker to stop waiting, so the *new* worker is the one that survives,
 *   2. drop every cache, so nothing can serve the old bundle,
 *   3. unregister, so the reload starts clean and re-registers `/sw.js` from the network,
 *   4. only then reload.
 *
 * Every step is best-effort. A browser with service workers disabled, a private window with no
 * CacheStorage, a rejected unregister — none of that should cost the user their reload, so the
 * whole thing is wrapped and the reload happens regardless.
 */
export async function applyUpdate(): Promise<void> {
  const hasServiceWorker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator

  try {
    const registrations = hasServiceWorker ? await navigator.serviceWorker.getRegistrations() : []

    for (const registration of registrations) {
      registration.waiting?.postMessage({ type: 'SKIP_WAITING' })
    }

    if (typeof caches !== 'undefined') {
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key)))
    }

    await Promise.all(registrations.map((registration) => registration.unregister()))
  } catch {
    // Nothing recoverable and nothing worth reporting: the reload below is the point.
  }

  window.location.reload()
}
