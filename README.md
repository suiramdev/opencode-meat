# opencode-meat

Read [meat](https://github.com/boldsoftware/meat) **reading diffs** inside OpenCode.

`meat` abridges a git diff with an LLM — it drops everything not worth reading and prints
the remainder plus a one-line summary. This plugin exposes it as an OpenCode tool and a
`/meat` slash command, so the abridged diff lands in the TUI as a syntax-highlighted
```` ```diff ```` block.

## Prerequisites

Install the `meat` binary yourself — the plugin never installs it:

```sh
go install meat.dev/cmd/meat@latest
```

You also need credentials for whichever model meat should use (see [Options](#options)).

## Install

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-meat"]
}
```

Local checkout instead of npm:

```jsonc
{ "plugins": ["/absolute/path/to/opencode-meat/src/index.ts"] }
```

## Options

| Option    | Type                     | Default  | Effect                                             |
| --------- | ------------------------ | -------- | -------------------------------------------------- |
| `model`   | `string`                 | meat's   | Passed as `meat -model <model>`                     |
| `binary`  | `string`                 | `"meat"` | Path to the meat executable (resolved via `PATH`)   |
| `env`     | `Record<string, string>` | `{}`     | Merged over `process.env` for the meat subprocess   |
| `noCache` | `boolean`                | `false`  | Passed as `meat -no-cache`                          |

meat routes model ids starting with `claude-` (or `anthropic/claude-`) to the Anthropic
Messages API and everything else to the OpenAI Responses API. Any OpenAI-compatible
provider therefore works by pairing a model id with `OPENAI_BASE_URL`.

Anthropic, credentials from the ambient environment:

```jsonc
{
  "plugins": [
    { "package": "opencode-meat", "options": { "model": "claude-sonnet-4-5" } }
  ]
}
```

An OpenAI-compatible endpoint (Cursor, OpenRouter, a local gateway…):

```jsonc
{
  "plugins": [
    {
      "package": "opencode-meat",
      "options": {
        "model": "gpt-5.1-codex",
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
`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `MEAT_MODEL`, `MEAT_CACHE`. Set them in your
shell or in `options.env`.

## Usage

| Command             | Reads                                     |
| ------------------- | ----------------------------------------- |
| `/meat`             | `HEAD`                                    |
| `/meat HEAD~3`      | that commit                               |
| `/meat main...HEAD` | the range                                 |
| `/meat -staged`     | `git diff --staged`                       |
| `/meat -w`          | `git diff` (unstaged working tree)        |

The agent can also call the `meat` tool directly — "use the meat tool to review HEAD~2".

Results are cached under `~/.meat`, keyed by rubric + model + diff contents, so re-running
on an unchanged diff is instant. `noCache: true` forces a recompute.

## Notes

- The abridged diff is a **reading** diff, not an applicable patch: removed lines leave
  original hunk counts stale by design.
- A missing binary surfaces as a tool error naming the `go install` command.
- meat's own errors (missing API key, `no diff to read`, bad revision) are passed through
  verbatim from its stderr.
