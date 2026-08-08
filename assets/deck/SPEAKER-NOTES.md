# MonEscrow deck speaker notes

Use the numbered PNGs in this folder in order. The 90-second version is the judge hook; the
three-minute version is the complete pitch before questions.

## Claims that must remain consistent

- MonEscrow is not a marketplace. The parties already know each other.
- The client funds the whole job up front; value releases milestone by milestone.
- The verifier proposes a pass. It never transfers funds or settles a dispute.
- A pass opens a challenge window. Product default: 3 days. Demo preset: 90 seconds.
- Before the deadline, the client can object and freeze that milestone for the arbiter.
- After silence, anyone can call `release`. Time alone does not broadcast a transaction.
- `Released` credits the freelancer's `owed` balance. The freelancer still calls `withdraw`.
- The verifier's public demo address is
  `0x87B9AfEafA109e96c41504E0ce84e08c055D5eaf`.
- Testnet only, not audited, and never described as risk-free or fully trustless.

Do not call the verifier an “AI judge.” AI may draft milestones; verification is a separate,
bounded service. Slide 04's naive-AI column is the unsafe comparison, not MonEscrow's design.

## 90-second version

### 01 - Title (0:00-0:08)

“Freelancers should not chase a client's inbox to get paid. MonEscrow turns an existing
freelance agreement into a milestone escrow with a clock.”

### 02 - Problem (0:08-0:20)

“The client fears paying before delivery. The freelancer fears delivering before payment.
Escrow secures the money, but ordinary escrow still waits for a human to click.”

### 03 - Mechanism (0:20-0:33)

“The whole job is funded first. The freelancer submits evidence. A verifier can propose that
a milestone passed, but cannot release anything.”

### 04 - Challenge window (0:33-0:53)

“Traditional escrow can wait forever. Naive automation pays before anyone can catch a bad
verdict. MonEscrow opens a challenge window: silence makes the milestone releasable; an
objection freezes it for the arbiter.”

Pause on the MonEscrow column. This is the pitch carrier.

### 05 - Product flow (0:53-1:04)

“No profiles or bidding. Open, fund, submit, challenge, settle. Every screen should say where
the money is and who acts next.”

### 06 - Trust boundaries (1:04-1:15)

“The verifier proposes. The client objects. The arbiter only handles disputes. The contract
holds funds and enforces state and time.”

### 07 - Why Monad (1:15-1:22)

“Monad makes these milestone transitions fast and inexpensive enough to feel like product
state, not a wire transfer.”

### 08 - States (1:22-1:27)

“The state language mirrors the contract, including the live time left to object.”

### 09 - Close (1:27-1:30)

“Silence should pay. Objection should pause. That is MonEscrow.”

## Three-minute version

### 01 - Title (0:00-0:15)

“A client and freelancer may agree on the work and still disagree about who takes the risk
first. MonEscrow makes that relationship programmable without becoming another marketplace.”

### 02 - Problem (0:15-0:35)

“Direct payment asks the client to trust delivery. Work-first asks the freelancer to trust
payment. Generic escrow removes neither the definition-of-done problem nor the client's
ability to leave a finished milestone waiting indefinitely.”

### 03 - Mechanism (0:35-0:58)

“The client locks the complete budget on Monad. The freelancer submits evidence milestone by
milestone. The verifier signs a proposal tied to one escrow, one milestone, and one exact
submission. It cannot move money.”

### 04 - Challenge window (0:58-1:30)

“This is the difference. Traditional escrow waits for a click. Naive AI escrow pays before a
human can stop a wrong or gamed verdict. MonEscrow opens a challenge window. The realistic
product default is three days; this demo uses ninety seconds so judges can see it expire. If
the client is silent, anyone can trigger release. If the client objects, that milestone
freezes for the arbiter.”

### 05 - Product flow (1:30-1:52)

“The parties bring their own relationship. They open the agreement, fund the full job,
submit evidence, see the countdown, and settle each milestone. No discovery, bidding, profile,
or reputation layer is required.”

### 06 - Trust boundaries (1:52-2:16)

“The verifier address is public. If its key lies or leaks, it can only propose a pass and the
client still has the veto window. If it goes offline, funds do not move. The arbiter only gains
authority after a dispute. Released funds become an owed balance; the recipient withdraws.”

### 07 - Why Monad (2:16-2:32)

“A job can create many small state transitions: submit, attest, dispute, resolve, release,
withdraw, then repeat. Monad's speed, low transaction cost, and EVM compatibility make that
granular flow practical.”

### 08 - Product states (2:32-2:47)

“The UI uses the contract's lifecycle in plain language: Open, Submitted, Verified with time
left to object, Released, Disputed, and Refunded. The exact next actor and amount remain
visible.”

### 09 - Close (2:47-3:00)

“MonEscrow gives freelancers a deadline instead of a chase, gives clients a veto instead of
blind automation, and gives both parties one shared source of truth. Silence should pay.
Objection should pause.”

## Questions to expect

### Who runs the verifier?

For the testnet demo it is a project-operated signer whose address is public. The private key
is server-side. Its authority is deliberately limited to proposing a pass.

### What if the verifier lies?

A false pass opens the challenge window. It does not transfer funds. The client can dispute
before the window expires.

### What if the verifier is offline?

No pass is attested and no funds move. An unreachable target is a retryable 502, not a signed
failure.

### Can a blank page pass?

A weak status-only HTTP criterion can pass a blank page. That is why the exact criteria are
visible before funding and why the client retains the challenge window. A-8 demonstrates this
failure deliberately.

### Can the client dispute everything?

The client can freeze a submitted or attested milestone, but cannot decide the result. The
named arbiter resolves the frozen milestone. Do not claim the current system economically
punishes bad-faith disputes; it does not.

### Where is the money?

The escrow contract holds the funded job. Settlement credits an owed balance to the client or
freelancer. The recipient calls `withdraw()` to move it to their wallet.
