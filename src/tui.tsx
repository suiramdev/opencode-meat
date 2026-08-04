/** @jsxImportSource @opentui/solid */
import type { ModelInfo, ProviderInfo } from "@opencode-ai/client"
import type { Plugin } from "@opencode-ai/plugin/tui"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import {
  describeTarget,
  errorMessage,
  meatArgs,
  parseArguments,
  readConfig,
  type MeatConfig,
  type MeatResult,
  type Target,
} from "./meat.js"
import { planInvocation } from "./provider.js"
import * as Runs from "./runs.js"

const ROUTE = "meat"
const DEFAULT_MODEL = "\u0000default"

export default {
  id: "meat",
  setup(ctx: Plugin.Context) {
    const dispose = ctx.ui.router.register({
      name: ROUTE,
      render: (input) => <Page ctx={ctx} run={Runs.get(String(input.data?.["run"] ?? ""))} />,
    })
    const slots = [
      // The command layer lives in the always-mounted `app` slot so `/meat` works
      // from every route, exactly like the built-in diff viewer.
      ctx.ui.slot("app", () => <Commands ctx={ctx} />),
      // meat thinks in a subprocess and the user keeps typing, so its progress
      // belongs directly above the prompt rather than in a window they'd have to
      // sit in. The home slot covers the route with no composer.
      ctx.ui.slot("session.composer.top", () => <Notices ctx={ctx} />),
      ctx.ui.slot("home.footer", () => <Notices ctx={ctx} />),
    ]
    return () => {
      for (const unslot of slots) unslot()
      dispose()
      Runs.clear()
    }
  },
} satisfies Plugin.Definition

function Commands(props: { readonly ctx: Plugin.Context }) {
  const [stored, store] = props.ctx.storage.store("model", { initial: { ref: "" } })

  props.ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "meat.open",
        title: "Read an abridged diff (meat)",
        description: "meat <revision> | -staged | -w",
        group: "Meat",
        palette: true,
        slash: { name: "meat", arguments: true },
        run: (input) => start(props.ctx, input, stored.ref, (ref) => store((draft) => void (draft.ref = ref))),
      },
      {
        id: "meat.show",
        title: "Open a meat reading diff",
        description: "Open the diff meat finished reading, as often as you like",
        group: "Meat",
        palette: true,
        bind: "<leader>d",
        slash: { name: "meat-diff" },
        enabled: () => Runs.list().length > 0,
        run: () => show(props.ctx),
      },
      {
        id: "meat.dismiss",
        title: "Dismiss the meat notices",
        description: "Clears the finished notices above the prompt; the diffs stay open-able",
        group: "Meat",
        palette: true,
        enabled: () => Runs.list().some(retirable),
        run: () => {
          for (const run of Runs.list()) if (retirable(run)) run.dismiss()
        },
      },
    ],
  }))
  return null
}

/** A notice is only worth clearing once its run stopped moving. */
function retirable(run: Runs.Run): boolean {
  return !run.dismissed() && run.phase().status !== "reading"
}

async function start(
  ctx: Plugin.Context,
  input: string | undefined,
  remembered: string,
  remember: (ref: string) => void,
) {
  let target: Target
  try {
    target = parseArguments(input)
  } catch (error) {
    ctx.ui.toast.show({ variant: "error", title: "meat", message: errorMessage(error) })
    return
  }

  const config = readConfig(ctx.options)
  const choice = await pickModel(ctx, config, remembered)
  // Cancelled: no run, no prompt, no subprocess.
  if (!choice) return
  remember(choice.ref)

  // Nothing navigates: the picker closes, the prompt keeps focus, and meat reads
  // in the background until its notice says the diff is ready.
  ctx.ui.dialog.clear()
  Runs.begin({
    config: choice.config,
    target,
    directory: (ctx.location ?? ctx.data.location.default()).directory,
    model: choice.label,
  })
}

async function show(ctx: Plugin.Context) {
  // Newest first: the run you just watched finish is the one you meant.
  const finished = Runs.list()
    .filter((run) => run.phase().status !== "reading")
    .reverse()
  if (finished.length === 0) {
    const reading = Runs.list().at(-1)
    ctx.ui.toast.show({
      variant: "info",
      title: "meat",
      message: reading ? `still reading ${describeTarget(reading.target)}…` : "no diff read yet — run /meat first",
    })
    return
  }
  const run = finished.length === 1 ? finished[0] : await pickRun(ctx, finished)
  if (!run) return
  run.dismiss()
  // Recorded per open, not per run: closing goes back where this open came from.
  run.returnTo = returnable(ctx)
  ctx.ui.dialog.clear()
  ctx.ui.router.navigate({ type: "plugin", name: ROUTE, data: { run: run.id } })
}

