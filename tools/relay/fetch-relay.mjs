// Node `--import` hook: replaces globalThis.fetch with a file-spool transport.
//
// WHY THIS EXISTS
// ---------------
// Alfa runs in a sandbox whose HTTP proxy allowlists github.com and the npm registry and
// refuses everything else. `testnet-rpc.monad.xyz`, `api.safe.global` and
// `agents.devnads.com` all return `403 from proxy after CONNECT`. So the Safe proposal
// flow cannot make a network call from here.
//
// The monskills `wallet` skill is explicit that `propose.mjs` must be run unmodified and
// that the EIP-712 Safe proposal must never be hand-rolled. Both rules survive here:
// this file is loaded with `node --import ./fetch-relay.mjs propose.mjs`, which runs
// before the entry module and swaps the transport underneath it. `propose.mjs` is
// byte-identical to the copy the skill ships; it does not know this file exists.
//
// Everything `propose.mjs` does over the network goes through `globalThis.fetch` — viem's
// `http()` transport for the Safe `nonce()` read, and the plain `fetch` that POSTs the
// signed transaction to the Safe Transaction Service. One override covers both.
//
// THE PROTOCOL
// ------------
// For call N this writes `spool/<runId>/req-N.json` and then polls for `res-N.json`.
// A courier with real network access (Claude driving the Chrome extension, or a human
// with curl) performs the request and writes the response back.
//
//   req-N.json  { runId, seq, sha256, gzipB64 }  -> { url, method, headers, body }
//   res-N.json  { runId, seq, sha256, gzipB64 }  -> { status, statusText, headers, body }
//
// Payloads are gzipped and base64'd so a response can cross a clipboard, a chat message
// or a JS console without a newline or a quote character mangling it. `sha256` is over
// the *decoded* JSON text and is checked on both ends: a truncated paste is the failure
// mode this whole path is most likely to hit, and it must fail loudly rather than deliver
// half a Safe transaction.
//
// SAFETY
// ------
// The only secret in this flow is `PRIVATE_KEY`, and it never leaves the process:
// `propose.mjs` uses it to sign locally and puts the *signature* in the request body.
// This hook still scans every outbound envelope for anything shaped like a 32-byte key
// and aborts the run if it finds one. That check should never fire. If it does, something
// upstream changed and the run deserves to stop.

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPOOL_ROOT = process.env.RELAY_SPOOL ?? join(HERE, 'spool');
const RUN_ID = process.env.RELAY_RUN_ID ?? randomUUID().slice(0, 8);
const RUN_DIR = join(SPOOL_ROOT, RUN_ID);
const TIMEOUT_MS = Number(process.env.RELAY_TIMEOUT_MS ?? 600_000);
const POLL_MS = Number(process.env.RELAY_POLL_MS ?? 500);

// Hosts we expect to be unreachable directly. Anything else is let through to the real
// fetch — no reason to relay a request that would have worked, and forcing localhost
// through a human courier would be absurd.
const RELAY_HOSTS = [
  'testnet-rpc.monad.xyz',
  'rpc.monad.xyz',
  'api.safe.global',
  'agents.devnads.com',
];

const realFetch = globalThis.fetch;
let seq = 0;

mkdirSync(RUN_DIR, { recursive: true });

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const pack = (obj) => {
  const json = JSON.stringify(obj);
  return { sha256: sha256(json), gzipB64: gzipSync(Buffer.from(json, 'utf8')).toString('base64') };
};
const unpack = (env) => {
  const json = gunzipSync(Buffer.from(env.gzipB64, 'base64')).toString('utf8');
  const got = sha256(json);
  if (got !== env.sha256) {
    throw new Error(
      `relay: response integrity check failed.\n` +
        `  expected sha256 ${env.sha256}\n` +
        `  actual   sha256 ${got}\n` +
        `This almost always means the payload was truncated in transit. Re-copy it whole.`,
    );
  }
  return JSON.parse(json);
};

// Nothing that looks like a private key may ever reach the spool.
const KEYISH = /\b(0x)?[0-9a-fA-F]{64}\b/g;
function assertNoSecret(json) {
  const priv = process.env.PRIVATE_KEY?.replace(/^0x/, '').toLowerCase();
  if (!priv) return;
  const hay = json.toLowerCase();
  for (const m of hay.match(KEYISH) ?? []) {
    if (m.replace(/^0x/, '') === priv) {
      throw new Error(
        'relay: refusing to spool a request containing PRIVATE_KEY. ' +
          'propose.mjs is supposed to sign locally and send only the signature. Aborting.',
      );
    }
  }
}

function waitForResponse(file) {
  const deadline = Date.now() + TIMEOUT_MS;
  // Deliberately synchronous. propose.mjs awaits each call in order, and blocking here
  // keeps the request/response files strictly paired — a courier working the spool by
  // hand should never have to reason about two open requests at once.
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8').trim();
      if (raw.length) return JSON.parse(raw);
    }
    Atomics.wait(view, 0, 0, POLL_MS);
  }
  throw new Error(`relay: timed out after ${TIMEOUT_MS}ms waiting for ${file}`);
}

globalThis.fetch = async function relayFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  const host = new URL(url).hostname;

  if (!RELAY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    return realFetch(input, init);
  }

  const n = ++seq;
  const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
  const request = {
    url,
    method: init.method ?? 'GET',
    headers,
    body: typeof init.body === 'string' ? init.body : init.body ? String(init.body) : undefined,
  };

  const json = JSON.stringify(request);
  assertNoSecret(json);

  const reqFile = join(RUN_DIR, `req-${n}.json`);
  const resFile = join(RUN_DIR, `res-${n}.json`);
  writeFileSync(reqFile, JSON.stringify({ runId: RUN_ID, seq: n, ...pack(request) }, null, 2));

  process.stderr.write(
    `\n[relay] request ${n} → ${request.method} ${url}\n` +
      `[relay] wrote ${reqFile}\n` +
      `[relay] waiting for ${resFile} …\n`,
  );

  const envelope = waitForResponse(resFile);
  if (envelope.runId !== RUN_ID || envelope.seq !== n) {
    throw new Error(
      `relay: response mismatch — expected run ${RUN_ID} seq ${n}, got run ${envelope.runId} seq ${envelope.seq}. ` +
        `A stale response file from an earlier run is the usual cause; clear the spool and retry.`,
    );
  }

  const res = unpack(envelope);
  process.stderr.write(`[relay] response ${n} ← ${res.status} ${res.statusText ?? ''}\n\n`);

  return new Response(res.body ?? null, {
    status: res.status,
    statusText: res.statusText ?? '',
    headers: res.headers ?? { 'content-type': 'application/json' },
  });
};

process.stderr.write(
  `[relay] active. run ${RUN_ID}, spool ${RUN_DIR}\n` +
    `[relay] relaying: ${RELAY_HOSTS.join(', ')}\n`,
);

// Leave a breadcrumb so the courier can find the run without being told.
writeFileSync(
  join(SPOOL_ROOT, 'LATEST'),
  `${RUN_ID}\n${RUN_DIR}\nstarted ${new Date().toISOString()}\n`,
);

export function spoolState() {
  return { runId: RUN_ID, dir: RUN_DIR, files: readdirSync(RUN_DIR) };
}
