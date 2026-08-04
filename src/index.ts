import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Plugin } from "@opencode-ai/plugin"

const execFileAsync = promisify(execFile)

/** meat's `-json` wire form: `meat.Result` plus the machine-computed elision manifest. */
interface MeatResult {
  readonly summary: string
  readonly smart_diff: string
  readonly elision?: string
  readonly input_tokens: number
  readonly output_tokens: number
}

interface MeatConfig {
  readonly binary: string
  readonly model?: string
  readonly noCache: boolean
  readonly env: Record<string, string>
}

/** Which diff meat should read. Mirrors `readDiff` in cmd/meat/main.go. */
type Target = { readonly kind: "revision"; readonly revision: string } | { readonly kind: "staged" } | { readonly kind: "worktree" }

const INSTALL_HINT = "Install it with: go install meat.dev/cmd/meat@latest"

/** meat chunks large diffs and talks to an LLM per chunk; cache hits return instantly. */
const TIMEOUT_MS = 15 * 60 * 1000
const MAX_BUFFER = 64 * 1024 * 1024
const MAX_STDERR = 2000

function readConfig(options: Readonly<Record<string, any>>): MeatConfig {
  const env: Record<string, string> = {}
  const raw = options["env"]
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") env[key] = value
    }
  }
  return {
    binary: typeof options["binary"] === "string" && options["binary"].length > 0 ? options["binary"] : "meat",
    model: typeof options["model"] === "string" && options["model"].length > 0 ? options["model"] : undefined,
    noCache: options["noCache"] === true,
    env,
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

async function runMeat(config: MeatConfig, target: Target, directory: string): Promise<MeatResult> {
  const args = [
    ...(config.model ? ["-model", config.model] : []),
    ...(config.noCache ? ["-no-cache"] : []),
    "-json",
    ...targetArgs(target),
  ]

  let stdout: string
  try {
    // execFile, never a shell: revision strings are user input and must not be interpolated.
    const result = await execFileAsync(config.binary, args, {
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

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`unexpected meat output (not JSON): ${stdout.slice(0, 500)}`)
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`unexpected meat output (not an object): ${stdout.slice(0, 500)}`)
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

function parseTarget(input: unknown): Target {
  const record = (input ?? {}) as Record<string, unknown>
  const revision = typeof record["revision"] === "string" && record["revision"].trim().length > 0 ? record["revision"].trim() : undefined
  const staged = record["staged"] === true
  const worktree = record["worktree"] === true

  if (staged && worktree) throw new Error("staged and worktree are mutually exclusive")
  if ((staged || worktree) && revision) throw new Error("staged/worktree cannot be combined with a revision")
  if (staged) return { kind: "staged" }
  if (worktree) return { kind: "worktree" }
  return { kind: "revision", revision: revision ?? "HEAD" }
}

function formatResult(result: MeatResult): string {
  const header: string[] = []
  if (result.summary) header.push(`# ${result.summary}`)
  if (result.elision) header.push(`# ${result.elision}`)

  const diff = result.smart_diff.trim()
  if (!diff) return [...header, "", "(no meaningful change to read)"].join("\n")
  return [...header, "", "```diff", diff, "```"].join("\n")
}

export default Plugin.define({
  id: "meat.reading-diff",
  setup: async (ctx) => {
    const config = readConfig(ctx.options)

    const tool = await ctx.tool.transform((tools) => {
      tools.add({
        name: "meat",
        // Direct provider exposure: the /meat command wants one deterministic
        // call, not a CodeMode script. CodeMode would also namespace it "tools.meat".
        options: { codemode: false },
        description:
          "Abridge a git diff into a reading diff using meat.dev. " +
          "Omit all fields to review HEAD. Provide `revision` for a commit or range " +
          "(e.g. 'abc123', 'HEAD~3', 'main...HEAD'), or set `staged`/`worktree`.",
        input: {
          type: "object",
          properties: {
            revision: { type: "string", description: "Commit, revision, or range (sha, HEAD~3, main...HEAD)" },
            staged: { type: "boolean", description: "Abridge the staged (index) changes" },
            worktree: { type: "boolean", description: "Abridge the unstaged working-tree changes" },
          },
          additionalProperties: false,
        },
        execute: async (input, tctx) => {
          const target = parseTarget(input)
          const directory = await resolveDirectory(ctx, tctx.sessionID)
          const result = await runMeat(config, target, directory)
          return {
            content: formatResult(result),
            metadata: {
              summary: result.summary,
              elision: result.elision,
              input_tokens: result.input_tokens,
              output_tokens: result.output_tokens,
            },
          }
        },
      })
    })

    const command = await ctx.command.transform((commands) => {
      commands.update("meat", (draft) => {
        draft.description = "Read an abridged reading diff of a commit (meat.dev)"
        draft.template =
          'Call the meat tool with these arguments: "$ARGUMENTS"' +
          ' (map "-staged" to staged:true, "-w" to worktree:true, anything else to revision;' +
          " empty means no arguments, which reads HEAD)." +
          " Then reply with EXACTLY the tool output, unmodified — the summary lines followed by the" +
          " fenced diff. Do not add commentary or analysis, do not reformat the diff, and do not wrap" +
          " the output in an additional code fence."
      })
    })

    return async () => {
      await tool.dispose()
      await command.dispose()
    }
  },
})

async function resolveDirectory(ctx: Plugin.Context, sessionID: string): Promise<string> {
  try {
    const session = await ctx.session.get({ sessionID })
    if (session.location?.directory) return session.location.directory
  } catch {
    // Fall through: a server-side lookup failure should not block the diff.
  }
  return process.cwd()
}
