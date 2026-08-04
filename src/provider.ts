import type { ModelInfo, ProviderInfo } from "@opencode-ai/client"

/**
 * meat talks to exactly two wire protocols and picks between them from the model
 * id alone (`meat/provider.go`): an id that is `claude-…`, optionally behind an
 * `anthropic/` prefix, goes to the Anthropic Messages API; everything else goes
 * to the OpenAI Responses API. OpenCode instead knows a provider per model, so
 * every selection has to be lowered onto that two-way split — and some
 * combinations simply cannot be expressed.
 */
export type Transport = "anthropic" | "openai"

export interface Invocation {
  readonly transport: Transport
  /** Value for `meat -model`. */
  readonly model: string
  /** Environment overlaid on the meat subprocess. */
  readonly env: Readonly<Record<string, string>>
}

/** `undefined` when meat cannot be pointed at the model at all. */
export type Plan = Invocation | undefined

const ANTHROPIC_PREFIX = "anthropic/"
const ANTHROPIC_PACKAGE = "@ai-sdk/anthropic"
const ANTHROPIC_PROVIDER = "anthropic"
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com"
const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com"

/** Mirrors `isAnthropicModel` in meat/provider.go, byte for byte. */
export function routesToAnthropic(model: string): boolean {
  const id = model.startsWith(ANTHROPIC_PREFIX) ? model.slice(ANTHROPIC_PREFIX.length) : model
  return id.startsWith("claude-")
}

export function planInvocation(model: ModelInfo, provider: ProviderInfo | undefined): Plan {
  const settings = { ...provider?.settings, ...model.settings }
  const headers = { ...provider?.headers, ...model.headers }
  const baseURL = typeof settings["baseURL"] === "string" ? settings["baseURL"] : undefined
  const key = apiKey(settings, headers)
  // Two signals, because neither alone is enough. The canonical provider id is
  // api.anthropic.com whatever module serves it — an OAuth wrapper reports a
  // file:// URL as its package. And a provider like Kimi For Coding speaks the
  // Anthropic Messages API under its own id, which only the package reveals.
  // (OpenCode qualifies packages with their loader: "aisdk:@ai-sdk/anthropic".)
  const pkg = model.package ?? provider?.package ?? ""
  const anthropicEndpoint =
    model.providerID === ANTHROPIC_PROVIDER || pkg.slice(pkg.lastIndexOf(":") + 1) === ANTHROPIC_PACKAGE

  if (anthropicEndpoint) {
    // The provider speaks Anthropic Messages but meat would dial the OpenAI
    // Responses API for this id, and nothing in its CLI can override that.
    if (!routesToAnthropic(model.modelID)) return undefined
    return {
      transport: "anthropic",
      model: model.modelID,
      env: withKey("ANTHROPIC_API_KEY", key, {
        // meat appends "/v1/messages" itself, so a catalog base URL that already
        // carries the version segment would otherwise double it.
        ANTHROPIC_BASE_URL: baseURL ? baseURL.replace(/\/+$/, "").replace(/\/v1$/, "") : ANTHROPIC_DEFAULT_BASE_URL,
      }),
    }
  }

  // Mirror image: a Claude id on a gateway sends meat to api.anthropic.com.
  if (routesToAnthropic(model.modelID)) return undefined
  return {
    transport: "openai",
    model: model.modelID,
    // meat appends "/responses" to a ".../v1" base and "/v1/responses" otherwise,
    // so catalog base URLs pass through untouched.
    env: withKey("OPENAI_API_KEY", key, { OPENAI_BASE_URL: baseURL ?? OPENAI_DEFAULT_BASE_URL }),
  }
}

function withKey(name: string, key: string | undefined, env: Record<string, string>): Record<string, string> {
  // An absent key is left to the ambient environment rather than blanked out:
  // meat's own error names the variable the user has to set.
  if (key) env[name] = key
  return env
}

/**
 * OpenCode stores a configured key wherever the provider's SDK wants it: in
 * `settings.apiKey` for the openai-compatible family, or already folded into the
 * request headers for the first-party providers.
 */
function apiKey(settings: Record<string, any>, headers: Record<string, string>): string | undefined {
  if (typeof settings["apiKey"] === "string" && settings["apiKey"]) return settings["apiKey"]
  for (const [name, value] of Object.entries(headers)) {
    const header = name.toLowerCase()
    if (header === "x-api-key" && value) return value
    if (header === "authorization" && value.startsWith("Bearer ")) return value.slice("Bearer ".length)
  }
  return undefined
}
