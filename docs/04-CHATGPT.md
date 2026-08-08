# Brief — Studio (ChatGPT)

**Why this lane.** Two reasons, and the second one matters more than people expect.

1. Image generation is a capability the other two workers do not have at all.
2. **A reviewer who did not write the code is worth far more than one who did.** Studio
   never touches `contracts/` or `web/src/`, and that is exactly what makes its review
   useful — it reads the product the way a judge will, with no memory of why a decision
   seemed reasonable at the time.

Owns `assets/**` only. Do not edit code; report problems, do not patch them.

---

## Part 1 — brand and assets

Deliver exactly the paths, sizes and formats in **C9** of `docs/01-INTERFACES.md`. A renamed
file is a broken build — the frontend imports by path.

**Product in one line:** turn any freelance agreement into a programmable escrow. Money is
locked up front and released milestone by milestone as work is proven.

**Tone:** trustworthy infrastructure, not a crypto casino. Closer to a bank statement than
to a token launch. No coins, no rockets, no handshake clip-art, no gold.

**Surface is dark by default** — every transparent asset must read on `#09090b`.

| Token | Value | Use |
|---|---|---|
| background | `#09090b` | page |
| surface | `#18181b` | cards |
| border | `#27272a` | dividers |
| text | `#f4f4f5` / `#a1a1aa` | primary / secondary |
| accent | `#836EF9` | Monad purple — primary actions |
| success | `#34d399` | released, passed |
| warning | `#fbbf24` | challenge window running |
| danger | `#f87171` | disputed, failed |

Typeface: system UI stack. Do not introduce a custom font — it costs load time for nothing.

Asset notes:

- **Logo** — wordmark "MonEscrow" plus a mark that survives at 16px. The concept worth
  exploring: a lock that is also a progress bar. Locked money that opens in segments.
- **OG image** (1200×630) — the one-liner, the product name, and a hint of the milestone
  strip. Assume it is seen at thumbnail size in a Discord embed.
- **Empty states** — `no-jobs` and `awaiting-freelancer`. Calm, not cute. These are the
  first screens a judge sees on a fresh deploy, so they carry more weight than their size
  suggests.
- **Deck** (1920×1080) — the problem deadlock, the milestone strip, the challenge window,
  the architecture. Diagram-led, minimal words.

---

## Part 2 — the diagram that carries the pitch

The single most important visual: **the challenge window**, because it is the idea that
makes this different from every other escrow.

Show three timelines side by side:

1. **Traditional escrow** — work finishes, then a long wait on the client to click, then
   payment. The freelancer's money sits hostage to someone else's inbox.
2. **Naive AI escrow** — a bot decides and pays instantly. Fast, and nobody sane would fund
   it, because a bot can be wrong or gamed and the money is already gone.
3. **MonEscrow** — verifier proposes → challenge window opens → silence pays out
   automatically, an objection freezes it for the arbiter.

The third timeline should read as obviously the right answer once the first two are next to
it. If it does not, the diagram is wrong, not the reader.

---

## Part 3 — adversarial review

Do these after integration, and be blunt. Approval is not useful; specifics are.

**Copy.** Every button label, error message, and empty state. The state names a user sees
are `Open`, `Submitted`, `Verified — 23h left to object`, `Released`, `Disputed`,
`Refunded`. Do they read clearly to someone who has never used an escrow? Flag jargon.

**The trust story.** Read the README and the UI as a sceptical freelancer, then again as a
sceptical client. The questions to hunt for:

- Who runs the verifier, and what happens if it lies or goes offline?
- What stops a freelancer submitting a blank page that passes an HTTP check?
- What happens if the client disputes everything out of bad faith?
- Where does my money sit, and who can move it?

If the UI does not answer these where the user is standing, that is a finding. Write the
finding, not the fix.

**Demo flow.** Watch the recording as a judge with 90 seconds of attention. Where does it
drag? What is on screen when they decide whether to keep watching?

**What not to do:** do not propose new features. Scope discipline is the reason this project
can finish at all. Judge what exists.
