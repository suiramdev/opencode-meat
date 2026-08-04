import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** meat's `-json` wire form: `meat.Result` plus the machine-computed elision manifest. */
export interface MeatResult {
  readonly summary: string
  readonly smart_diff: string
  readonly elision?: string
  readonly input_tokens: number
  readonly output_tokens: number
}

export interface MeatConfig {
  readonly binary: string
  readonly model?: string
  readonly noCache: boolean
  readonly env: Record<string, string>
}

/** Which diff meat should read. Mirrors `readDiff` in cmd/meat/main.go. */
export type Target =
  | { readonly kind: "revision"; readonly revision: string }
  | { readonly kind: "staged" }
  | { readonly kind: "worktree" }

export const INSTALL_HINT = "Install it with: go install meat.dev/cmd/meat@latest"

/** meat chunks large diffs and talks to an LLM per chunk; cache hits return instantly. */
const TIMEOUT_MS = 15 * 60 * 1000
const MAX_BUFFER = 64 * 1024 * 1024
const MAX_STDERR = 2000

export function readConfig(options: Readonly<Record<string, any>>): MeatConfig {
  const binary = options["binary"]
  const model = options["model"]
  return {
    binary: typeof binary === "string" && binary.length > 0 ? binary : "meat",
    model: typeof model === "string" && model.length > 0 ? model : undefined,
    noCache: options["noCache"] === true,
    env: readEnv(options["env"]),
  }
}

function readEnv(raw: unknown): Record<string, string> {
  const env: Record<string, string> = {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return env
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value
  }
  return env
}

export function describeTarget(target: Target): string {
  switch (target.kind) {
    case "staged":
      return "staged changes"
    case "worktree":
      return "working tree"
    case "revision":
      return target.revision
  }
}

function targetArgs(target: Target): string[] {
  switch (target.kind) {
    case "staged":
      return ["-staged"]
    case "worktree":
      return ["-w"]
    case "revision":
      // Always explicit: with no revision meat falls back to stdin whenever stdin
      // is not a terminal, which is exactly the case for a spawned subprocess.
      return [target.revision]
  }
}

/** The exact argv meat is spawned with. Exposed so the TUI can show what it ran. */
export function meatArgs(config: MeatConfig, target: Target): string[] {
  return [
    ...(config.model ? ["-model", config.model] : []),
    ...(config.noCache ? ["-no-cache"] : []),
    "-json",
    ...targetArgs(target),
  ]
}

export async function runMeat(config: MeatConfig, target: Target, directory: string): Promise<MeatResult> {
  let stdout: string
  try {
    // execFile, never a shell: revision strings are user input and must not be interpolated.
    const result = await execFileAsync(config.binary, meatArgs(config, target), {
      cwd: directory,
      env: { ...process.env, ...config.env },
      maxBuffer: MAX_BUFFER,
      timeout: TIMEOUT_MS,
      encoding: "utf8",
    })
    stdout = result.stdout
  } catch (error) {
    throw new Error(describeFailure(error, config.binary))
  }
  return parseResult(stdout)
}

function parseResult(stdout: string): MeatResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`unexpected meat output (not JSON): ${stdout.slice(0, 500)}`)
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`unexpected meat output (not an object): ${stdout.slice(0, 500)}`)
  }
  const record = parsed as Record<string, unknown>
  if (typeof record["smart_diff"] !== "string" || typeof record["summary"] !== "string") {
    throw new Error(`unexpected meat output (missing summary/smart_diff): ${stdout.slice(0, 500)}`)
  }
  return {
    summary: record["summary"],
    smart_diff: record["smart_diff"],
    elision: typeof record["elision"] === "string" ? record["elision"] : undefined,
    input_tokens: typeof record["input_tokens"] === "number" ? record["input_tokens"] : 0,
    output_tokens: typeof record["output_tokens"] === "number" ? record["output_tokens"] : 0,
  }
}

function describeFailure(error: unknown, binary: string): string {
  const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: string }
  if (err?.code === "ENOENT") return `meat binary not found (looked for "${binary}"). ${INSTALL_HINT}`
  if (err?.killed) return `meat timed out after ${TIMEOUT_MS / 60000} minutes (binary "${binary}")`
  // meat reports every failure as `meat: <error>` on stderr — missing API key,
  // "no diff to read", bad revision — so surface that verbatim.
  const stderr = (err?.stderr ?? "").trim()
  if (stderr) return stderr.length > MAX_STDERR ? `…${stderr.slice(-MAX_STDERR)}` : stderr
  return err?.message ?? String(error)
}

/** meat's own failures already read as prose; anything else falls back to its text. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Tool input: `{ revision?, staged?, worktree? }`. */
export function parseTarget(input: unknown): Target {
  const record = (input ?? {}) as Record<string, unknown>
  const raw = typeof record["revision"] === "string" ? record["revision"].trim() : ""
  const revision = raw.length > 0 ? raw : undefined
  const staged = record["staged"] === true
  const worktree = record["worktree"] === true

  if (staged && worktree) throw new Error("staged and worktree are mutually exclusive")
  if ((staged || worktree) && revision) throw new Error("staged/worktree cannot be combined with a revision")
  if (staged) return { kind: "staged" }
  if (worktree) return { kind: "worktree" }
  return { kind: "revision", revision: revision ?? "HEAD" }
}

/** Slash input: the raw `/meat …` argument string, in meat's own CLI spelling. */
export function parseArguments(input: string | undefined): Target {
  const args = (input ?? "").trim().split(/\s+/).filter(Boolean)
  if (args.length === 0) return { kind: "revision", revision: "HEAD" }
  if (args.length > 1) throw new Error(`expected one revision, got ${args.length}: ${args.join(" ")}`)
  const [arg] = args as [string]
  if (arg === "-staged" || arg === "--staged") return { kind: "staged" }
  if (arg === "-w" || arg === "--worktree") return { kind: "worktree" }
  if (arg.startsWith("-")) throw new Error(`unknown flag "${arg}" (expected a revision, -staged, or -w)`)
  return { kind: "revision", revision: arg }
}

/** Markdown rendering, for the agent-facing tool. The TUI renders the diff itself. */
export function formatResult(result: MeatResult): string {
  const header: string[] = []
  if (result.summary) header.push(`# ${result.summary}`)
  if (result.elision) header.push(`# ${result.elision}`)

  const diff = result.smart_diff.trim()
  if (!diff) return [...header, "", "(no meaningful change to read)"].join("\n")
  return [...header, "", "```diff", diff, "```"].join("\n")
}
