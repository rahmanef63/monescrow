#!/usr/bin/env node
// The other half of the relay: reads a spooled request, and writes the response back.
//
//   node courier.mjs show           # what is waiting
//   node courier.mjs read  <seq>    # decode a request + emit a browser-console snippet
//   node courier.mjs write <seq>    # read the browser's JSON on stdin, write res-<seq>.json
//
// `read` prints a self-contained snippet to run in a tab with real network access. It
// returns exactly the shape `write` expects, so the round trip is copy → run → copy back.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPOOL_ROOT = process.env.RELAY_SPOOL ?? join(HERE, 'spool');

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function runDir() {
  if (process.env.RELAY_RUN_ID) return join(SPOOL_ROOT, process.env.RELAY_RUN_ID);
  const latest = join(SPOOL_ROOT, 'LATEST');
  if (!existsSync(latest)) {
    console.error(`No run found. Expected ${latest}. Start propose-via-relay.sh first.`);
    process.exit(1);
  }
  return readFileSync(latest, 'utf8').split('\n')[1].trim();
}

function decode(file) {
  const env = JSON.parse(readFileSync(file, 'utf8'));
  const json = gunzipSync(Buffer.from(env.gzipB64, 'base64')).toString('utf8');
  if (sha256(json) !== env.sha256) throw new Error(`integrity check failed for ${file}`);
  return { env, payload: JSON.parse(json) };
}

const [, , cmd, seqArg] = process.argv;
const dir = runDir();

if (cmd === 'show') {
  const files = readdirSync(dir).sort();
  const reqs = files.filter((f) => f.startsWith('req-'));
  const done = new Set(files.filter((f) => f.startsWith('res-')).map((f) => f.slice(4)));
  console.log(`run dir: ${dir}\n`);
  for (const r of reqs) {
    const n = r.slice(4);
    const { payload } = decode(join(dir, r));
    const status = done.has(n) ? 'answered' : '** WAITING **';
    console.log(`  seq ${n.replace('.json', '')}  ${status}  ${payload.method} ${payload.url}`);
  }
  if (!reqs.length) console.log('  (nothing spooled yet)');
  process.exit(0);
}

if (cmd === 'read') {
  const { payload } = decode(join(dir, `req-${seqArg}.json`));
  console.log('--- request -------------------------------------------------');
  console.log(JSON.stringify(payload, null, 2));
  console.log('\n--- paste into a browser console with network access -------');
  console.log(
    `await (async () => {
  const r = await fetch(${JSON.stringify(payload.url)}, {
    method: ${JSON.stringify(payload.method)},
    headers: ${JSON.stringify(payload.headers)},${
      payload.body ? `\n    body: ${JSON.stringify(payload.body)},` : ''
    }
  });
  const body = await r.text();
  return JSON.stringify({
    status: r.status,
    statusText: r.statusText,
    headers: Object.fromEntries(r.headers.entries()),
    body,
  });
})()`,
  );
  console.log('\n--- then: node courier.mjs write ' + seqArg + '  (paste that JSON on stdin)');
  process.exit(0);
}

if (cmd === 'write') {
  const raw = readFileSync(0, 'utf8').trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
    // The console snippet returns a JSON *string*; unwrap one level if so.
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  } catch (e) {
    console.error(`Input is not JSON: ${e.message}`);
    console.error('Expected {status, statusText, headers, body}.');
    process.exit(1);
  }
  if (typeof parsed.status !== 'number') {
    console.error('Missing numeric `status`. Did the fetch throw in the browser?');
    process.exit(1);
  }
  const json = JSON.stringify(parsed);
  const envelope = {
    runId: JSON.parse(readFileSync(join(dir, `req-${seqArg}.json`), 'utf8')).runId,
    seq: Number(seqArg),
    sha256: sha256(json),
    gzipB64: gzipSync(Buffer.from(json, 'utf8')).toString('base64'),
  };
  const out = join(dir, `res-${seqArg}.json`);
  writeFileSync(out, JSON.stringify(envelope, null, 2));
  console.log(`wrote ${out}  (status ${parsed.status}, ${json.length} bytes)`);
  process.exit(0);
}

console.error('usage: courier.mjs show | read <seq> | write <seq>');
process.exit(1);