async function pickRun(ctx: Plugin.Context, finished: readonly Runs.Run[]): Promise<Runs.Run | undefined> {
  const picked = await ctx.ui.dialog.select<string>({
    title: "meat diffs",
    placeholder: "Which reading diff?",
    options: finished.map((run) => {
      const phase = run.phase()
      return {
        title: describeTarget(run.target),
        value: run.id,
        description:
          phase.status === "ready"
            ? `${run.model} · ${phase.result.summary}`
            : `${run.model} · failed: ${firstLine(phase.status === "failed" ? phase.message : "")}`,
      }
    }),
    current: finished[0]?.id,
  })
  return picked === undefined ? undefined : finished.find((run) => run.id === picked)
}

function returnable(ctx: Plugin.Context): Runs.Destination {
  const route = ctx.ui.router.current()
  if (route.type === "session") return { type: "session", sessionID: route.sessionID }
  if (route.type === "plugin") {
    return { type: "plugin", id: route.id, name: route.name, ...(route.data ? { data: { ...route.data } } : {}) }
  }
  return { type: "home" }
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const TICK_MS = 100

function Notices(props: { readonly ctx: Plugin.Context }) {
  const visible = createMemo(() => Runs.list().filter((run) => !run.dismissed()))
  const reading = createMemo(() => visible().some((run) => run.phase().status === "reading"))
  // One clock for every notice; the spinner frame and each elapsed time fall out
  // of it, and it only ticks while something is actually being read.
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!reading()) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    onCleanup(() => clearInterval(timer))
  })
  // Read from the keymap so a rebound (or unbound) shortcut still reads true.
  const hint = createMemo(() => props.ctx.keymap.shortcuts("meat.show")[0] ?? "/meat-diff")

  return (
    <Show when={visible().length}>
      <box flexDirection="column" paddingLeft={3} paddingRight={3} paddingBottom={1}>
        <For each={visible()}>{(run) => <Notice ctx={props.ctx} run={run} now={now} hint={hint} />}</For>
      </box>
    </Show>
  )
}

function Notice(props: {
  readonly ctx: Plugin.Context
  readonly run: Runs.Run
  readonly now: () => number
  readonly hint: () => string
}) {
  const theme = () => props.ctx.theme
  const target = () => describeTarget(props.run.target)
  const failure = createMemo(() => {
    const phase = props.run.phase()
    return phase.status === "failed" ? firstLine(phase.message) : undefined
  })
  const label = createMemo(() => {
    if (props.run.phase().status === "reading") {
      const frame = SPINNER[Math.floor(props.now() / TICK_MS) % SPINNER.length]
      return `${frame} meat is reading ${target()} · ${elapsed(props.now() - props.run.startedAt)}`
    }
    return `meat read ${target()} · ${props.hint()} to open`
  })

  return (
    <Show
      when={failure()}
      fallback={
        <text fg={theme().text.subdued} wrapMode="none">
          {label()}
        </text>
      }
    >
      {(failed: () => string) => (
        <text fg={theme().text.feedback.error.default} wrapMode="none">
          meat failed on {target()} · {failed()}
        </text>
      )}
    </Show>
  )
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
}

function firstLine(text: string): string {
  return text.split("\n")[0] || text
}

interface Choice {
  readonly ref: string
  readonly label: string
  readonly config: MeatConfig
}

