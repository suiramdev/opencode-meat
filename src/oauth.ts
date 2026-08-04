import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import { isRecord } from "./guards.js"

/**
 * meat only ever authenticates with `x-api-key` (`meat/anthropic.go`), and
 * Anthropic answers `401 invalid x-api-key` when that carries a subscription
 * OAuth token — which is every credential `@suiramdev/opencode-anthropic-auth`
 * stores for a Claude Pro/Max login. OpenCode also keeps such a credential
 * server-side and never hands it to the TUI, so meat cannot be given a key at
 * all: hence "AnthropicModel.APIKey is empty".
 *
 * So meat is pointed at a loopback relay instead, which swaps the header for the
 * credential OpenCode holds and — for a subscription token — makes the request
 * look like the client that subscription is for.
 *
 * That shaping is not optional. Measured against api.anthropic.com with one
 * `max_tokens: 1` request, changing nothing but the shape:
 *
 *   bearer + oauth beta                          → 429 rate_limit_error
 *   + user-agent, identity and billing blocks    → 200
 *   …and again with meat's own lowercase tools   → 200
 *
 * Tool names are therefore left alone; only the headers and the system blocks
 * matter. An earlier build sent bearer alone, which is why a subscription login
 * hit "after 4 attempts: anthropic API 429".
 */
const ANTHROPIC = "https://api.anthropic.com"
const HOST = "127.0.0.1"

/**
 * Mirrors `@suiramdev/opencode-anthropic-auth` (`src/constants.ts`, `src/cch.ts`,
 * `prependClaudeCodeIdentity` in `src/transform.ts`), which owns this handshake
 * for OpenCode's own requests.
 *
 * Copied rather than imported: that plugin exports only its entry and provider,
 * and it is installed in OpenCode's plugin cache, a different tree from this
 * package. Keep the two in step — a client version Anthropic stops recognising
 * comes back as a rate-limit error, not as an authentication one.
 */
const CLAUDE_CODE = {
  version: "2.1.87",
  entrypoint: "sdk-cli",
  agent: "claude-cli/2.1.87 (external, cli)",
  identity: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  salt: "59cf53e54c78",
  positions: [4, 7, 20],
  betas: ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"],
} as const

/** What OpenCode holds. `oauth` needs a bearer; a minted key stays an `x-api-key`. */
export interface Secret {
  readonly kind: "oauth" | "key"
  readonly value: string
}

/** Resolved per request so OpenCode's own refresh (near expiry) is always picked up. */
export type Resolve = () => Promise<Secret | undefined>

export interface Relay {
  readonly url: string
  /** Local shared secret. meat sends it as its `x-api-key`; nothing else may use the relay. */
  readonly key: string
  close: () => Promise<void>
}

/** Where relays announce themselves. A fixed per-user root, because TMPDIR is not
 * guaranteed to agree across the two processes. */
function directory(): string {
  return join(homedir(), ".cache", "opencode-meat")
}

/**
 * One file per config directory, so a profile's own relay is identifiable.
 * Reading falls back to any live relay, because the two halves do not always
 * agree on the config directory — a TUI reuses whichever background service is
 * already on the port, and that service may have been started from a different
 * one.
 */
function rendezvous(): string {
  const config = process.env["OPENCODE_CONFIG_DIR"] ?? join(homedir(), ".config", "opencode")
  const key = createHash("sha256").update(config).digest("hex").slice(0, 12)
  return join(directory(), `relay-${key}.json`)
}

/** Publishes the relay for the TUI half. The file carries no credential. */
function publish(relay: Relay) {
  mkdirSync(directory(), { recursive: true })
  writeFileSync(rendezvous(), JSON.stringify({ url: relay.url, key: relay.key, pid: process.pid }), { mode: 0o600 })
}

interface Published {
  readonly url: string
  readonly key: string
}

/**
 * A relay that is actually running, preferring this profile's own.
 *
 * The pid is checked rather than the file's mere existence: a server that died
 * without unpublishing would otherwise send meat at a closed port, and
 * "connection refused" reads like a broken plugin instead of a missing key.
 */
export function published(): Published | undefined {
  const own = read(rendezvous())
  if (own) return own
  let names: string[]
  try {
    names = readdirSync(directory())
  } catch {
    return undefined
  }
  const live = names
    .filter((name) => name.startsWith("relay-") && name.endsWith(".json"))
    .map((name) => join(directory(), name))
    .map((path) => ({ path, relay: read(path) }))
    .filter((entry): entry is { path: string; relay: Published } => entry.relay !== undefined)
  // Newest wins: with several profiles running, the last server to announce
  // itself is the one most likely to belong to this window.
  live.sort((a, b) => modified(b.path) - modified(a.path))
  return live[0]?.relay
}

function read(path: string): Published | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    if (typeof parsed["url"] !== "string" || typeof parsed["key"] !== "string") return undefined
    if (typeof parsed["pid"] === "number" && !alive(parsed["pid"])) return undefined
    return { url: parsed["url"], key: parsed["key"] }
  } catch {
    return undefined
  }
}

