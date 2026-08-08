# Brief — Alfa (Claude Desktop / Cowork)

**Why this lane.** Alfa is the only worker with a real browser and a path to the live chain.
Everything here either needs that, or is strictly serial and therefore worthless to
parallelise.

Owns: `contracts/src/**`, `deploy/**`, `docs/**`, `README.md`, and every interaction with
Monad testnet.

---

## Phase 0 — freeze the seams *(done)*

- [x] `Escrow.sol` + `EscrowFactory.sol` written and compiling
- [x] Cancun support **verified empirically** against Monad testnet rather than assumed —
      probed `MCOPY` and `TSTORE/TLOAD` with `eth_call` on raw init code, both supported.
      That is what makes `ReentrancyGuardTransient` safe to use here, worth doing because
      Monad prices a cold `SSTORE` at 8,100 gas versus Ethereum's 2,100.
- [x] Attestation security suite — 12/12, covering forged signers, self-signing by the
      freelancer, replay across submissions, across milestones, and across escrows
- [x] `docs/01-INTERFACES.md` — C1–C10

## Phase 1 — deploy *(blocked on gate G1: Taskforce tests green)*

Do not start this until `forge test` is green on `main`. Redeploying and re-verifying
because of a bug the tests would have caught is a bad trade.

1. Dry-run from the Safe to produce the deployment bytecode:
   `forge script script/Deploy.s.sol:DeployScript --rpc-url <rpc> --sender $SAFE`
2. Propose to the Safe with monskills' `propose.sh` — **unmodified**. Never hand-roll the
   EIP-712 proposal.
3. Human signs 2-of-2 and executes.
4. Read the deployed address out of the `ContractCreation` log — the receipt's own
   `contractAddress` is always `null` for a Safe deployment, because the Safe delegatecalls
   `CreateCall` rather than doing `CREATE` itself.
5. Verify on every explorer in one call via the monskills verify API.
6. Record everything in `deploy/`.

**The existing Safe is disposable and 2-of-2 with an ephemeral agent key.** If that key is
gone, deploy a fresh Safe with two keys the human controls. Do not send mainnet funds to
either.

A verifier key is also needed: generate it, publish only the **address** as
`NEXT_PUBLIC_VERIFIER_ADDRESS`, keep the private key server-side as `VERIFIER_PRIVATE_KEY`.
It never goes in a `NEXT_PUBLIC_` var and never gets committed.

## Phase 2 — integration

The part nobody else can do: click the running app in a real browser against the real chain.

- [ ] Swap the anvil address for the deployed Factory, restart, confirm the list loads
- [ ] Walk the full path with two wallets: create + fund → accept → submit → verify →
      watch the countdown → release → withdraw
- [ ] Walk the failure paths: dispute during the window, arbiter resolves both ways,
      deadline reclaim
- [ ] **Adversarial pass:** deploy a deliberately blank page and confirm it passes the HTTP
      check — then confirm the challenge window is what saves the client. If that
      demonstration does not work, the product story does not hold.
- [ ] Confirm the four viewer roles each see the right controls and nothing more

## Phase 3 — submission

- [ ] `README.md` with the diagrams: architecture, milestone state machine, the
      attestation → challenge-window sequence, the Safe deployment flow. Render every
      Mermaid block before committing — GitHub's renderer is stricter than it looks, and
      hardcoded dark fills are unreadable in light theme.
- [ ] `DEMO.md` — clean-clone walkthrough
- [ ] Demo recording of the happy path plus the dispute path
- [ ] `.monskills` metadata (`chain=monad-testnet`)
- [ ] Reproducible-build proof: clean checkout compiles to the same runtime bytecode hash
      as what is deployed and verified

## Standing rules

- Never publish a personal wallet address in the README. Contract and Safe addresses are
  fine and necessary; a human's address ties a GitHub identity to onchain history forever,
  and EVM addresses are identical on testnet and mainnet.
- Every write in the UI: simulate, estimate, show cost, wait for a click, send with an
  explicit gas limit.
- If a contract change becomes unavoidable, announce it to Taskforce and Studio **before**
  editing — it invalidates tests and UI already in flight.
