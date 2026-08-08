/**
 * Tests for credential resolution and provider selection.
 *
 * Every test names the property it protects. Two matter more than the rest:
 *
 *   - "no credential still returns milestones" — rule 3. If this goes red the demo stops
 *     working on any machine without an API key, which is every judge's machine.
 *   - the `key never escapes` block — the user's key is held for one request and must not
 *     appear in a result, in a thrown error, in a rejected value, or on the console. Those
 *     tests serialise everything reachable and search for the key string.
 *
 * No network and no real SDK: both providers are injected, so every path here is pure.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LLM_KEY_ENV,
  LLM_KEY_HEADER,
  proposeMilestones,
  resolveCredential,
  selectProvider,
} from './provider'
import type { EnvLike, HeadersLike, ProviderDeps } from './provider'
import type { BriefInput, Credential, MilestoneDraft, MilestoneProvider } from '@/lib/ai/types'

/** A realistic-looking secret. Distinctive so a substring search cannot match by accident. */
const USER_KEY = 'sk-ant-user-ZZZQQQ-1234567890-do-not-leak'
const SERVER_KEY = 'sk-ant-server-YYYWWW-0987654321-do-not-leak'

const TOTAL = '6000000000000000000' // 6 MON in wei — larger than Number.MAX_SAFE_INTEGER.

const INPUT: BriefInput = {
  brief: 'Build a landing page and wire up the signup form.',
  totalAmount: TOTAL,
  currency: 'MON',
}

function draft(title: string, amount: string): MilestoneDraft {
  return {
    title,
    amount,
    check: 'http',
    criteria: {
      v: 1,
      title,
      check: 'http',
      http: {
        url: 'https://example.com/',
        expectStatus: 200,
        mustContain: ['Sign up'],
        mustNotContain: [],
        timeoutMs: 10_000,
      },
    },
    rationale: 'because the brief says so',
  }
}

const TEMPLATE_DRAFTS: MilestoneDraft[] = [
  draft('Landing page live', '2000000000000000000'),
  draft('Signup form works', '4000000000000000000'),
]

const LLM_DRAFTS: MilestoneDraft[] = [
  draft('Design approved', '1000000000000000000'),
  draft('Site deployed', '5000000000000000000'),
]

/** A `Headers` whose `get` folds case for us, i.e. the production shape. */
function realHeaders(entries: Record<string, string>): HeadersLike {
  return new Headers(entries)
}

/**
 * A Headers-like whose `get` is a literal key lookup, i.e. the shape that would quietly break
 * case-insensitivity if `readHeader` trusted `get` alone.
 */
function literalHeaders(entries: Record<string, string>): HeadersLike {
  return {
    get: (name: string) =>
      Object.prototype.hasOwnProperty.call(entries, name) ? entries[name] : null,
    forEach: (callback) => {
      for (const [key, value] of Object.entries(entries)) callback(value, key)
    },
  }
}

const NO_HEADERS: HeadersLike = { get: () => null }
const NO_ENV: EnvLike = {}

function templateProvider(drafts: MilestoneDraft[] = TEMPLATE_DRAFTS): MilestoneProvider {
  return { name: 'template', propose: vi.fn(async () => drafts) }
}