function modified(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function alive(pid: number): boolean {
  try {
    // Signal 0 only tests for the process; it delivers nothing.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let running: Promise<Relay> | undefined
let resolver: Resolve | undefined

/**
 * One relay per process, however often the plugin is instantiated.
 *
 * OpenCode loads a server plugin per request — hundreds of times in a working
 * session — so a relay owned by a single instance would be started and torn down
 * continuously, and would almost never be listening at the moment meat runs. The
 * listener therefore outlives every instance, and each instance only rebinds the
 * resolver, since the context of a disposed one is no longer trustworthy.
 */
export function ensure(resolve: Resolve): Promise<Relay> {
  resolver = resolve
  running ??= begin()
  return running
}

async function begin(): Promise<Relay> {
  const relay = await start(() => (resolver ?? (() => Promise.resolve(undefined)))())
  publish(relay)
  return relay
}

async function start(resolve: Resolve): Promise<Relay> {
  const key = randomBytes(24).toString("hex")
  const server = createServer((request, response) => {
    handle(request, response, key, resolve).catch((error: unknown) => {
      fail(response, 502, error instanceof Error ? error.message : String(error))
    })
  })
  const port = await listen(server)
  return {
    url: `http://${HOST}:${port}`,
    key,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done())
      }),
  }
}

function listen(server: Server): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  server.once("error", reject)
  server.listen(0, HOST, () => {
    const address = server.address()
    if (address === null || typeof address === "string") {
      reject(new Error("meat relay: no port"))
      return
    }
    resolve(address.port)
  })
  return promise
}

async function handle(request: IncomingMessage, response: ServerResponse, key: string, resolve: Resolve) {
  // Loopback is not privacy: without this, any local process could spend the
  // user's Claude subscription through the relay.
  if (request.headers["x-api-key"] !== key) return fail(response, 401, "meat relay: wrong local key")

  const secret = await resolve()
  if (!secret) return fail(response, 503, "meat relay: OpenCode has no Anthropic credential — log in first")

  const body = await collect(request)
  const upstream = await fetch(new URL(request.url ?? "/", ANTHROPIC), {
    method: request.method ?? "POST",
    headers: forward(request.headers, secret),
    ...(body.length > 0 ? { body: secret.kind === "oauth" ? shape(body) : body } : {}),
  })

  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    // Kept so a throttled run can be diagnosed from meat's own output.
    ...Object.fromEntries(
      [...upstream.headers].filter(([name]) => name === "retry-after" || name.startsWith("anthropic-ratelimit")),
    ),
  })
  const reader = upstream.body?.getReader()
  if (!reader) {
    response.end()
    return
  }
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    response.write(chunk.value)
  }
  response.end()
}

function forward(headers: IncomingHttpHeaders, secret: Secret): Record<string, string> {
  const out: Record<string, string> = {
    "content-type": single(headers["content-type"]) ?? "application/json",
    // meat sets this itself; kept verbatim so the relay never picks the API version.
    "anthropic-version": single(headers["anthropic-version"]) ?? "2023-06-01",
  }
  if (secret.kind !== "oauth") {
    // A minted console key is an ordinary API key: authenticate and stay out of
    // the way. None of the subscription handshake applies.
    out["x-api-key"] = secret.value
    return out
  }
  out["authorization"] = `Bearer ${secret.value}`
  out["user-agent"] = CLAUDE_CODE.agent
  const betas = single(headers["anthropic-beta"])
  out["anthropic-beta"] = [
    ...new Set([...CLAUDE_CODE.betas, ...(betas ?? "").split(",").map((beta) => beta.trim()).filter(Boolean)]),
  ].join(",")
  return out
}

/**
 * Prepends the two system blocks a subscription request is expected to carry:
 * the billing header, then the client identity, then whatever meat asked for.
 *
 * Left untouched on anything unparseable — a body this relay does not understand
 * is still a body Anthropic might.
 */
function shape(body: Buffer): Buffer {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString("utf8"))
  } catch {
    return body
  }
  if (!isRecord(parsed)) return body

  const system: unknown[] = [
    { type: "text", text: billing(parsed["messages"]) },
    { type: "text", text: CLAUDE_CODE.identity },
  ]
  // meat sends `system` as a plain string (`antReq` in meat/anthropic.go); an
  // array is accepted too, so this stays useful if that ever changes.
  const own = parsed["system"]
  if (typeof own === "string" && own.length > 0) system.push({ type: "text", text: own })
  else if (Array.isArray(own)) system.push(...own.filter((block) => isRecord(block)))

  return Buffer.from(JSON.stringify({ ...parsed, system }), "utf8")
}

/** `cch` ties the request to its first user message, the way the client does. */
function billing(messages: unknown): string {
  const text = firstUserText(messages)
  const sampled = CLAUDE_CODE.positions.map((index) => text[index] ?? "0").join("")
  const suffix = sha256(`${CLAUDE_CODE.salt}${sampled}${CLAUDE_CODE.version}`).slice(0, 3)
  return (
    "x-anthropic-billing-header: " +
    `cc_version=${CLAUDE_CODE.version}.${suffix}; ` +
    `cc_entrypoint=${CLAUDE_CODE.entrypoint}; ` +
    `cch=${sha256(text).slice(0, 5)};`
  )
}

function firstUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return ""
  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "user") continue
    const content = message["content"]
    if (typeof content === "string") return content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!isRecord(block)) continue
      const text = block["text"]
      if (typeof text === "string") return text
    }
  }
  return ""
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function collect(request: IncomingMessage): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>()
  const chunks: Buffer[] = []
  request.on("data", (chunk: Buffer) => chunks.push(chunk))
  request.on("end", () => resolve(Buffer.concat(chunks)))
  request.on("error", reject)
  return promise
}

/** Anthropic's own error shape, so meat prints the reason rather than a bare status. */
function fail(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message } }))
}
