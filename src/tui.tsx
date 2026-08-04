/** @jsxImportSource @opentui/solid */
import type { ModelInfo, ProviderInfo } from "@opencode-ai/client"
import type { Plugin } from "@opencode-ai/plugin/tui"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import {
  describeTarget,
  meatArgs,
  parseArguments,
  readConfig,
  runMeat,
  type MeatConfig,
  type MeatResult,
  type Target,
} from "./meat.js"
import { planInvocation } from "./provider.js"

const ROUTE = "meat"
const DEFAULT_MODEL = "\u0000default"

type Destination = Parameters<Plugin.Context["ui"]["router"]["navigate"]>[0]

interface Run {
  readonly config: MeatConfig
  readonly target: Target
  readonly directory: string
  readonly model: string
  readonly returnTo: Destination
  readonly result: Promise<MeatResult>
}

/**
 * Runs are keyed out of band instead of travelling in the route's `data`: the
 * invocation carries a provider API key, and route data is a reconciled store
 * the host may hand back to us across restarts.
 */
const runs = new Map<string, Run>()

export default {
  id: "meat",
  setup(ctx: Plugin.Context) {
    const dispose = ctx.ui.router.register({
      name: ROUTE,
      render: (input) => <Page ctx={ctx} run={runs.get(String(input.data?.["run"] ?? ""))} />,
    })
    // The command layer lives in the always-mounted `app` slot so `/meat` works
    // from every route, exactly like the built-in diff viewer.
    const unslot = ctx.ui.slot("app", () => <Commands ctx={ctx} />)
    return () => {
      unslot()
      dispose()
      runs.clear()
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
    ],
  }))
  return null
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
    ctx.ui.toast.show({ variant: "error", title: "meat", message: message(error) })
    return
  }

  const config = readConfig(ctx.options)
  const choice = await pickModel(ctx, config, remembered)
  // Cancelled: no window, no prompt, no subprocess.
  if (!choice) return
  remember(choice.ref)

  const directory = (ctx.location ?? ctx.data.location.default()).directory
  const id = `${Date.now().toString(36)}-${runs.size}`
  const run: Run = {
    config: choice.config,
    target,
    directory,
    model: choice.label,
    returnTo: returnable(ctx),
    // Started here rather than in the page so a remount never re-runs meat.
    result: runMeat(choice.config, target, directory),
  }
  // A rejected promise with no reader yet would be an unhandled rejection.
  run.result.catch(() => {})
  runs.set(id, run)

  ctx.ui.dialog.clear()
  ctx.ui.router.navigate({ type: "plugin", name: ROUTE, data: { run: id } })
}

function returnable(ctx: Plugin.Context): Destination {
  const route = ctx.ui.router.current()
  if (route.type === "session") return { type: "session", sessionID: route.sessionID }
  if (route.type === "plugin") {
    return { type: "plugin", id: route.id, name: route.name, ...(route.data ? { data: { ...route.data } } : {}) }
  }
  return { type: "home" }
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

type State =
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly result: MeatResult }
  | { readonly status: "error"; readonly message: string }

function Page(props: { readonly ctx: Plugin.Context; readonly run: Run | undefined }) {
  const theme = () => props.ctx.theme.contextual.elevated
  // Deliberately not createResource: reading an errored resource throws into the
  // host's plugin error boundary, which would replace the page with a toast.
  const [state, setState] = createSignal<State>({ status: "loading" })
  createEffect(() => {
    const run = props.run
    if (!run) return
    run.result.then(
      (result) => setState({ status: "ok", result }),
      (error: unknown) => setState({ status: "error", message: message(error) }),
    )
  })
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
    const current = state()
    return current.status === "error" ? current.message : undefined
  })
  const result = createMemo(() => {
    const current = state()
    return current.status === "ok" ? current.result : undefined
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
        <Match when={state().status === "loading"}>
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
