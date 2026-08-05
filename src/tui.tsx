/** @jsxImportSource @opentui/solid */
import type { ModelInfo, ProviderInfo } from "@opencode-ai/client"
import type { Plugin } from "@opencode-ai/plugin/tui"
import { generateSyntax } from "@opencode-ai/theme/tui"
import type { ScrollBoxRenderable, SyntaxStyle } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { readingDiff, type ReadingFile } from "./diff.js"
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
import * as OAuth from "./oauth.js"
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
      // belongs next to the prompt rather than in a window they'd have to sit in.
      //
      // This is the only additive prompt-side slot. `prompt.footer.end` and
      // `home.footer` are `replace` slots a built-in already claims — mounting
      // there wins the slot and silently deletes OpenCode's own footer (context
      // usage, cost, subagent and shell counts). Routes with no composer are
      // covered by the toasts in `Commands` instead.
      ctx.ui.slot("session.composer.top", () => <Notices ctx={ctx} />),
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

  // The notice is the normal channel, but it lives above a composer the user may
  // not be looking at — and on routes with no composer there is no notice at all.
  // This slot is always mounted, so a toast from here always lands, whichever
  // route is up.
  const announced = new Set<string>()
  createEffect(() => {
    for (const run of Runs.list()) {
      const phase = run.phase()
      if (phase.status === "reading" || announced.has(run.id)) continue
      announced.add(run.id)
      if (phase.status === "failed") {
        props.ctx.ui.toast.show({
          variant: "error",
          title: `meat · ${describeTarget(run.target)}`,
          message: firstLine(phase.message),
        })
        continue
      }
      props.ctx.ui.toast.show({
        variant: "success",
        title: `meat read ${describeTarget(run.target)}`,
        // The whole point of the toast: say how to read what was just read.
        message: `${openHint(props.ctx)} to open · ${firstLine(phase.result.summary)}`,
      })
    }
  })

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

  return (
    <Show when={visible().length}>
      <box flexDirection="column" paddingLeft={3} paddingRight={3} paddingBottom={1}>
        <For each={visible()}>{(run) => <Notice ctx={props.ctx} run={run} now={now} />}</For>
      </box>
    </Show>
  )
}

function Notice(props: { readonly ctx: Plugin.Context; readonly run: Runs.Run; readonly now: () => number }) {
  const theme = () => props.ctx.theme
  const target = () => describeTarget(props.run.target)
  const phase = () => props.run.phase()
  const failure = createMemo(() => {
    const current = phase()
    return current.status === "failed" ? firstLine(current.message) : undefined
  })

  return (
    <Switch>
      <Match when={phase().status === "reading"}>
        <text fg={theme().text.subdued} wrapMode="none">
          {SPINNER[Math.floor(props.now() / TICK_MS) % SPINNER.length]} meat is reading {target()} ·{" "}
          {elapsed(props.now() - props.run.startedAt)}
        </text>
      </Match>
      <Match when={failure()}>
        {(failed: () => string) => (
          <text fg={theme().text.feedback.error.default} wrapMode="none">
            ✗ meat failed on {target()} · {failed()}
          </text>
        )}
      </Match>
      <Match when={phase().status === "ready"}>
        <text fg={theme().text.feedback.success.default} wrapMode="none">
          ✓ meat read {target()} · {openHint(props.ctx)} to open
        </text>
      </Match>
    </Switch>
  )
}

