#!/usr/bin/env node
// Parse every ```mermaid block in the given markdown files and fail loudly on any that
// GitHub would refuse to render.
//
// This exists because a Mermaid block that is wrong renders as a raw code fence on GitHub
// — no error, no warning, just a wall of text where the diagram should be. The README is
// the first thing a judge reads, and a broken diagram there is worse than no diagram.
//
//   node tools/check-mermaid.mjs README.md DEMO.md
//
// Uses mermaid's own parser via jsdom, so it validates against the same grammar GitHub
// uses rather than a hand-rolled approximation.

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 21+ defines `navigator` as a getter-only global, so assigning it throws.
// defineProperty is the only way to shadow it for mermaid's benefit.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});

const { default: mermaid } = await import('mermaid');
mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: check-mermaid.mjs <file.md> [...]');
  process.exit(1);
}

let total = 0;
let failed = 0;

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const blocks = [...src.matchAll(/```mermaid\n([\s\S]*?)```/g)];
  const lines = src.split('\n');

  for (const [i, m] of blocks.entries()) {
    total++;
    const lineNo = lines.findIndex((_, n) => src.split('\n').slice(0, n).join('\n').length >= m.index) || 0;
    const label = `${file} block ${i + 1}`;
    const code = m[1];

    // A hardcoded dark fill is unreadable for anyone on GitHub's light theme, and half of
    // all readers are. Mermaid's default theme adapts; explicit fills do not.
    const darkFill = code.match(/fill\s*:\s*#(0[0-9a-f]{5}|1[0-9a-f]{5}|09090b)/i);

    try {
      await mermaid.parse(code);
      if (darkFill) {
        console.log(`  ⚠  ${label}: parses, but hardcodes a dark fill (${darkFill[0]}) —`);
        console.log(`     unreadable on GitHub's light theme. Drop the style and let the`);
        console.log(`     default theme adapt.`);
        failed++;
      } else {
        const kind = code.trim().split('\n')[0].trim();
        console.log(`  ✅ ${label}: ${kind}`);
      }
    } catch (err) {
      failed++;
      console.log(`  ❌ ${label}: ${String(err.message ?? err).split('\n')[0]}`);
      console.log(`     first line: ${code.trim().split('\n')[0]}`);
    }
  }
}

console.log(`\n${total - failed}/${total} mermaid blocks OK`);
process.exit(failed ? 1 : 0);
