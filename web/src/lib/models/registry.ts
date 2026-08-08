/**
 * Provider connection registry — how to *reach* a provider, nothing else.
 *
 * Deliberately not a capability or pricing catalogue. Those change constantly and belong to a
 * live source; this table only answers "what URL, which wire protocol, which env var", which
 * changes about once a year per provider. Adapted from the registry in `models-rahmanef-com`,
 * trimmed to the providers a hackathon judge is plausibly holding a key for.
 *
 * Two protocols cover nearly all of them: OpenAI's `chat/completions` and Anthropic's
 * `messages`. Aggregators like OpenRouter are just OpenAI-compatible providers, which is why
 * this table has no plugin system and does not need one.
 */

export type WireProtocol = 'openai' | 'anthropic'

export type ProviderConnection = {
  /** Where this provider's key is allowed to be sent, and nowhere else. See `resolve.ts`. */
  baseUrl: string
  protocol: WireProtocol
  /** Server-side fallbacks, in priority order, when the request carries no key. */
  envVars: string[]
  /** What to send when the caller names no model. */
  defaultModel: string
  label: string
}

export const PROVIDERS: Record<string, ProviderConnection> = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    protocol: 'anthropic',
    envVars: ['ANTHROPIC_API_KEY'],
    defaultModel: 'claude-sonnet-5',
    label: 'Anthropic',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai',
    envVars: ['OPENAI_API_KEY'],
    defaultModel: 'gpt-4o',
    label: 'OpenAI',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'openai',
    envVars: ['OPENROUTER_API_KEY'],
    defaultModel: 'anthropic/claude-sonnet-5',
    label: 'OpenRouter',
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocol: 'openai',
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    defaultModel: 'gemini-2.5-flash',
    label: 'Google',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    protocol: 'openai',
    envVars: ['GROQ_API_KEY'],
    defaultModel: 'llama-3.3-70b-versatile',
    label: 'Groq',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    protocol: 'openai',
    envVars: ['DEEPSEEK_API_KEY'],
    defaultModel: 'deepseek-chat',
    label: 'DeepSeek',
  },
  xai: {
    baseUrl: 'https://api.x.ai/v1',
    protocol: 'openai',
    envVars: ['XAI_API_KEY'],
    defaultModel: 'grok-4',
    label: 'xAI',
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    protocol: 'openai',
    envVars: ['MISTRAL_API_KEY'],
    defaultModel: 'mistral-large-latest',
    label: 'Mistral',
  },
  'github-models': {
    baseUrl: 'https://models.github.ai/inference',
    protocol: 'openai',
    envVars: ['GITHUB_TOKEN'],
    defaultModel: 'openai/gpt-4o',
    label: 'GitHub Models',
  },
}

/** The order the picker shows, and the order env fallback is tried in. */
export const PROVIDER_SLUGS = Object.keys(PROVIDERS)

export const isKnownProvider = (slug: string): boolean =>
  Object.prototype.hasOwnProperty.call(PROVIDERS, slug)

/** Host of a URL, for the host-gate assertion and for error messages. */
export const hostOf = (url: string): string => new URL(url).host
