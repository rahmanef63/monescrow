# Demo recording shot list

This is a preparation handoff for A-11, not an S-8 review. S-8 starts only after a recording
exists.

## Required proof on screen

1. Client creates an agreement with three milestones: HTTP, GitHub, client approval.
2. Challenge-window selector visibly distinguishes 90-second demo preset from 3-day default.
3. Full job amount is shown before the funding transaction.
4. Freelancer accepts before any submission action is available.
5. HTTP milestone submission shows the exact URL/evidence hash.
6. Verifier proposal shows the public signer address or a clearly accessible disclosure.
7. State reads `Verified` with a live time-left-to-object countdown.
8. Happy path lets the timer expire, then shows that anyone can trigger `release`.
9. Show `owed`/withdraw separately so Released is not mistaken for wallet receipt.
10. Dispute path objects inside the window and visibly freezes the affected milestone.
11. Arbiter resolves both directions across the complete recording set.
12. Blank-page adversarial case shows HTTP status passing without implying the work is good.

## Ninety-second edit spine

- 0:00-0:08 - job already funded; name the client/freelancer deadlock.
- 0:08-0:22 - submit evidence and show verifier proposal.
- 0:22-0:38 - challenge-window countdown; explain verifier authority limit.
- 0:38-0:50 - silence path: release, owed balance, withdraw.
- 0:50-1:05 - second seeded milestone: client objects inside the window.
- 1:05-1:18 - disputed/frozen amount and arbiter resolution.
- 1:18-1:27 - blank-page example: superficial check passes, client veto remains.
- 1:27-1:30 - “Silence should pay. Objection should pause.”

## Recording rejection conditions

Studio should reject the take during S-8 if any of these occur:

- More than 15 seconds pass before the challenge-window mechanism appears.
- A wallet or network delay occupies the frame without explanation.
- “Automatic” is used without showing that a caller triggers `release`.
- Released is presented as received before `withdraw` is shown.
- The 90-second demo window is presented as the product default.
- The verifier is described as deciding, judging, approving, or paying.
- The blank-page test is presented as proof that verification guarantees quality.
- The disputed amount or arbiter identity is hidden when the freeze occurs.
- Testnet and unaudited status are absent from the recording context.

## Capture safety

- Use funded test wallets prepared before recording.
- Hide private keys, environment files, relay payloads, and seed phrases.
- Keep addresses visible only where they explain authority or settlement.
- Record one uninterrupted evidence path for credibility, then edit dead time.
- Preserve a full uncut take in addition to the 90-second version.
