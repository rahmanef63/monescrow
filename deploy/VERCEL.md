# Vercel deployment

D-4 reversed on 2026-08-08: hosted **and** clean-clone, not clean-clone only. A judge gets a
link they can click; `DEMO.md`'s local path stays valid so nothing depends on this account
staying up.

## Right now: the holding page

`web/` has no application in it — T-18 through T-22 are unstarted, so a Vercel build today
would produce nothing. `site/` is a standalone static page that exists so the link is not a
404 in the meantime. It lives in its own directory precisely so it can never collide with
Taskforce's scaffold under `web/` (C10: `web/src/**` is theirs).

`vercel.json` at the repo root serves `site/` with no build step.

```bash
npm i -g vercel
vercel login
vercel --prod          # from the repo root
```

Or connect the GitHub repo in the Vercel dashboard and accept the defaults — `vercel.json`
already specifies everything. **Do not set a framework preset**; it is deliberately `null`.

After the first deploy, if the domain is not `monescrow.vercel.app`, update the two absolute
URLs in `site/index.html` (`og:url` and `og:image`, plus `twitter:image`). Open Graph
scrapers are inconsistent about resolving relative image paths, so those three are absolute
on purpose while every other asset reference is relative — which is what lets the same file
render correctly opened straight off disk.

## Swapping in the real app — do this now

`web/` stopped being a scaffold on 2026-08-08: 50 source files, 665 passing tests, a clean
`next build`, and `/` is a real "my jobs" screen with three viewer tabs and three distinct
empty states. The holding page has done its job.

**One dashboard setting, then a redeploy.** `rootDirectory` is *not* a valid `vercel.json`
key — Root Directory is a project setting and nothing else can set it:

> Vercel → the `monescrow` project → **Settings → General → Root Directory** → `web` → Save

Once Root Directory is `web`, Vercel reads **`web/vercel.json`** (already written: framework
`nextjs`, plus the same three security headers) and the root `vercel.json` becomes dead
config. It is left in place rather than deleted so that reverting is one setting away.

Redeploy from **Deployments → ⋯ → Redeploy** on the latest commit, or just push.

**Before you flip it, know what changes.** The app's `/` reads
`NEXT_PUBLIC_FACTORY_ADDRESS`, which is still empty because G2 has not happened. The page
handles that deliberately — `hasFactory()` false renders "nothing was ever asked" rather than
"you have no jobs", which is the honest message. So a judge landing on the app today sees a
working, empty product rather than the pitch. The holding page argues; the app demonstrates.
Until the factory is deployed, the holding page is arguably the better first impression.

**Reverting** is Root Directory → blank, which puts the root `vercel.json` and `site/` back in
charge. Worth keeping `site/` regardless — it is a useful thing to point at if the app breaks
mid-judging.

## Environment variables — the part worth reading twice

Hosting changes the risk profile of the verifier key. Locally it sits in a gitignored
`.env.local`; on Vercel it sits in a dashboard field, and **which field decides whether it
ships to every visitor's browser.**

**Audited 2026-08-08 against what the code actually reads, not against C8.** The project
currently has **zero environment variables configured** — the Environment Variables page is
empty. Everything below is what has to be added before the deployed app does anything beyond
render empty states.

| Variable | Needed for | If missing |
|---|---|---|
| `NEXT_PUBLIC_FACTORY_ADDRESS` | the whole app | `hasFactory()` false → "no factory configured". Set after A-4 |
| `NEXT_PUBLIC_VERIFIER_ADDRESS` | showing who signed | blank; UI cannot name the signer. `0x87B9AfEafA109e96c41504E0ce84e08c055D5eaf` |
| `NEXT_PUBLIC_PARA_API_KEY` | wallet choice | empty falls back to an injected wallet. Optional |
| `NEXT_PUBLIC_SITE_URL` | OG tags, absolute links | falls back to `VERCEL_URL`, so **safe to leave unset on Vercel** |
| **`VERIFIER_PRIVATE_KEY`** | **`/api/verify` at all** | route returns **502** "the verifier signing key is not available; this is our configuration" |
| **`MONAD_RPC_URL`** | the verify route's onchain binding check | route returns **502** "the verifier has no RPC endpoint configured". `https://testnet-rpc.monad.xyz` |
| `GITHUB_TOKEN` | `github` check rate limit | anonymous limit; a 403 is reported as 502, never as a failing milestone. Optional |
| `ANTHROPIC_API_KEY` | AI parser without BYOK | falls through to the deterministic template, which must always work. Optional |

Two of those are **not in C8** — `MONAD_RPC_URL` and `NEXT_PUBLIC_SITE_URL`. C8 lists
`NEXT_PUBLIC_MONAD_TESTNET_RPC`, but the verify route deliberately uses a **server-side**
`MONAD_RPC_URL` instead, which is the better call: the verifier's RPC is not the browser's, and
a server route has no business reading a `NEXT_PUBLIC_` variable. C8 has been amended to match
the code rather than the other way round.

**Set the two secrets yourself.** I will not paste `VERIFIER_PRIVATE_KEY` into a web form —
handling a private key in plain text is off-limits for me regardless of who asks. It is in
`web/.env.local` on your machine; copy it from there into Vercel as `VERIFIER_PRIVATE_KEY`,
with no prefix.

Worth noticing in the code, because it is the reason a missing key is survivable: env is read
**inside the request handler**, not at module scope. A deploy with no key still builds and
still serves every page — only `/api/verify` fails, with a named 502 that says the fault is
ours rather than the freelancer's. That is C6's 422-vs-502 rule holding at the configuration
layer, which is a nicer piece of design than it first looks.

Next.js inlines **every** `NEXT_PUBLIC_`-prefixed variable into the client bundle at build
time. There is no runtime check and no warning — a key pasted into a field named
`NEXT_PUBLIC_VERIFIER_PRIVATE_KEY` is published to every visitor, permanently, and rotating
it afterwards does not un-publish the builds that already shipped. Paste it as
`VERIFIER_PRIVATE_KEY`, nothing else.

Verify after the first deploy with the app live:

```bash
curl -s https://<deployment>/ | grep -c "$(grep VERIFIER_PRIVATE_KEY web/.env.local | cut -d= -f2)"
# must print 0
```

Worth keeping in proportion: a leaked verifier key lets an attacker *propose* a passing
milestone. Whether that moves money depends entirely on **D-7** — with a non-zero challenge
window the client can still object, which is the design; with `challengeWindow == 0` the
attacker can attest and release in one block. Until D-7 lands, treat this key as capable of
moving funds.

## What not to host

`contracts/`, `deploy/keys/` and `tools/relay/spool/` have no business being served.
`vercel.json` sets `outputDirectory` to a single directory, so nothing outside it is
published — but if the config is ever changed to a framework preset, re-check that.