/** The live binding for `meat.show`, so a rebound (or unbound) shortcut reads true. */
function openHint(ctx: Plugin.Context): string {
  return ctx.keymap.shortcuts("meat.show")[0] ?? "/meat-diff"
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

  // Published by the server half whenever OpenCode holds an Anthropic credential
  // it never hands out — an OAuth subscription login, above all.
  const relay = OAuth.published()
  // meat's built-in default is a Claude model, so the default entry needs the
  // relay just as much as an explicitly picked one.
  const fallbackEnv =
    relay && !("ANTHROPIC_API_KEY" in config.env)
      ? { ANTHROPIC_BASE_URL: relay.url, ANTHROPIC_API_KEY: relay.key, ...config.env }
      : config.env
  const fallback: Choice = {
    ref: DEFAULT_MODEL,
    label: config.model ?? "meat default",
    config: { ...config, env: fallbackEnv },
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
    // A login whose credential OpenCode injects at request time (Claude Pro/Max,
    // for instance) exposes no key here, and meat only speaks `x-api-key`. The
    // relay carries those; without one there is nothing to send.
    const relayed = plan.transport === "anthropic" && !("ANTHROPIC_API_KEY" in plan.env) && relay !== undefined
    const env = relayed ? { ...plan.env, ANTHROPIC_BASE_URL: relay.url, ANTHROPIC_API_KEY: relay.key } : plan.env
    choices.set(model.id, {
      ref: model.id,
      label: `${category} / ${model.name}`,
      // Plugin options win over the derived transport so a user can always
      // override a provider meat cannot be taught about.
      config: { ...config, model: plan.model, env: { ...env, ...config.env } },
    })
    const variable = plan.transport === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"
    const transport = plan.transport === "anthropic" ? "Anthropic Messages" : "OpenAI Responses"
    options.push({
      title: model.name,
      value: model.id,
      category,
      description: relayed
        ? `${transport} · ${plan.model} · through your OpenCode login`
        : variable in plan.env
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

const MIN_SPLIT_WIDTH = 100

function Page(props: { readonly ctx: Plugin.Context; readonly run: Runs.Run | undefined }) {
  const theme = () => props.ctx.theme.contextual.elevated
  const phase = () => props.run?.phase()
  const dimensions = useTerminalDimensions()
  let scroll: ScrollBoxRenderable | undefined

  const close = () => {
    props.ctx.ui.dialog.clear()
    props.ctx.ui.router.navigate(props.run?.returnTo ?? { type: "home" })
  }

  // Side by side needs room for two gutters and two columns of code; below that
  // it reads worse than the unified view, so the toggle is not even offered.
  const splittable = createMemo(() => dimensions().width >= MIN_SPLIT_WIDTH)
  const [split, setSplit] = createSignal(true)
  const view = createMemo<"split" | "unified">(() => (splittable() && split() ? "split" : "unified"))

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
      {
        id: "meat.view",
        title: "Toggle the meat diff between split and unified",
        group: "Meat",
        bind: "v",
        enabled: () => splittable(),
        run: () => void setSplit((current) => !current),
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
  const parsed = createMemo(() => {
    const current = result()
    return current ? readingDiff(current.smart_diff) : undefined
  })
  const syntax = syntaxStyle(props.ctx)

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
                <Show when={parsed()?.preamble}>
                  {(preamble: () => string) => (
                    <box paddingLeft={1} paddingBottom={1}>
                      <text fg={theme().text.subdued}>{preamble()}</text>
                    </box>
                  )}
                </Show>
                <Show
                  when={parsed()?.files.length}
                  fallback={
                    <Show when={!parsed()?.preamble}>
                      <text fg={theme().text.subdued}>(no meaningful change to read)</text>
                    </Show>
                  }
                >
                  <For each={parsed()?.files ?? []}>
                    {(file) => <File ctx={props.ctx} file={file} view={view()} syntax={syntax} />}
                  </For>
                </Show>
              </scrollbox>
              <box flexShrink={0} flexDirection="row" gap={2} paddingLeft={1}>
                <text fg={theme().text.subdued}>j/k scroll</text>
                <text fg={theme().text.subdued}>ctrl+f/b page</text>
                <text fg={theme().text.subdued}>g top</text>
                <Show when={splittable()}>
                  <text fg={theme().text.subdued}>v {view() === "split" ? "unified" : "split"}</text>
                </Show>
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

/**
 * One file, rendered the way OpenCode's own diff viewer renders one: a header
 * row, then one `<diff>` per hunk with the hunk's own `@@` line above it. Per
 * hunk rather than per file because a single renderable would run the elided
 * gaps together, and because that is what keeps each hunk's header on screen.
 */
function File(props: {
  readonly ctx: Plugin.Context
  readonly file: ReadingFile
  readonly view: "split" | "unified"
  readonly syntax: () => SyntaxStyle
}) {
  const theme = () => props.ctx.theme.contextual.elevated
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box flexDirection="row" gap={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
        <text fg={theme().text.default}>{props.file.path}</text>
        <box flexGrow={1} />
        <text fg={theme().diff.text.added}>+{props.file.additions}</text>
        <text fg={theme().diff.text.removed}>-{props.file.deletions}</text>
      </box>
      <Show
        when={props.file.hunks.length}
        fallback={
          <text fg={theme().text.subdued} wrapMode="none">
            {"  (no textual change)"}
          </text>
        }
      >
        <For each={props.file.hunks}>
          {(hunk) => (
            <box flexDirection="column">
              <box width="100%" height={1} backgroundColor={theme().diff.background.context}>
                <text fg={theme().diff.text.hunkHeader} bg={theme().diff.background.context} wrapMode="none">
                  {` ${hunk.header}`}
                </text>
              </box>
              <diff
                diff={hunk.patch}
                minHeight={hunk.rows}
                view={props.view}
                filetype={props.file.filetype}
                syntaxStyle={props.syntax()}
                showLineNumbers={true}
                width="100%"
                wrapMode="char"
                fg={theme().text.default}
                addedBg={theme().diff.background.added}
                removedBg={theme().diff.background.removed}
                contextBg={theme().diff.background.context}
                addedSignColor={theme().diff.highlight.added}
                removedSignColor={theme().diff.highlight.removed}
                lineNumberFg={theme().diff.lineNumber.text}
                lineNumberBg={theme().diff.background.context}
                addedLineNumberBg={theme().diff.lineNumber.background.added}
                removedLineNumberBg={theme().diff.lineNumber.background.removed}
              />
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

/**
 * The syntax theme `<diff>` highlights with, built from the same tokens
 * OpenCode builds its own from. It owns native memory, so the old one is only
 * dropped once the renderer is done with the frame that still points at it.
 */
function syntaxStyle(ctx: Plugin.Context): () => SyntaxStyle {
  const theme = () => ctx.theme.contextual.elevated
  let current: SyntaxStyle | undefined
  const release = (style: SyntaxStyle) => void ctx.renderer.idle().then(
    () => style.destroy(),
    () => {},
  )
  onCleanup(() => {
    if (current) release(current)
  })
  return createMemo(() => {
    const previous = current
    const [red, green, blue] = theme().background.default.toInts()
    current = generateSyntax(theme(), red + green + blue > 383 * 3 ? "light" : "dark")
    if (previous) release(previous)
    return current
  })
}
