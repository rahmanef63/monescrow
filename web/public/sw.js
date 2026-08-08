/* eslint-disable */
/**
 * MonEscrow service worker. Hand written, deliberately small, deliberately timid.
 *
 * It exists for two reasons and no others:
 *
 *  1. **Installability.** Chrome will not offer "Add to home screen" for a page that has no
 *     fetch handler, however good its manifest is. So there is a fetch handler.
 *
 *  2. **The update path.** `UpdateToast` needs something it can tell to step aside, which is
 *     the `SKIP_WAITING` message below.
 *
 * What it must never do is make a stale escrow state look like a current one. A `/job/0x…`
 * page served from cache could show a milestone as "Attested" hours after the challenge
 * window closed and the money moved, and somebody would act on that. A slow page is an
 * inconvenience; a confidently wrong one costs money. So:
 *
 *   - **No HTML, ever.** Navigations and document requests fall straight through to the
 *     network. There is no offline page and no navigation preload — offline, the browser's
 *     own error page is the honest answer.
 *   - **No `/api/*`, ever.** `/api/version` in particular: a cached version endpoint is the
 *     classic way the update toast ships dead. The others (`/api/chat`, `/api/verify`,
 *     `/api/ai/milestones`) are POSTs, which the `GET`-only guard already excludes, but the
 *     path check states the intent rather than relying on that.
 *   - **No cross-origin.** RPC endpoints, explorers and wallet bridges are none of our
 *     business, and an opaque response we cannot inspect is not a thing to store.
 *
 * That leaves exactly two categories worth a cache-first read, both of which are safe because
 * their URL changes whenever their bytes change (or, for images, because they are decoration):
 *
 *   - `/_next/static/*` — content-hashed by the bundler, immutable by construction.
 *   - image files under `/public` — logos and illustrations.
 *
 * Cache-first with no background revalidation is the whole strategy. For `/_next/static/*`
 * that is exactly right. For a `/public` image replaced in place under the same name it means
 * the old bytes survive until the cache is dropped — which is precisely what the Reload button
 * in `UpdateToast` does (`caches.keys()` then `caches.delete`), so a new deploy clears them.
 */

/** Every cache this worker owns starts with this, so `activate` can sweep its own and only its own. */
const CACHE_PREFIX = 'monescrow-';
const CACHE_NAME = CACHE_PREFIX + 'static-v1';

/** Content-hashed by the bundler: a changed file is a changed URL, so cached bytes cannot go stale. */
const IMMUTABLE_PREFIXES = ['/_next/static/'];

/** Decoration under `/public`. Never a document, never data, never a balance. */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico'];

/**
 * A new worker sits in `waiting` until told otherwise — no `skipWaiting()` on install.
 *
 * That is on purpose: swapping the worker under a live tab means the next asset request can be
 * answered by a different cache generation than the one the running bundle expects. The update
 * is announced by `UpdateToast` and taken by the user's click, never behind their back.
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

/**
 * The one thing the page can ask of us.
 *
 * Accepts both the object form and the bare string, because "post `skipWaiting` to the waiting
 * worker" is folklore written both ways and a silently ignored message here would strand a user
 * on the old build after they explicitly asked for the new one.
 */
self.addEventListener('message', (event) => {
  const data = event.data;
  const type = typeof data === 'string' ? data : data && data.type;
  if (type === 'SKIP_WAITING' || type === 'skipWaiting') {
    self.skipWaiting();
  }
});

/**
 * The allow-list. Everything not explicitly named here is left to the network, which is the
 * safe default — a request this worker does not answer behaves exactly as if it did not exist.
 */
function isCacheable(request, url) {
  if (request.method !== 'GET') return false;
  if (url.origin !== self.location.origin) return false;

  // Documents, three ways, because different browsers populate different fields.
  if (request.mode === 'navigate') return false;
  if (request.destination === 'document') return false;
  if ((request.headers.get('accept') || '').includes('text/html')) return false;

  if (url.pathname.startsWith('/api/')) return false;

  // Our own control surfaces. A cached worker or manifest is a worker that can never be replaced.
  if (url.pathname === '/sw.js' || url.pathname === '/manifest.webmanifest') return false;

  if (IMMUTABLE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return true;

  const path = url.pathname.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return; // Unparseable URL: not ours to touch.
  }

  if (!isCacheable(request, url)) return; // No respondWith() — the browser handles it normally.

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      const hit = await cache.match(request);
      if (hit) return hit;

      const response = await fetch(request);

      // Only store a response we can actually read and that actually succeeded. Opaque
      // (cross-origin) and error responses are poison in a cache-first path: store a 404 once
      // and it is served forever.
      if (response && response.status === 200 && response.type === 'basic') {
        const copy = response.clone();
        event.waitUntil(cache.put(request, copy));
      }

      return response;
    })(),
  );
});
