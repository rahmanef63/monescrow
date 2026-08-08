/**
 * The C8 scope limit, as a test.
 *
 * `docs/01-INTERFACES.md` C8 (Convex amendment) says Convex exists to store the C3/C4/C5
 * documents — the criteria, the evidence, the verifier report — whose keccak hashes are all
 * that ever go on-chain. It also says, in as many words, what Convex is **not** for:
 *
 *   > `EscrowFactory` maintains its own onchain index (`escrows`, `escrowsOf`, `getEscrows`)
 *   > for the stated reason that a frontend should enumerate jobs with plain `eth_call`s — no
 *   > indexer, no backend. If the job list ever starts reading from Convex, the product has
 *   > acquired a backend it cannot justify and the "turn our servers off and your escrow still
 *   > works" claim stops being true.
 *
 * That paragraph is the kind of rule that quietly dies under deadline, so this file makes it
 * executable. It is a **fitness test**, not a unit test: it asserts a property of the module
 * graph rather than the behaviour of a function.
 *
 * Three assertions, all over the same set of modules — the ones that list jobs and drive
 * actions:
 *
 *   1. nothing reachable from them imports Convex or reads `NEXT_PUBLIC_CONVEX_*`;
 *   2. they do reach the chain — `@/lib/abis` or a wagmi contract read — so the test fails if
 *      somebody *replaces* the chain read rather than merely adding something next to it;
 *   3. nothing reachable from them fetches one of our own API routes to get its data.
 *
 * ## If this test goes red, do not delete it
 *
 * A red run means the job list has grown a dependency on a document store, which is the exact
 * thing C8 forbids. The fix is **to move the Convex read off the listing path**, not to relax
 * the rule:
 *
 *   - the escrow list, the milestone states, the amounts, the deadlines and every button's
 *     enabled/disabled verdict must keep coming from `getEscrows` / `summary` / `milestones`
 *     via wagmi. Those reads are the product;
 *   - the human-readable text (criteria, evidence, report) is the only thing allowed to come
 *     from Convex, and it must be loaded from a module these entry points do **not** statically
 *     import — a leaf component pulled in with `next/dynamic`, or a hook that lives behind its
 *     own module and is rendered inside a boundary that tolerates it being absent;
 *   - with the Convex deployment paused, every job must still list and every milestone must
 *     still be releasable. Only the text degrades.
 *
 * Adding an entry point to `LISTING_ENTRIES` is fine. Removing one because it went red is not.
 *
 * The graph is walked with `node:fs` and nothing else — no new dependency, and no reliance on
 * a build having happened.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/** `web/src` — every path in this file is reported relative to it, so failures are readable. */
const SRC = resolve(__dirname, '..')

/**
 * The critical path: the modules that list jobs and drive the actions on them.
 *
 * `permissions.ts` is here because it is the C1 table — every enabled button in the app is its
 * verdict. If it ever needed a database to answer, the whole "the UI cannot offer a call the
 * chain would reject" story would be routed through a server.
 */
const LISTING_ENTRIES = [
  'app/page.tsx',
  'app/actions/page.tsx',
  'app/job/[address]/page.tsx',
  'components/JobCard.tsx',
  'lib/useTxFlow.ts',
  'lib/chat/permissions.ts',
] as const

/**
 * The subset of the above that must demonstrably read the chain.
 *
 * `lib/chat/permissions.ts` is deliberately excluded: it is pure and total by design — a
 * function of `(action, ctx)` that reads no clock, no network and no chain. Requiring it to
 * reach an ABI would be requiring it to get worse.
 */
const CHAIN_READ_ENTRIES = LISTING_ENTRIES.filter((e) => e !== 'lib/chat/permissions.ts')

/** Extensions tried, in order, when resolving a specifier to a file. */
const EXTENSIONS = ['.ts', '.tsx', '.d.ts']

/** wagmi/viem entry points that constitute "this module read the chain". */
const CHAIN_READ_SYMBOLS = [
  'useReadContract',
  'useReadContracts',
  'readContract',
  'readContracts',
  'multicall',
  'getPublicClient',
]

// ---------------------------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------------------------

/**
 * Blank out comments so a doc-block that *mentions* `@/lib/convex` or `NEXT_PUBLIC_CONVEX_URL`
 * — this file being the obvious example — is not mistaken for code that uses it.
 *
 * Strings and template literals are respected; comment bodies are replaced with spaces so that
 * offsets and line numbers survive.
 */
