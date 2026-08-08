# Three-minute pitch

Delivery script. Short sentences on purpose — this is spoken, not read.

**The one thing a judge must remember:** the verifier does not control the money. It only
opens a challenge window. The client can still stop it.

**Seven words if you lose the script on stage:**
Problem → Fund → Work → Verify → Wait → Release/Dispute → Monad

---

## The timing fix

The obvious running order does not fit. A 90-second countdown cannot live inside a
30-second demo slot — you would stand in silence for a third of your pitch.

**So start the clock early and come back to it.** Attest at the end of the Challenge Window
section, let it run while you talk about Monad, and return to a countdown at zero.

| Time | Screen | Beat |
|---|---|---|
| 0:00–0:20 | Title | Who trusts first? |
| 0:20–0:40 | App, funded job | Money is locked, split by milestone |
| 0:40–1:05 | Submit → Verify | The verifier proposes |
| 1:05–1:40 | **Challenge window** | **The whole pitch.** Attest here — clock starts |
| 1:40–2:15 | Why Monad | *(clock running underneath)* |
| 2:15–2:40 | Back to the job | Countdown hits zero → Release → Withdraw |
| 2:40–3:00 | Closing | Back to the problem |

---

## 0:00–0:20 · Start with the problem

> Imagine I am a freelancer.
>
> The client says: *"I am afraid to pay first — what if the freelancer disappears?"*
>
> The freelancer says: *"I am afraid to work first — what if the client does not pay?"*
>
> So the question is simple. **Who has to trust first?**

No technology yet. Not one word about blockchain.

## 0:20–0:40 · What MonEscrow does

> MonEscrow removes that question.
>
> The client funds the whole project up front. But the money does not go to the freelancer.
> It is locked in a contract and split across milestones.
>
> Three MON, three milestones, one MON each.
>
> The client has proved the money is real. The freelancer cannot take it yet.

## 0:40–1:05 · The freelancer delivers

Show: **Submit evidence → Run the check**

> The freelancer finishes a milestone and submits proof. A URL, a commit, whatever was
> agreed.
>
> A verifier checks it. But here is what matters —
>
> **the verifier cannot send money.**
>
> All it can say is: *"By my check, this milestone passed."*

If someone calls it an AI judge, correct it immediately. **It is not a judge.** AI helps
draft milestones. The verifier is a separate service with deliberately limited power.

## 1:05–1:40 · The challenge window — slow down here

Show the countdown. Say the line:

> **This is the most important part of MonEscrow.**

Then:

> The verifier said pass. The money did not move.
>
> A challenge window opened instead. The client has time to look at the work.
>
> Say nothing, and the milestone becomes releasable — and *anyone* can trigger it. The
> freelancer does not have to chase anybody.
>
> Object, and the milestone freezes. An arbiter decides.
>
> So automation helps the freelancer get paid — without taking away the client's right to
> say no.

**Attest here.** The clock is now running while you talk.

```
Freelancer submits
       ↓
Verifier: PASS
       ↓
⏱  Challenge window
     ↙        ↘
 Silence     Dispute
    ↓           ↓
 Release      Freeze
    ↓           ↓
Freelancer   Arbiter
```

## 1:40–2:15 · Why Monad

No TPS, no parallel execution, unless asked.

> One job produces many small transactions. Submit. Verify. Release. Withdraw. Then the
> same again for the next milestone.
>
> That needs a chain that is fast and cheap enough that none of it feels like a decision.
>
> One Monad detail did change our design: **you pay the gas limit, not the gas used.** So
> the app sets the limit itself rather than letting your wallet pick a generous one, and it
> shows you the exact maximum before you sign.

## 2:15–2:40 · Back to the job — the payoff

The countdown is at zero. Click **Release**, then **Withdraw**.

> The window closed. The client said nothing, and silence is a decision.
>
> Now anyone can release it — I could do this from a wallet that is not party to the job at
> all.
>
> And notice: released is not paid. It credits a balance, and the freelancer withdraws.
> Money is never pushed in this contract.

**Say "releasable", never "sent automatically".** After 90 seconds the milestone *becomes
releasable*. `release` and `withdraw` are still real transactions.

## 2:40–3:00 · Close on the problem

> MonEscrow is not a freelance marketplace. We are not replacing Upwork. No discovery, no
> bidding, no profiles, no reputation.
>
> This is the payment layer for a client and a freelancer who already found each other.
>
> The client is safe, because the money is not released the moment a robot says so.
> The freelancer is safe, because the money was there from day one.
>
> And once the work is proven, the freelancer does not have to chase anyone to get paid.
>
> **Silence should pay. Objection should pause.**
>
> That is MonEscrow.

---

## Hold this back for Q&A

The blank-page demo is your strongest material and it does not fit in three minutes. Keep
it for the first question.

> Our HTTP check is `status 200`. Here is a completely blank page — it passes. So does every
> empty page on the internet. Lighthouse over 80 passes too.
>
> Every automated check has this property. That is exactly why we never let the check decide.
> It opens a window, and the client can still object.
>
> The check was wrong and the client kept their money.

Open `/api/blank` while you say it.

## Other likely questions

**"What if the arbiter disappears?"** Honest answer: a disputed milestone has one exit and
it is arbiter-only. We know. It is in our findings list, not hidden.

**"Is the verifier an AI?"** No. AI drafts milestones from a brief. The verifier is a
separate service that runs a check and signs — and its signature only opens a window.

**"Why not just use a normal escrow service?"** Because someone still has to decide the work
is done, and that someone becomes the bottleneck. We made the decision a deadline instead.

**"Is this audited?"** No, and the app says so on every screen. Testnet only.