/** `llm` here throws if called — used to prove the LLM path is not even constructed. */
function depsWithoutLlm(template = templateProvider()): ProviderDeps {
  return {
    template,
    llm: vi.fn(() => {
      throw new Error('the llm provider must not be constructed without a credential')
    }),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveCredential', () => {
  it('prefers the header over the env — the user\'s own key wins for their own request', () => {
    const resolved = resolveCredential(
      realHeaders({ [LLM_KEY_HEADER]: USER_KEY }),
      { [LLM_KEY_ENV]: SERVER_KEY },
    )

    expect(resolved).toEqual({ source: 'header', credential: { kind: 'api-key', value: USER_KEY } })
  })

  it('falls back to the env key when no header is supplied — the self-hosting path', () => {
    const resolved = resolveCredential(NO_HEADERS, { [LLM_KEY_ENV]: SERVER_KEY })

    expect(resolved).toEqual({ source: 'env', credential: { kind: 'api-key', value: SERVER_KEY } })
  })

  it('resolves to none when neither is present — no credentials is a supported state', () => {
    expect(resolveCredential(NO_HEADERS, NO_ENV)).toEqual({ source: 'none' })
  })

  it('treats a blank header as absent and falls through to env rather than erroring', () => {
    const resolved = resolveCredential(
      realHeaders({ [LLM_KEY_HEADER]: '   ' }),
      { [LLM_KEY_ENV]: SERVER_KEY },
    )

    expect(resolved).toEqual({ source: 'env', credential: { kind: 'api-key', value: SERVER_KEY } })
  })

  it('treats an empty header with no env as none — a cleared field gets the template, not a 400', () => {
    expect(resolveCredential(realHeaders({ [LLM_KEY_HEADER]: '' }), NO_ENV)).toEqual({
      source: 'none',
    })
    expect(resolveCredential(realHeaders({ [LLM_KEY_HEADER]: '\t \n ' }), NO_ENV)).toEqual({
      source: 'none',
    })
  })

  it('treats a blank env var as absent — an unset-but-declared var must not select the LLM path', () => {
    expect(resolveCredential(NO_HEADERS, { [LLM_KEY_ENV]: '   ' })).toEqual({ source: 'none' })
  })

  it('matches the header name case-insensitively, including on a case-sensitive Headers-like', () => {
    const viaReal = resolveCredential(realHeaders({ 'X-LLM-Key': USER_KEY }), NO_ENV)
    const viaLiteral = resolveCredential(literalHeaders({ 'X-LLM-KEY': USER_KEY }), NO_ENV)
    const viaMixed = resolveCredential(literalHeaders({ 'X-Llm-kEy': USER_KEY }), NO_ENV)

    for (const resolved of [viaReal, viaLiteral, viaMixed]) {
      expect(resolved).toEqual({ source: 'header', credential: { kind: 'api-key', value: USER_KEY } })
    }
  })

  it('trims transport whitespace off the key so the SDK is not handed a padded secret', () => {
    const resolved = resolveCredential(realHeaders({ [LLM_KEY_HEADER]: `  ${USER_KEY}  ` }), NO_ENV)

    expect(resolved).toEqual({ source: 'header', credential: { kind: 'api-key', value: USER_KEY } })
  })

  it('reports kind api-key — oauth is an extension point on the type, not a v1 flow', () => {
    const resolved = resolveCredential(realHeaders({ [LLM_KEY_HEADER]: USER_KEY }), NO_ENV)

    expect(resolved.source === 'none' ? null : resolved.credential.kind).toBe('api-key')
  })
})

describe('selectProvider', () => {
  it('returns the template provider when there is no credential', () => {
    const deps = depsWithoutLlm()

    expect(selectProvider({ source: 'none' }, deps)).toBe(deps.template)
    expect(deps.llm).not.toHaveBeenCalled()
  })

  it('returns the LLM provider built from the credential when one exists', () => {
    const llmProvider: MilestoneProvider = { name: 'llm', propose: async () => LLM_DRAFTS }
    const seen: Credential[] = []
    const deps: ProviderDeps = {
      template: templateProvider(),
      llm: (credential) => {
        seen.push(credential)
        return llmProvider
      },
    }

    const selected = selectProvider(
      { source: 'header', credential: { kind: 'api-key', value: USER_KEY } },
      deps,
    )

    expect(selected).toBe(llmProvider)
    expect(seen).toEqual([{ kind: 'api-key', value: USER_KEY }])
  })
})