function stripComments(source: string): string {
  const out = source.split('')
  let i = 0
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '
  }
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      blank(i, end === -1 ? source.length : end)
      i = end === -1 ? source.length : end
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(i, stop)
      i = stop
    } else if (c === "'" || c === '"' || c === '`') {
      i += 1
      while (i < source.length) {
        if (source[i] === '\\') i += 2
        else if (source[i] === c) {
          i += 1
          break
        } else i += 1
      }
    } else {
      i += 1
    }
  }
  return out.join('')
}

/** Every module specifier a file imports, re-exports, dynamically imports or requires. */
function importSpecifiers(code: string): string[] {
  const found: string[] = []
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\s[^'"();]*?from\s*['"]([^'"]+)['"]/g, // import x from 'y'
    /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g, //                            import 'y'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, //                            await import('y')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, //                           require('y')
  ]
  for (const re of patterns) {
    for (const m of code.matchAll(re)) found.push(m[1])
  }
  return found
}

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

/** A path is "local" if we own it: `@/…` or a relative specifier. Everything else is a package. */
function isLocal(spec: string): boolean {
  return spec.startsWith('@/') || spec.startsWith('./') || spec.startsWith('../')
}

/** Turn a specifier into an absolute path, or `null` if it is a bare package. */
function toAbsolute(spec: string, importer: string): string | null {
  if (spec.startsWith('@/')) return join(SRC, spec.slice(2))
  if (spec.startsWith('./') || spec.startsWith('../')) return resolve(dirname(importer), spec)
  return null
}

/** Resolve to an on-disk file, trying the usual extensions and `index` files. */
function resolveFile(base: string): string | null {
  if (existsSync(base) && statSync(base).isFile()) return base
  for (const ext of EXTENSIONS) if (existsSync(base + ext)) return base + ext
  for (const ext of EXTENSIONS) {
    const idx = join(base, 'index' + ext)
    if (existsSync(idx)) return idx
  }
  return null
}

/** `src`-relative, forward slashes, so failure messages read the same on Windows and CI. */
function rel(absolute: string): string {
  return relative(SRC, absolute).split(sep).join(posix.sep)
}

// ---------------------------------------------------------------------------------------------
// The graph walk
// ---------------------------------------------------------------------------------------------

type Edge = { from: string; spec: string }

type Graph = {
  /** Every module reachable from the entry, `src`-relative. */
  modules: Set<string>
  /** How each module was first reached — used to print the chain when a rule fails. */
  via: Map<string, Edge>
  /** Stripped source of each reached module. */
  source: Map<string, string>
  /** Every specifier each reached module imports. */
  imports: Map<string, string[]>
}

function walk(entry: string): Graph {
  const entryAbs = resolveFile(join(SRC, entry))
  if (!entryAbs) throw new Error(`architecture.test.ts: entry point not found: ${entry}`)

  const graph: Graph = { modules: new Set(), via: new Map(), source: new Map(), imports: new Map() }
  const queue = [entryAbs]
  graph.modules.add(rel(entryAbs))

  while (queue.length > 0) {
    const current = queue.shift() as string
    const currentRel = rel(current)
    if (!/\.tsx?$/.test(current)) continue // css, images, json — nothing to walk

    const code = stripComments(readFileSync(current, 'utf8'))
    graph.source.set(currentRel, code)
    const specs = importSpecifiers(code)
    graph.imports.set(currentRel, specs)

    for (const spec of specs) {
      if (!isLocal(spec)) continue
      const absolute = toAbsolute(spec, current)
      if (!absolute) continue
      const resolved = resolveFile(absolute)
      if (!resolved) {
        throw new Error(
          `architecture.test.ts cannot resolve '${spec}' imported by ${currentRel}. ` +
            `If this is a real module, teach resolveFile() about it — do not weaken the rule.`,
        )
      }
      const resolvedRel = rel(resolved)
      if (graph.modules.has(resolvedRel)) continue
      graph.modules.add(resolvedRel)
      graph.via.set(resolvedRel, { from: currentRel, spec })
      queue.push(resolved)
    }
  }
  return graph
}

/** `app/page.tsx -> components/JobCard.tsx -> lib/convexJobs.ts` — a rule you can debug. */
function chainTo(graph: Graph, entry: string, module: string): string {
  const steps: string[] = [module]
  let cursor = module
  while (cursor !== entry) {
    const edge = graph.via.get(cursor)
    if (!edge) break
    steps.unshift(edge.from)
    cursor = edge.from
  }
  return steps.join('\n     -> ')
}

// ---------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------

/** Why this specifier is not allowed on the listing path, or `null` if it is fine. */
function convexReason(spec: string, importer: string): string | null {
  if (spec === 'convex' || spec.startsWith('convex/')) {
    return `imports the Convex client ('${spec}')`
  }
  if (spec.startsWith('@convex-dev/')) {
    return `imports a Convex component ('${spec}')`
  }
  if (isLocal(spec)) {
    const absolute = toAbsolute(spec, join(SRC, importer))
    if (absolute && /^lib[/\\]convex/i.test(relative(SRC, absolute))) {
      return `imports a Convex module ('${spec}')`
    }
  }
  return null
}

