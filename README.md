# opencode-meat

Read [meat](https://github.com/boldsoftware/meat) **reading diffs** inside OpenCode.

`meat` abridges a git diff with an LLM — it drops everything not worth reading and prints
the remainder plus a one-line summary. This plugin runs the `meat` CLI directly from the
TUI: `/meat` asks which model should read the diff, then shows the result in a full-screen,
scrollable window. **No prompt is ever sent to your agent** — the slash command never
reaches a session, so it costs no agent tokens and leaves no message behind.

The same abridging is also exposed as a `meat` tool, so an agent can ask for it on purpose.

## Prerequisites

Install the `meat` binary yourself — the plugin never installs it:

```sh
go install meat.dev/cmd/meat@latest
```

## Install

The plugin has two halves — a server-side tool and the TUI window — and OpenCode
discovers them differently. Naming the package in `opencode.json`'s `plugins` array loads
**only the server half**: as of `0.0.0-next-16741` the TUI plugin loader reads
`<config>/plugins/tui/` and `<project>/.opencode/plugins/tui/` and nothing else. So install
by dropping two one-line files into your config directory (`~/.config/opencode`, or
wherever `OPENCODE_CONFIG_DIR` points).

```jsonc
// <config>/package.json — OpenCode runs an install here at startup
{
  "name": "opencode-config",
  "private": true,
  "dependencies": { "@suiramdev/opencode-meat": "^0.2.2" }
}
```

```ts
// <config>/plugins/meat.ts — the tool
export { default } from "@suiramdev/opencode-meat"
```

```ts
// <config>/plugins/tui/meat.ts — the window
export { default } from "@suiramdev/opencode-meat/tui"
```

Leave the package **out** of `opencode.json`'s `plugins` array: these two files already
load both halves from one install, and a config entry would install a second copy.

The `package.json` is not optional. The window is a Solid component, so its module has to
resolve `@opentui/solid` and `solid-js`; they arrive as peer dependencies of this package,
but only if something installs it into a `node_modules` the plugin file can see. A plugin
file with no reachable `node_modules` fails with `Cannot find package 'solid-js'`.

## Usage

| Command             | Reads                              |
| ------------------- | ---------------------------------- |
| `/meat`             | `HEAD`                             |
| `/meat HEAD~3`      | that commit                        |
| `/meat main...HEAD` | the range                          |
| `/meat -staged`     | `git diff --staged`                |
| `/meat -w`          | `git diff` (unstaged working tree) |

`/meat` opens a model picker first; cancelling it (escape) does nothing at all — no
subprocess, no window. Picking a model runs `meat` and opens the diff window, which
remembers your choice for next time.

| Key                    | In the diff window   |
| ---------------------- | -------------------- |
| `j` / `k`, `↓` / `↑`   | scroll a line        |
| `ctrl+f` / `ctrl+b`    | scroll a page        |
| `pagedown` / `pageup`  | scroll a page        |
| `g`                    | back to the top      |
| `esc` / `q`            | back where you were  |

The agent can also call the `meat` tool directly — "use the meat tool to review HEAD~2".

## Which models are offered

meat picks its transport from the model id alone: an id like `claude-…` (optionally behind
an `anthropic/` prefix) goes to the Anthropic Messages API, everything else to the OpenAI
Responses API. The picker lowers each OpenCode model onto that split and sets the matching
environment for the subprocess:

| Provider                                   | meat sees                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| Provider id `anthropic`, or any provider loading `@ai-sdk/anthropic`, with a `claude-…` id | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` (a trailing `/v1` is trimmed, because meat appends `/v1/messages`) |
| OpenAI                                     | `OPENAI_API_KEY`                                                                  |
| Any OpenAI-compatible gateway (OpenCode Zen, OpenRouter, a local proxy…) | `OPENAI_API_KEY`, `OPENAI_BASE_URL` from the provider's catalog entry |

Both signals matter. The provider id is checked because a provider served by a custom
module — an OAuth login plugin, say — reports a `file://` URL as its package; the package is
checked because providers like Kimi For Coding speak the Anthropic Messages API under their
own id.

A key is passed only when OpenCode exposes one. Credentials it injects at request time,
such as an OAuth login, are invisible here, so those entries read `needs $ANTHROPIC_API_KEY`
and meat falls back to your environment.

Two combinations cannot be expressed and are left out of the picker, which reports how many
it hid:

- an Anthropic-Messages provider serving non-Claude ids (meat would dial the OpenAI
  Responses API against an Anthropic endpoint);
- a Claude id served by a gateway, such as OpenRouter's `anthropic/claude-…` (meat would
  dial `api.anthropic.com` with the gateway's key).

The first entry, **meat default**, passes no `-model` at all and lets meat use `$MEAT_MODEL`
or its own default with whatever credentials are already in your environment.

Gateways that implement `/v1/chat/completions` but not `/v1/responses` are offered but will
fail; meat's own error is shown in the window.

## Options

Options come from the plugin entry in your config and apply to both halves.

| Option    | Type                     | Default  | Effect                                            |
| --------- | ------------------------ | -------- | ------------------------------------------------- |
| `model`   | `string`                 | meat's   | Passed as `meat -model <model>`, and the label of the picker's default entry |
| `binary`  | `string`                 | `"meat"` | Path to the meat executable (resolved via `PATH`) |
| `env`     | `Record<string, string>` | `{}`     | Merged over the environment meat derives, so it always wins |
| `noCache` | `boolean`                | `false`  | Passed as `meat -no-cache`                        |

```jsonc
{
  "plugins": [
    {
      "package": "@suiramdev/opencode-meat",
      "options": {
        "env": {
          "OPENAI_BASE_URL": "https://<openai-compatible-endpoint>/v1",
          "OPENAI_API_KEY": "sk-…"
        }
      }
    }
  ]
}
```

Recognized environment variables are meat's own: `OPENAI_API_KEY`, `OPENAI_BASE_URL`,
`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `MEAT_MODEL`, `MEAT_CACHE`.

Results are cached under `~/.meat`, keyed by rubric + model + diff contents, so re-running
on an unchanged diff is instant. `noCache: true` forces a recompute.

## Local development

A checkout wires the same two halves, but from source. The TUI file resolves `solid-js` and
`@opentui/solid` out of this repo's own `node_modules`, which is why they are devDependencies
here:

```jsonc
// opencode.jsonc — server half
{ "plugins": [{ "package": "./src/index.ts", "options": {} }] }
```

```ts
// .opencode/plugins/tui/meat.ts — TUI half
export { default } from "../../../src/tui.js"
```

`bun run typecheck` checks both.

## Notes

- The abridged diff is a **reading** diff, not an applicable patch: removed lines leave
  original hunk counts stale by design, which is why the window colours lines by their
  marker instead of parsing the diff.
- A missing binary surfaces as a tool error naming the `go install` command.
- meat's own errors (missing API key, `no diff to read`, bad revision) are passed through
  verbatim from its stderr.
