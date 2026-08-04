import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * meat only ever authenticates with `x-api-key` (`meat/anthropic.go`), and
 * Anthropic answers `401 invalid x-api-key` when that carries a subscription
 * OAuth token — which is every credential `@suiramdev/opencode-anthropic-auth`
 * stores for a Claude Pro/Max login. OpenCode also keeps such a credential
 * server-side and never hands it to the TUI, so meat cannot be given a key at
 * all: hence "AnthropicModel.APIKey is empty".
 *
 * So meat is pointed at a loopback relay instead. It swaps the header for
 * whatever the credential actually is, and forwards untouched.
 *
 * Deliberately no Claude Code impersonation. A Max token was verified against
 * api.anthropic.com to need none of it: bearer alone returns 200, with no
 * identity system prompt, no client fingerprint and no user-agent spoof. Only
 * the documented OAuth beta is added.
 */
const ANTHROPIC = "https://api.anthropic.com"
const OAUTH_BETA = "oauth-2025-04-20"
const HOST = "127.0.0.1"

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

/**
 * The two halves meet on disk: the credential is only reachable from the server
 * plugin, and meat is spawned by the TUI. A fixed per-user path, because TMPDIR
 * is not guaranteed to agree across the two processes.
 */
function rendezvous(): string {
  return join(homedir(), ".cache", "opencode-meat", "relay.json")
}

/** Publishes the relay for the TUI half. The file carries no credential. */
export function publish(relay: Relay) {
  const path = rendezvous()
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify({ url: relay.url, key: relay.key, pid: process.pid }), { mode: 0o600 })
}

export function unpublish() {
  rmSync(rendezvous(), { force: true })
}

/** The relay this machine is running, if any. Read by the TUI half. */
export function published(): { readonly url: string; readonly key: string } | undefined {
  let raw: string
  try {
    raw = readFileSync(rendezvous(), "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed["url"] !== "string" || typeof parsed["key"] !== "string") return undefined
    return { url: parsed["url"], key: parsed["key"] }
  } catch {
    return undefined
  }
}

export async function start(resolve: Resolve): Promise<Relay> {
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
    ...(body.length > 0 ? { body } : {}),
  })

  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
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
  if (secret.kind === "oauth") {
    out["authorization"] = `Bearer ${secret.value}`
    const betas = single(headers["anthropic-beta"])
    out["anthropic-beta"] = betas ? [...new Set([OAUTH_BETA, ...betas.split(",").map((b) => b.trim())])].join(",") : OAUTH_BETA
  } else {
    out["x-api-key"] = secret.value
  }
  return out
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