async function pickModel(ctx: Plugin.Context, config: MeatConfig, remembered: string): Promise<Choice | undefined> {
  const location = ctx.location ?? ctx.data.location.default()
  await Promise.all([ctx.data.location.provider.sync(location), ctx.data.location.model.sync(location)])
  const providers = new Map<string, ProviderInfo>()
  for (const provider of ctx.data.location.provider.list(location) ?? []) providers.set(provider.id, provider)

  const fallback: Choice = {
    ref: DEFAULT_MODEL,
    label: config.model ?? "meat default",
    config,
  }
  const choices = new Map<string, Choice>([[fallback.ref, fallback]])
  const options: Array<{ title: string; value: string; category?: string; description?: string }> = [
    {
      title: fallback.label,
      value: fallback.ref,
      category: "meat",
      description: config.model
        ? "Configured in the plugin options"
        : "meat's own default, from $MEAT_MODEL or its built-in",
    },
  ]

  const models = [...(ctx.data.location.model.list(location) ?? [])].sort(byProviderThenName(providers))
  let hidden = 0
  for (const model of models) {
    if (!model.enabled) continue
    const provider = providers.get(model.providerID)
    const plan = planInvocation(model, provider)
    if (!plan) {
      // dialog.select drops disabled options outright, so an unreachable model
      // is left out and only counted.
      hidden += 1
      continue
    }
    const category = provider?.name ?? model.providerID
    choices.set(model.id, {
      ref: model.id,
      label: `${category} / ${model.name}`,
      // Plugin options win over the derived transport so a user can always
      // override a provider meat cannot be taught about.
      config: { ...config, model: plan.model, env: { ...plan.env, ...config.env } },
    })
    // OpenCode hides credentials it injects at request time (OAuth logins, for
    // instance), so say which variable meat will fall back to rather than let it
    // look like the model is simply broken.
    const variable = plan.transport === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"
    const transport = plan.transport === "anthropic" ? "Anthropic Messages" : "OpenAI Responses"
    options.push({
      title: model.name,
      value: model.id,
      category,
      description:
        variable in plan.env
          ? `${transport} · ${plan.model}`
          : `${transport} · ${plan.model} · needs $${variable}`,
    })
  }

  const picked = await ctx.ui.dialog.select<string>({
    title: "meat model",
    placeholder:
      hidden === 0
        ? "Which model should read the diff?"
        : `Which model should read the diff? ${hidden} hidden — meat only speaks the Anthropic Messages and OpenAI Responses APIs.`,
    options,
    current: choices.has(remembered) ? remembered : fallback.ref,
  })
  if (picked === undefined) return undefined
  return choices.get(picked)
}

function byProviderThenName(providers: ReadonlyMap<string, ProviderInfo>) {
  return (a: ModelInfo, b: ModelInfo) => {
    const left = providers.get(a.providerID)?.name ?? a.providerID
    const right = providers.get(b.providerID)?.name ?? b.providerID
    return left === right ? a.name.localeCompare(b.name) : left.localeCompare(right)
  }
}

