#!/usr/bin/env node
// Checks web/src against the five principles in docs/05-DESIGN.md.
//
//   node tools/design-lint.mjs            # report
//   node tools/design-lint.mjs --strict   # exit 1 on any failure (CI)
//
// WHY THIS EXISTS
// ---------------
// "The design has too much text and no principles" is true and was unactionable, because
// nobody could tell when it had been fixed. Every rule below is a number, so the same
// sentence becomes a pass/fail anyone can re-run — the design equivalent of `forge test`.
//
// It reads only. It never edits `web/src`, which belongs to Taskforce under C10.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'web', 'src');
const STRICT = process.argv.includes('--strict');

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(p) && !/\.test\./.test(p)) out.push(p);
  }
  return out;
};

let files;
try {
  files = walk(SRC);
} catch {
  console.error(`No such directory: ${SRC}. Run from the repo root.`);
  process.exit(2);
}

const rel = (f) => relative(ROOT, f).replace(/\\/g, '/');
const results = [];
const record = (id, title, pass, detail) => results.push({ id, title, pass, detail });

// ── P3 · a real type scale, used sparsely ────────────────────────────────────
const sizes = { xs: 0, sm: 0, base: 0, lg: 0, xl: 0, '2xl': 0, '3xl': 0, '4xl': 0 };
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\btext-(xs|sm|base|lg|xl|2xl|3xl|4xl)\b/g)) sizes[m[1]]++;
}
const totalType = Object.values(sizes).reduce((a, b) => a + b, 0);
const xsShare = totalType ? sizes.xs / totalType : 0;
const bigShare = totalType ? (sizes['2xl'] + sizes['3xl'] + sizes['4xl']) / totalType : 0;

record(
  'P3a',
  'text-xs is under 40% of all type',
  xsShare < 0.4,
  `${(xsShare * 100).toFixed(0)}% (${sizes.xs}/${totalType})`,
);
record(
  'P3b',
  'display sizes (2xl+) are at least 5% of type',
  bigShare >= 0.05,
  `${(bigShare * 100).toFixed(0)}% (${sizes['2xl'] + sizes['3xl'] + sizes['4xl']}/${totalType})`,
);

// ── P1 · one primary action per screen ───────────────────────────────────────
const routeFiles = files.filter((f) => /[\\/]app[\\/].*page\.tsx$/.test(f));
const multiPrimary = [];
for (const f of routeFiles) {
  const src = readFileSync(f, 'utf8');
  const n = (src.match(/btn-primary|variant=["']primary["']/g) || []).length;
  if (n > 1) multiPrimary.push(`${rel(f)} (${n})`);
}
record(
  'P1',
  'at most one primary action per route',
  multiPrimary.length === 0,
  multiPrimary.length ? multiPrimary.join(', ') : 'all routes clean',
);

// ── P4 · 8-point spacing, no arbitrary values ────────────────────────────────
const arbitrary = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\b[mp][trblxy]?-\[(\d+)px\]/g)) {
    if (Number(m[1]) % 4 !== 0) arbitrary.push(`${rel(f)}: ${m[0]}`);
  }
}
record(
  'P4',
  'no off-scale arbitrary spacing',
  arbitrary.length === 0,
  arbitrary.length ? arbitrary.slice(0, 5).join(', ') : 'all spacing on the 4px grid',
);

// ── P5 · prose is capped in cards ────────────────────────────────────────────
// Empty states are exempt: distinguishing "not asked" from "asked and empty" is worth
// the words, and that distinction is load-bearing for this product.
const CARD = /Card\.tsx$/;
const longProse = [];
for (const f of files.filter((x) => CARD.test(x))) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/>\s*([^<>{}\n]{121,})\s*</g)) {
    longProse.push(`${rel(f)}: "${m[1].trim().slice(0, 48)}…" (${m[1].trim().length} chars)`);
  }
}
record(
  'P5',
  'no card contains prose over 120 characters',
  longProse.length === 0,
  longProse.length ? longProse.slice(0, 3).join(' | ') : 'all cards concise',
);

// ── P2 · state before words in cards ─────────────────────────────────────────
const noState = [];
for (const f of files.filter((x) => CARD.test(x))) {
  const src = readFileSync(f, 'utf8');
  const hasStateVisual =
    /state|status|Countdown|badge|Badge/i.test(src) &&
    /bg-|className=.*(success|warning|danger|accent|muted)/.test(src);
  if (!hasStateVisual) noState.push(rel(f));
}
record(
  'P2',
  'every card leads with a visual state element',
  noState.length === 0,
  noState.length ? noState.join(', ') : 'all cards carry state visuals',
);

// ── touch targets ────────────────────────────────────────────────────────────
const smallTaps = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bh-(\d+)\b[^>]*\bonClick/g)) {
    if (Number(m[1]) * 4 < 44) smallTaps.push(`${rel(f)}: h-${m[1]} (${Number(m[1]) * 4}px)`);
  }
}
record(
  'TAP',
  'interactive elements are at least 44px tall',
  smallTaps.length === 0,
  smallTaps.length ? smallTaps.slice(0, 4).join(', ') : 'no undersized tap targets found',
);

// ── report ───────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
console.log(`\ndesign-lint — ${files.length} components, ${totalType} type declarations\n`);
console.log(`  ${pad('RULE', 6)}${pad('', 2)}${pad('CHECK', 46)}DETAIL`);
console.log('  ' + '─'.repeat(96));
for (const r of results) {
  console.log(`  ${pad(r.id, 6)}${r.pass ? '✅' : '❌'}  ${pad(r.title, 46)}${r.detail}`);
}

const failed = results.filter((r) => !r.pass);
console.log('');
console.log(
  failed.length
    ? `  ${results.length - failed.length}/${results.length} passing — ${failed.map((f) => f.id).join(', ')} still to fix\n`
    : `  ${results.length}/${results.length} passing — the spec in docs/05-DESIGN.md is satisfied\n`,
);

// Type distribution, because the shape of it is the whole diagnosis.
console.log('  type distribution');
const maxN = Math.max(...Object.values(sizes), 1);
for (const [k, v] of Object.entries(sizes)) {
  if (!v) continue;
  console.log(`    ${pad('text-' + k, 12)}${pad(v, 5)}${'█'.repeat(Math.round((v / maxN) * 40))}`);
}
console.log('');

process.exit(STRICT && failed.length ? 1 : 0);