describe('proposeMilestones', () => {
  it('no credential still returns milestones, from the template — rule 3, the demo path', async () => {
    const deps = depsWithoutLlm()

    const result = await proposeMilestones(INPUT, { source: 'none' }, deps)

    expect(result).toEqual({ milestones: TEMPLATE_DRAFTS, source: 'template' })
    expect(deps.llm).not.toHaveBeenCalled()
    expect(deps.template.propose).toHaveBeenCalledWith(INPUT)
  })

  it('uses the LLM and labels the source llm when a credential resolves', async () => {
    const template = templateProvider()
    const deps: ProviderDeps = {
      template,
      llm: () => ({ name: 'llm', propose: async () => LLM_DRAFTS }),
    }

    const result = await proposeMilestones(
      INPUT,
      { source: 'env', credential: { kind: 'api-key', value: SERVER_KEY } },
      deps,
    )

    expect(result).toEqual({ milestones: LLM_DRAFTS, source: 'llm' })
    expect(template.propose).not.toHaveBeenCalled()
  })

  it('falls back to the template when the LLM rejects — an expired key is degraded, not fatal', async () => {
    const onFallback = vi.fn()
    const deps: ProviderDeps = {
      template: templateProvider(),
      llm: () => ({
        name: 'llm',
        propose: async () => {
          throw new Error('401 authentication_error')
        },
      }),
      onFallback,
    }

    const result = await proposeMilestones(
      INPUT,
      { source: 'header', credential: { kind: 'api-key', value: USER_KEY } },
      deps,
    )

    expect(result).toEqual({ milestones: TEMPLATE_DRAFTS, source: 'template' })
    expect(onFallback).toHaveBeenCalledWith({ reason: 'llm-error' })
  })

  it('falls back when constructing the LLM client throws, not only when the call does', async () => {
    const deps: ProviderDeps = {
      template: templateProvider(),
      llm: () => {
        throw new Error('malformed key')
      },
    }

    const result = await proposeMilestones(
      INPUT,
      { source: 'header', credential: { kind: 'api-key', value: USER_KEY } },
      deps,
    )

    expect(result).toEqual({ milestones: TEMPLATE_DRAFTS, source: 'template' })
  })

  it('falls back when the LLM resolves with garbage instead of drafts', async () => {
    // Every entry is a plausible model failure, and each must land on the template rather
    // than reaching the UI as a half-built escrow.
    const garbage: unknown[] = [
      undefined,
      null,
      'here are your milestones!',
      [],
      {},
      { milestones: LLM_DRAFTS },
      [{ title: 'no amount', check: 'http', criteria: LLM_DRAFTS[0].criteria, rationale: '' }],
      // An amount as a JSON number has already lost wei precision by the time we see it.
      [{ ...LLM_DRAFTS[0], amount: 6e18 }],
      [{ ...LLM_DRAFTS[0], amount: '1.5' }],
      [{ ...LLM_DRAFTS[0], amount: '-1' }],
      [{ ...LLM_DRAFTS[0], amount: '' }],
      [{ ...LLM_DRAFTS[0], check: 'vibes' }],
      // check and criteria.check disagreeing would show one promise and verify another.
      [{ ...LLM_DRAFTS[0], check: 'clientApproval' }],
      [{ ...LLM_DRAFTS[0], criteria: { v: 2, title: 't', check: 'http', http: {} } }],
      [{ ...LLM_DRAFTS[0], criteria: { v: 1, title: 't', check: 'http' } }],
      [{ ...LLM_DRAFTS[0], title: '   ' }],
      [{ ...LLM_DRAFTS[0], rationale: undefined }],
    ]

    for (const bad of garbage) {
      const onFallback = vi.fn()
      const deps: ProviderDeps = {
        template: templateProvider(),
        // Cast confined to the fixture: the point of the test is that the runtime value does
        // not match the type the provider promised.
        llm: () => ({ name: 'llm', propose: async () => bad as MilestoneDraft[] }),
        onFallback,
      }

      const result = await proposeMilestones(
        INPUT,
        { source: 'header', credential: { kind: 'api-key', value: USER_KEY } },
        deps,
      )

      expect(result, `garbage payload ${JSON.stringify(bad) ?? String(bad)}`).toEqual({
        milestones: TEMPLATE_DRAFTS,
        source: 'template',
      })
      expect(onFallback).toHaveBeenCalledWith({ reason: 'llm-invalid-output' })
    }
  })

  it('accepts well-formed github and clientApproval drafts — the guard is not http-only', async () => {
    const drafts: MilestoneDraft[] = [
      {
        title: 'Repo tagged',
        amount: '3000000000000000000',
        check: 'github',
        criteria: {
          v: 1,
          title: 'Repo tagged',
          check: 'github',
          github: {
            repo: 'octocat/hello',
            ref: 'v1.0.0',
            requireCommit: true,
            requireCheckRun: null,
            minStars: null,
          },
        },
        rationale: 'the brief names a repo',
      },
      {
        title: 'Client signs off',
        amount: '3000000000000000000',
        check: 'clientApproval',
        criteria: { v: 1, title: 'Client signs off', check: 'clientApproval' },
        rationale: 'taste is not machine-checkable',
      },
    ]
    const deps: ProviderDeps = {
      template: templateProvider(),
      llm: () => ({ name: 'llm', propose: async () => drafts }),
    }

    const result = await proposeMilestones(
      INPUT,
      { source: 'header', credential: { kind: 'api-key', value: USER_KEY } },
      deps,
    )

    expect(result).toEqual({ milestones: drafts, source: 'llm' })
  })

  it('does not swallow a broken template — that is our bug, not a degraded LLM', async () => {
    const deps: ProviderDeps = {
      template: {
        name: 'template',
        propose: async () => {
          throw new Error('template parser is broken')
        },
      },
      llm: () => ({ name: 'llm', propose: async () => LLM_DRAFTS }),
    }

    await expect(proposeMilestones(INPUT, { source: 'none' }, deps)).rejects.toThrow(
      'template parser is broken',
    )
  })

  it('survives an onFallback hook that throws — observability cannot break the page', async () => {
    const deps: ProviderDeps = {
      template: templateProvider(),
      llm: () => ({
        name: 'llm',
        propose: async () => {
          throw new Error('rate limited')
        },
      }),
      onFallback: () => {
        throw new Error('logger exploded')
      },
    }

    const result = await proposeMilestones(
      INPUT,
      { source: 'header', credential: { kind: 'api-key', value: USER_KEY } },
      deps,
    )

    expect(result).toEqual({ milestones: TEMPLATE_DRAFTS, source: 'template' })
  })
})