const CONVEX_ENV = /NEXT_PUBLIC_CONVEX[A-Z_]*/

/**
 * `fetch()` calls that would mean the data came from a server of ours.
 *
 * `.refetch()` and friends are member calls and are not this; the lookbehind keeps them out.
 */
function backendFetches(code: string): string[] {
  const hits: string[] = []
  for (const m of code.matchAll(/(?<![.\w$])fetch\s*\(\s*([^\s,)]*)/g)) {
    const arg = m[1] ?? ''
    const literal = /^['"`]/.test(arg)
    if (!literal) {
      hits.push(`fetch(${arg || '…'}) — computed URL; this test cannot prove it is not a store`)
    } else if (/^['"`]\/api\//.test(arg)) {
      hits.push(`fetch(${arg}…) — an app API route`)
    } else if (/convex/i.test(arg)) {
      hits.push(`fetch(${arg}…) — a Convex endpoint`)
    }
  }
  return hits
}

const REMEDY =
  '\n\nC8 scope limit: the job list must read the chain, not a database. Move the Convex ' +
  'read off the listing path (a `next/dynamic` leaf that renders only the human-readable ' +
  'text) rather than relaxing this test. See the header of src/lib/architecture.test.ts.'

// ---------------------------------------------------------------------------------------------

describe('C8 scope limit: the listing path reads the chain, not a document store', () => {
  const graphs = new Map(LISTING_ENTRIES.map((entry) => [entry, walk(entry)]))

  it('walks a graph that actually contains the app (guards against the walk silently finding nothing)', () => {
    for (const entry of LISTING_ENTRIES) {
      const graph = graphs.get(entry) as Graph
      expect(graph.modules.size, `${entry} reached no modules — the walk is broken`).toBeGreaterThan(1)
    }
  })

  it.each(LISTING_ENTRIES)('%s reaches no Convex import', (entry) => {
    const graph = graphs.get(entry) as Graph
    const violations: string[] = []

    for (const module of graph.modules) {
      for (const spec of graph.imports.get(module) ?? []) {
        const reason = convexReason(spec, module)
        if (reason) {
          violations.push(`${module} ${reason}\n  via ${chainTo(graph, entry, module)}`)
        }
      }
    }

    expect(violations.join('\n\n') + (violations.length ? REMEDY : ''), REMEDY).toBe('')
  })

  it.each(LISTING_ENTRIES)('%s reaches no read of NEXT_PUBLIC_CONVEX_*', (entry) => {
    const graph = graphs.get(entry) as Graph
    const violations: string[] = []

    for (const module of graph.modules) {
      const match = CONVEX_ENV.exec(graph.source.get(module) ?? '')
      if (match) {
        violations.push(`${module} reads ${match[0]}\n  via ${chainTo(graph, entry, module)}`)
      }
    }

    expect(violations.join('\n\n') + (violations.length ? REMEDY : ''), REMEDY).toBe('')
  })

  it.each(CHAIN_READ_ENTRIES)('%s still reads the chain', (entry) => {
    const graph = graphs.get(entry) as Graph

    const reachesAbis = [...graph.modules].some((m) => /^lib[/\\]abis(\.tsx?)?$/.test(m))
    const wagmiRead = [...graph.modules].find((module) => {
      const code = graph.source.get(module) ?? ''
      if (!/from\s*['"]wagmi(\/actions)?['"]/.test(code) && !/from\s*['"]viem['"]/.test(code)) {
        return false
      }
      return CHAIN_READ_SYMBOLS.some((symbol) => new RegExp(`\\b${symbol}\\b`).test(code))
    })

    expect(
      reachesAbis || Boolean(wagmiRead),
      `${entry} no longer reaches @/lib/abis or a wagmi contract read. Somebody replaced the ` +
        `eth_call with something else.${REMEDY}`,
    ).toBe(true)
  })

  it.each(LISTING_ENTRIES)('%s reaches no fetch of an app API route', (entry) => {
    const graph = graphs.get(entry) as Graph
    const violations: string[] = []

    for (const module of graph.modules) {
      for (const hit of backendFetches(graph.source.get(module) ?? '')) {
        violations.push(`${module}: ${hit}\n  via ${chainTo(graph, entry, module)}`)
      }
    }

    expect(violations.join('\n\n') + (violations.length ? REMEDY : ''), REMEDY).toBe('')
  })
})
