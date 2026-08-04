import type { Plugin } from "@opencode-ai/plugin/tui"
import { createSignal, type Accessor } from "solid-js"
import { errorMessage, runMeat, type MeatConfig, type MeatResult, type Target } from "./meat.js"

export type Destination = Parameters<Plugin.Context["ui"]["router"]["navigate"]>[0]

/** `reading` is meat's thinking phase: a subprocess talking to an LLM per chunk. */
export type Phase =
  | { readonly status: "reading" }
  | { readonly status: "ready"; readonly result: MeatResult }
  | { readonly status: "failed"; readonly message: string }

export interface Run {
  readonly id: string
  readonly config: MeatConfig
  readonly target: Target
  readonly model: string
  readonly startedAt: number
  /** Reactive. */
  readonly phase: Accessor<Phase>
  /** Reactive: true once the diff has been opened, or its notice dismissed. */
  readonly dismissed: Accessor<boolean>
  readonly dismiss: () => void
  /** Where closing the window returns to. Rewritten on every open. */
  returnTo: Destination | undefined
}

/** Enough to keep recent reads reopenable without hoarding diffs for the session's life. */
const HISTORY = 8

/**
 * Runs live here rather than in the route's `data`: the invocation carries a
 * provider API key, and route data is a reconciled store the host may hand back
 * to us across restarts. Keeping them in a signal is what lets the notice above
 * the prompt track a run the user is not looking at.
 */
const [runs, setRuns] = createSignal<readonly Run[]>([])
let sequence = 0

/** Every live run, oldest first. Reactive. */
export function list(): readonly Run[] {
  return runs()
}

export function get(id: string): Run | undefined {
  return runs().find((run) => run.id === id)
}

/**
 * Spawns meat and returns at once, so the TUI stays interactive while it thinks.
 * The returned run's phase is what the notice and the window both render.
 */
export function begin(input: {
  readonly config: MeatConfig
  readonly target: Target
  readonly directory: string
  readonly model: string
}): Run {
  const [phase, setPhase] = createSignal<Phase>({ status: "reading" })
  const [dismissed, setDismissed] = createSignal(false)
  const run: Run = {
    id: `run-${(sequence += 1)}`,
    config: input.config,
    target: input.target,
    model: input.model,
    startedAt: Date.now(),
    phase,
    dismissed,
    dismiss: () => setDismissed(true),
    returnTo: undefined,
  }
  runMeat(input.config, input.target, input.directory).then(
    (result) => setPhase({ status: "ready", result }),
    (error: unknown) => setPhase({ status: "failed", message: errorMessage(error) }),
  )
  setRuns((previous) => trim([...previous, run]))
  return run
}

export function clear() {
  setRuns([])
}

/** Drops the oldest finished runs; a run still reading is never forgotten. */
function trim(all: readonly Run[]): readonly Run[] {
  let excess = all.length - HISTORY
  if (excess <= 0) return all
  return all.filter((run) => {
    if (excess <= 0 || run.phase().status === "reading") return true
    excess -= 1
    return false
  })
}
