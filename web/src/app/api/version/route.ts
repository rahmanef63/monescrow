import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `GET /api/version` — the build id of the code this server is running.
 *
 * `useAppVersion` polls this and compares the answer to what it saw at first load. That makes
 * the caching headers below the entire feature: an answer served from a CDN edge, a browser
 * disk cache or Next's own full-route cache is an answer frozen at the moment of the *old*
 * deploy, so the poll compares the old id to the old id forever and the toast never appears.
 * The feature would look implemented, pass review, and do nothing. Hence `force-dynamic`,
 * `revalidate = 0`, and `no-store` on three layers of cache-control.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

/**
 * Where the id comes from, in order of how much we trust it.
 *
 * The property that matters is not "unique" — it is **the same across every instance serving a
 * given deploy, and different after the next one**. Get that backwards and the toast becomes a
 * nag that reloading cannot silence: two serverless instances behind one hostname, each with
 * its own id, and the user is told a new version is available every time the load balancer
 * sends them to the other box. That is the reason there is no `Math.random()` or bare
 * `Date.now()` in the production path here.
 */
function resolveBuildId(): string {
  // 1. Set it explicitly at build time and everything below is moot. This is the intended
  //    production configuration: `NEXT_PUBLIC_BUILD_ID=$GIT_SHA next build`. It is also the
  //    only value the *client* bundle can see, which lets `useAppVersion` take its baseline
  //    from the build that produced the running JavaScript rather than from a first poll.
  const explicit = process.env.NEXT_PUBLIC_BUILD_ID
  if (explicit) return explicit

  // 2. Platform-provided, stable per deploy across every instance of it.
  const vercelDeployment = process.env.VERCEL_DEPLOYMENT_ID
  if (vercelDeployment) return vercelDeployment

  const commit = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA
  if (commit) return commit

  // 3. Development. One process, so a boot-time value is stable for the whole session and
  //    changes when the dev server restarts — which is the only way to watch this feature work
  //    locally without a deploy. Restart `next dev`, come back to the tab, see the toast.
  if (process.env.NODE_ENV !== 'production') {
    return `dev-${BOOT_ID}`
  }

  // 4. Self-hosted `next start`: the bundler already wrote a per-build id. Read it once.
  try {
    const fromDisk = readFileSync(join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim()
    if (fromDisk) return fromDisk
  } catch {
    // Not there (running from a different cwd, or a build that has not finished writing it).
    // Fall through — an id we cannot trust is worse than admitting we do not have one.
  }

  // 5. Nothing stable is available. Return a constant rather than something per-instance:
  //    a feature that quietly never fires is a bug, but a feature that nags a user forever
  //    with a button that cannot fix it is a worse one. Set NEXT_PUBLIC_BUILD_ID.
  return 'unknown'
}

/** Fixed at module load, used only in development. See step 3 above. */
const BOOT_ID = Date.now().toString(36)

const BUILD_ID = resolveBuildId()

export function GET(): Response {
  return new Response(JSON.stringify({ buildId: BUILD_ID }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // The browser, then any shared cache, then Vercel's edge specifically. Each layer has
      // its own opinion and each one of them can break the poll on its own.
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      'cdn-cache-control': 'no-store',
      'vercel-cdn-cache-control': 'no-store',
    },
  })
}
