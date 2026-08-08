# Deployment runbook — G2

Ordered, and the order matters. Every step names who runs it, because Alfa's sandbox cannot
reach the chain and cannot sign, and Taskforce owns `web/` — so this is the one document
where the three lanes have to interleave.

**Addresses in this file are contracts and Safes only.** The human owner EOA is deliberately
absent: it lives in `deploy/keys/owners.local.json`, which is gitignored. A personal address
in a committed file ties a GitHub identity to onchain history permanently, and EVM addresses
are identical on testnet and mainnet.

## What already exists

| Thing | Value | State |
|---|---|---|
| Verifier signer | `0x87B9AfEafA109e96c41504E0ce84e08c055D5eaf` | ✅ generated (A-1) |
| Deployer agent | `0x5e6F6C87604373d80A7688788C18A7e5AABeD7eA` | ✅ generated, **unfunded** |
| Human owner EOA | *(gitignored)* | ✅ funded, 54.5 MON |
| Old MonFund Safe | `0x7D9f9957…51e174123` | ⛔ disposable, do not reuse |
| Factory init code | **derive it fresh — see below** | ⚠ never hardcode |

Both keystores sit in `deploy/keys/`, inside the project folder rather than a sandbox that
evaporates. **That is the entire fix for what froze the previous Safe** — its second owner was
an agent key in an ephemeral environment, so a 2-of-2 threshold left it unable to execute
anything, including an owner change.

---

## Step 1 — fund the deployer *(human, ~1 min)*

The agent needs gas to deploy the Safe proxy. It never holds anything else.

```bash
cast send 0x5e6F6C87604373d80A7688788C18A7e5AABeD7eA \
  --value 2ether \
  --rpc-url https://testnet-rpc.monad.xyz \
  --interactive          # paste your key at the prompt; never put it in a file
```

Or claim from the faucet — the monskills endpoint is `https://agents.devnads.com/v1/faucet`
with `{"chainId": 10143, "address": "0x5e6F…D7eA"}`.

2 MON is generous. Deploying a Safe proxy costs well under 1.

> On Monad you pay the gas **limit**, not the gas used. Never let a wallet pick the limit.

## Step 2 — deploy the 2-of-2 Safe *(human or Taskforce, needs network)*

Uses the monskills script unmodified. `OWNER_1` is your EOA, `OWNER_2` is the deployer agent —
both keys you hold on disk.

```bash
cd .agents/skills/wallet/utils
OWNER_1=<your EOA>  OWNER_2=0x5e6F6C87604373d80A7688788C18A7e5AABeD7eA \
  forge script DeploySafeCREATE2.sol:DeploySafeCREATE2 \
    --private-key $(cast wallet decrypt-keystore \
        --keystore-dir ../../../../deploy/keys/deployer \
        $(ls ../../../../deploy/keys/deployer | head -1) \
        --unsafe-password "" | awk '{print $NF}') \
    --rpc-url https://testnet-rpc.monad.xyz \
    --broadcast
```

Then confirm it is really 2-of-2 before trusting it with anything:

```bash
cast call $SAFE "getOwners()(address[])"  --rpc-url https://testnet-rpc.monad.xyz
cast call $SAFE "getThreshold()(uint256)" --rpc-url https://testnet-rpc.monad.xyz   # must be 2
```

Record it in `~/.monskills/multisig.json` under `testnet`, and tell Alfa the Safe address —
that one **is** safe to publish.

## Step 3 — propose the factory deployment *(Alfa)*

```bash
CHAIN_ID=10143 SAFE_ADDRESS=$SAFE PRIVATE_KEY=<deployer, decrypted inline> \
DEPLOYMENT_BYTECODE=$(cd contracts && make initcode | grep -o '0x[0-9a-f]*' | head -1) \
  bash tools/relay/propose-via-relay.sh
```

Alfa runs this through the file-spool relay because the sandbox proxy refuses
`testnet-rpc.monad.xyz` and `api.safe.global`. Two hops: the Safe `nonce()` read, then the
Transaction Service POST. Already proven end to end against a dummy Safe — see
`tools/relay/README.md`.

**Derive the expected hash at signing time, never from this file.**

```bash
cd contracts && make initcode        # prints length + keccak of the current source
```

Compare that to the `DEPLOYMENT_BYTECODE` you are about to propose. They must match.

> **This step previously shipped a wrong number and would have rejected a correct deployment.**
> The runbook hardcoded `15,787 B / 0xfa55d0d3…`, recorded before the F-A pagination clamp and
> the D-7 challenge-window bounds. Both changed `EscrowFactory`, so the truth became
> `15,948 B / 0xab0dd6e9…` and nobody updated the doc. A signer following the old instruction
> would have refused the right bytecode and trusted nothing.
>
> The fix is not a better number — it is *not having a number here*. Any constant copied out of
> a build into prose starts decaying the moment the source changes. `make initcode` cannot go
> stale because it reads the source you are actually deploying.

## Step 4 — sign and execute *(human, 2-of-2)*

The proposal appears in the Safe UI queue; `propose.mjs` prints a QR for mobile. Sign with the
second owner and execute.

## Step 5 — read the deployed address *(Alfa)*

**The receipt's `contractAddress` is `null`. Always.** The Safe delegatecalls `CreateCall`, so
it never does a `CREATE` itself. The address is in the `ContractCreation` log — and because it
is a *delegatecall*, that log is emitted from **the Safe's own address**, not `CreateCall`'s.
Filtering by `CreateCall` finds nothing and wastes an hour.

```bash
cast receipt $TX_HASH --rpc-url https://testnet-rpc.monad.xyz --json \
  | jq -r '.logs[] | select(.address|ascii_downcase == ("'$SAFE'"|ascii_downcase)) | .topics, .data'
```

## Step 6 — verify on both explorers *(Alfa)*

MonadVision and Monadscan, via the monskills verify API. G2 requires **both**, plus one
`Escrow` instance, not just the factory.

## Step 7 — reproducible-build proof *(Alfa, A-12)*

```bash
cd contracts && make repro
cast code $FACTORY --rpc-url https://testnet-rpc.monad.xyz | sha256sum
```

The runtime hashes must match. Already proven that a pristine checkout with no `lib/` produces
byte-identical bytecode to the working tree, so any difference here means the deployed source
is not what is in the repo.

## Step 8 — hand off to the app *(Alfa → Taskforce)*

Alfa sets `NEXT_PUBLIC_FACTORY_ADDRESS` in `web/.env.local` and in the Vercel dashboard
(**not** `NEXT_PUBLIC_`-prefixed for anything secret — see `deploy/VERCEL.md`). That is the
only edit Alfa makes anywhere near `web/`; the app itself is Taskforce's.

Once it is set, the deployed app stops rendering "no factory configured" and starts showing
real jobs — which is the moment the Vercel link becomes worth putting in a submission.

---

## Lane boundaries for this operation

| Path | Owner | Note |
|---|---|---|
| `contracts/**`, `deploy/**`, `docs/**`, `README.md`, `DEMO.md`, `site/**`, `tools/**` | Alfa | |
| `web/**`, `vercel.json`, `web/vercel.json` | Taskforce | Alfa touches only `web/.env.local`, which is gitignored |
| Signing, funding, the Safe UI | Human | Alfa cannot sign and must never hold a personal key |