function Page(props: { readonly ctx: Plugin.Context; readonly run: Runs.Run | undefined }) {
  const theme = () => props.ctx.theme.contextual.elevated
  const phase = () => props.run?.phase()
  let scroll: ScrollBoxRenderable | undefined

  const close = () => {
    props.ctx.ui.dialog.clear()
    props.ctx.ui.router.navigate(props.run?.returnTo ?? { type: "home" })
  }

  props.ctx.keymap.layer(() => ({
    commands: [
      { id: "meat.close", title: "Close the meat diff", group: "Meat", bind: "escape,q", run: close },
      {
        id: "meat.down",
        title: "Scroll the meat diff down",
        group: "Meat",
        bind: "j,down",
        run: () => scroll?.scrollBy(1),
      },
      { id: "meat.up", title: "Scroll the meat diff up", group: "Meat", bind: "k,up", run: () => scroll?.scrollBy(-1) },
      {
        id: "meat.page.down",
        title: "Page the meat diff down",
        group: "Meat",
        bind: "pagedown,ctrl+f",
        run: () => scroll?.scrollBy(1, "viewport"),
      },
      {
        id: "meat.page.up",
        title: "Page the meat diff up",
        group: "Meat",
        bind: "pageup,ctrl+b",
        run: () => scroll?.scrollBy(-1, "viewport"),
      },
      {
        // No jump-to-end counterpart: the scrollbox only measures the content it
        // has already scrolled over, so a single large delta clamps short.
        id: "meat.top",
        title: "Jump to the top of the meat diff",
        group: "Meat",
        bind: "g",
        run: () => scroll?.scrollTo(0),
      },
    ],
  }))

  const failure = createMemo(() => {
    const current = phase()
    return current?.status === "failed" ? current.message : undefined
  })
  const result = createMemo(() => {
    const current = phase()
    return current?.status === "ready" ? current.result : undefined
  })
  const lines = createMemo(() => {
    const current = result()
    return current ? classify(current.smart_diff) : []
  })

  return (
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <box flexDirection="row" gap={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
        <text fg={theme().text.default}>meat</text>
        <text fg={theme().text.subdued}>{props.run ? describeTarget(props.run.target) : "no run"}</text>
        <box flexGrow={1} />
        <text fg={theme().text.subdued}>{props.run?.model ?? ""}</text>
      </box>
      <Switch>
        <Match when={!props.run}>
          <box flexGrow={1} paddingLeft={1}>
            <text fg={theme().text.subdued}>This diff is gone. Run /meat again.</text>
          </box>
        </Match>
        <Match when={phase()?.status === "reading"}>
          <box flexGrow={1} paddingLeft={1}>
            <text fg={theme().text.subdued}>
              Reading {props.run ? describeTarget(props.run.target) : ""} — meat is thinking…
            </text>
          </box>
        </Match>
        <Match when={failure()}>
          {(failed: () => string) => (
            <box flexGrow={1} paddingLeft={1} flexDirection="column">
              <text fg={theme().text.feedback.error.default}>{failed()}</text>
              <text fg={theme().text.subdued}>
                {props.run
                  ? `${props.run.config.binary} ${meatArgs(props.run.config, props.run.target).join(" ")}`
                  : ""}
              </text>
            </box>
          )}
        </Match>
        <Match when={result()}>
          {(loaded: () => MeatResult) => (
            <box flexGrow={1} minHeight={0} flexDirection="column">
              <box flexShrink={0} paddingLeft={1} paddingRight={1} flexDirection="column">
                <text fg={theme().text.default}>{loaded().summary}</text>
                <Show when={loaded().elision}>
                  {(elision: () => string) => <text fg={theme().text.subdued}>{elision()}</text>}
                </Show>
              </box>
              <scrollbox
                ref={(element: ScrollBoxRenderable) => (scroll = element)}
                flexGrow={1}
                minHeight={0}
                verticalScrollbarOptions={{ visible: false }}
                horizontalScrollbarOptions={{ visible: false }}
              >
                <Show
                  when={lines().length}
                  fallback={<text fg={theme().text.subdued}>(no meaningful change to read)</text>}
                >
                  <For each={lines()}>
                    {(line) => (
                      <text
                        fg={color(props.ctx, line.kind)}
                        bg={background(props.ctx, line.kind)}
                        wrapMode="none"
                      >
                        {line.text}
                      </text>
                    )}
                  </For>
                </Show>
              </scrollbox>
              <box flexShrink={0} flexDirection="row" gap={2} paddingLeft={1}>
                <text fg={theme().text.subdued}>j/k scroll</text>
                <text fg={theme().text.subdued}>ctrl+f/b page</text>
                <text fg={theme().text.subdued}>g top</text>
                <text fg={theme().text.subdued}>esc close</text>
                <box flexGrow={1} />
                <text fg={theme().text.subdued}>
                  {loaded().input_tokens} in / {loaded().output_tokens} out
                </text>
              </box>
            </box>
          )}
        </Match>
      </Switch>
    </box>
  )
}

type LineKind = "added" | "removed" | "hunk" | "file" | "context"

interface Line {
  readonly text: string
  readonly kind: LineKind
}

/**
 * meat emits a *reading* diff: hunk counts are deliberately stale once elided
 * lines are dropped, so a real unified-diff parser would reject it. Classifying
 * by leading marker is both sufficient and immune to that.
 */
function classify(diff: string): Line[] {
  const trimmed = diff.replace(/\n+$/, "")
  if (!trimmed) return []
  return trimmed.split("\n").map((text) => {
    if (text.startsWith("@@")) return { text, kind: "hunk" as const }
    if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff ") || text.startsWith("index ")) {
      return { text, kind: "file" as const }
    }
    if (text.startsWith("+")) return { text, kind: "added" as const }
    if (text.startsWith("-")) return { text, kind: "removed" as const }
    return { text, kind: "context" as const }
  })
}

function color(ctx: Plugin.Context, kind: LineKind) {
  const theme = ctx.theme.contextual.elevated
  switch (kind) {
    case "added":
      return theme.diff.text.added
    case "removed":
      return theme.diff.text.removed
    case "hunk":
      return theme.diff.text.hunkHeader
    case "file":
      return theme.text.default
    case "context":
      return theme.diff.text.context
  }
}

function background(ctx: Plugin.Context, kind: LineKind) {
  const theme = ctx.theme.contextual.elevated
  if (kind === "added") return theme.diff.background.added
  if (kind === "removed") return theme.diff.background.removed
  return undefined
}
