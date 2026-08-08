# Safe proposal relay

Alfa's sandbox cannot reach the chain. Probed, not assumed — every host the deployment
needs is refused by the sandbox HTTP proxy:

| Host | Needed for | Result |
|---|---|---|
| `testnet-rpc.monad.xyz` | Safe `nonce()` read | ❌ `403 from proxy after CONNECT` |
| `api.safe.global` | queueing the signed transaction | ❌ 403 |
| `agents.devnads.com` | explorer verification (A-4) | ❌ 403 |
| `api.github.com` | the `github` milestone check | ❌ 403 |
| `github.com`, `registry.npmjs.org` | — | ✅ 200 |

The monskills `wallet` skill is explicit that `propose.mjs` runs **unmodified** and that the
EIP-712 Safe proposal is never hand-rolled. Both rules hold here. The only thing that
changes is the transport underneath.

## How it works

`propose-via-relay.sh` reproduces `propose.sh`'s bootstrap and adds exactly one flag:

```
node --import ./fetch-relay.mjs ~/.monskills/propose-deps/propose.mjs
```

`--import` runs `fetch-relay.mjs` before the entry module, which swaps `globalThis.fetch`
for a file-spool transport. `propose.mjs` is byte-identical to the skill's copy and does
not know the relay exists — the script prints both SHA-256s side by side each run so that
claim is checkable rather than asserted.

Everything `propose.mjs` does over the network goes through `globalThis.fetch`: viem's
`http()` transport for the nonce read, and a plain `fetch` for the Safe POST. One override
covers both. Requests to hosts *not* on the relay list fall through to the real `fetch` —
there is no reason to route a working request through a human.

```
propose.mjs ──fetch──► fetch-relay.mjs ──► spool/<run>/req-N.json
                                                    │
                                          courier (Chrome / curl)
                                                    │
propose.mjs ◄─Response── fetch-relay.mjs ◄── spool/<run>/res-N.json
```

## Running it

```bash
CHAIN_ID=10143 \
SAFE_ADDRESS=0x... \
PRIVATE_KEY=0x... \
DEPLOYMENT_BYTECODE=$(cd contracts && forge script script/Deploy.s.sol:DeployScript \
                        --sig "initCode()" --offline --json | jq -r '.returns["0"].value') \
  bash tools/relay/propose-via-relay.sh
```

It blocks on the first request. In a second shell:

```bash
cd tools/relay
node courier.mjs show          # what is waiting
node courier.mjs read 1        # decode it + get a browser-console snippet
# run the snippet in a tab with network access, copy the JSON it returns
node courier.mjs write 1       # paste on stdin
```

Repeat for each request. A deployment is two hops: the RPC `nonce()` read, then the Safe
Transaction Service POST.

## Why the envelopes look like that

Payloads are gzipped and base64'd, with a SHA-256 over the decoded JSON checked at both
ends.

That is not ceremony. The single most likely failure on this path is a **truncated
paste** — a Safe deployment payload is ~16 KB of hex and it crosses a console, a clipboard
and possibly a chat message. Silent truncation would produce a validly-shaped transaction
proposing *different bytecode*, which is the worst possible outcome: it deploys, it
verifies against nothing, and you find out later. Base64 survives newline mangling; the
hash makes a clipped copy fail loudly and immediately. Verified: clipping eight characters
off a response is caught at gunzip before it reaches the caller.

Responses are matched on `runId` **and** `seq`, so a stale file from an earlier run cannot
be silently consumed.

## Secrets

`PRIVATE_KEY` never enters the spool. `propose.mjs` signs locally and sends only the
signature — the relay additionally scans every outbound envelope for the key and aborts
the run if it appears. That check should never fire; if it does, something upstream changed
and the run deserves to stop. Verified against a full two-hop run: neither the raw spool
files nor the decoded payloads contain the signing key.

`spool/` is gitignored. The envelopes carry signed Safe payloads and have no reason to
outlive the run that produced them.

## Proven before it was needed

A complete dry run with a throwaway signer and a dummy Safe, on 2026-08-08:

```
propose.mjs sha256: a75771476b76adab33d6005c49739ccedd89f37e43ea33b20a84334cdcd83966
  (skill  original): a75771476b76adab33d6005c49739ccedd89f37e43ea33b20a84334cdcd83966
✅ Safe nonce: 0                    ← relayed RPC read
✍️  Signing with EIP-712...          ← local, no network
✅ Transaction hash: 0x7e3d43d8…    ← EIP-712 digest
✅ Agent signed (1/2)
📤 Posting to Transaction Service API...   ← relayed POST, 201
```

The point of doing this against a dummy Safe is that deploy day is a bad time to discover
the transport is broken. What is *not* proven is the Safe API's response to a real
proposal — that needs a real Safe, which is D-1.