describe('the key never escapes', () => {
  /** Serialise anything, including Errors and BigInts, so a substring search is meaningful. */
  function deepSerialise(value: unknown): string {
    const seen = new WeakSet<object>()
    const parts: string[] = []

    const walk = (node: unknown): void => {
      if (node === null || node === undefined) return
      if (typeof node === 'object') {
        if (seen.has(node)) return
        seen.add(node)
        if (node instanceof Error) {
          parts.push(node.name, node.message, node.stack ?? '')
          walk((node as Error & { cause?: unknown }).cause)
        }
        for (const key of Reflect.ownKeys(node)) {
          if (typeof key === 'string') parts.push(key)
          const descriptor = Object.getOwnPropertyDescriptor(node, key)
          if (descriptor && 'value' in descriptor) walk(descriptor.value)
        }
        return
      }
      parts.push(String(node))
    }

    walk(value)
    return parts.join(' ')
  }

  it('deepSerialise actually finds a planted key — the leak detector is not vacuous', () => {
    expect(deepSerialise(new Error(`bad key ${USER_KEY}`))).toContain(USER_KEY)
    expect(deepSerialise({ a: [{ b: { c: USER_KEY } }] })).toContain(USER_KEY)
  })

  it('is absent from the result when the LLM rejects with an error quoting it', async () => {
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ]
    const seenEvents: unknown[] = []
    const deps: ProviderDeps = {
      template: templateProvider(),
      llm: () => ({
        name: 'llm',
        propose: async () => {
          // Exactly what a real HTTP client does: echoes the request it just sent.
          throw new Error(`401 from POST /v1/messages (x-api-key: ${USER_KEY})`)
        },
      }),
      onFallback: (event) => seenEvents.push(event),
    }

    const result = await proposeMilestones(
      INPUT,
      { source: 'header', credential: { kind: 'api-key', value: USER_KEY } },
      deps,
    )

    expect(deepSerialise(result)).not.toContain(USER_KEY)
    expect(deepSerialise(seenEvents)).not.toContain(USER_KEY)
    for (const spy of consoleSpies) {
      expect(deepSerialise(spy.mock.calls)).not.toContain(USER_KEY)
    }
    expect(seenEvents).toEqual([{ reason: 'llm-error' }])
  })

  it('is absent when the LLM rejects with a non-Error value carrying it', async () => {
    const deps: ProviderDeps = {
      template: templateProvider(),
      llm: () => ({
        name: 'llm',
        propose: () => Promise.reject({ status: 401, request: { headers: { key: USER_KEY } } }),
      }),
    }

    const result = await proposeMilestones(
      INPUT,
      { source: 'header', credential: { kind: 'api-key', value: USER_KEY } },
      deps,
    )

    expect(result.source).toBe('template')
    expect(deepSerialise(result)).not.toContain(USER_KEY)
  })

  it('is absent from a thrown error when the template also fails after an LLM failure', async () => {
    const deps: ProviderDeps = {
      template: {
        name: 'template',
        propose: async () => {
          throw new Error('template parser is broken')
        },
      },
      llm: () => ({
        name: 'llm',
        propose: async () => {
          throw new Error(`boom ${USER_KEY}`)
        },
      }),
    }

    // The one case where this module does surface an error. Even then the key must not ride
    // along inside it, so the route can log the failure without leaking the request.
    const thrown = await proposeMilestones(
      INPUT,
      { source: 'header', credential: { kind: 'api-key', value: USER_KEY } },
      deps,
    ).then(
      (value) => value as unknown,
      (error: unknown) => error,
    )

    expect(deepSerialise(thrown)).not.toContain(USER_KEY)
  })

  it('is absent from the successful result too — nothing decorates drafts with the credential', async () => {
    const deps: ProviderDeps = {
      template: templateProvider(),
      llm: () => ({ name: 'llm', propose: async () => LLM_DRAFTS }),
    }

    const result = await proposeMilestones(
      INPUT,
      { source: 'header', credential: { kind: 'api-key', value: USER_KEY } },
      deps,
    )

    expect(deepSerialise(result)).not.toContain(USER_KEY)
    expect(deepSerialise(result)).not.toContain(SERVER_KEY)
  })
})
