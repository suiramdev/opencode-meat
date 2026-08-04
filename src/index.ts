import { Plugin } from "@opencode-ai/plugin"
import { formatResult, parseTarget, readConfig, runMeat, type MeatConfig } from "./meat.js"
import * as OAuth from "./oauth.js"

/** The integration OpenCode derives from the `anthropic` provider. */
const ANTHROPIC = "anthropic"

/** Set by `@suiramdev/opencode-anthropic-auth` when its console flow minted a real key. */
const AUTH_MODE = "anthropicAuthMode"

export default Plugin.define({
  id: "meat",
  setup: async (ctx) => {
    const config = readConfig(ctx.options)
    // Started here, not in the TUI: the credential is only reachable from this
    // side, and the TUI is the half that spawns meat.
    const relay = await relayFor(ctx)

    const tool = await ctx.tool.transform((tools) => {
      tools.add({
        name: "meat",
        // Direct provider exposure: one deterministic call, not a CodeMode
        // script. CodeMode would also namespace it "tools.meat".
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
          const result = await runMeat(relayed(config, relay), target, directory)
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

    return async () => {
      await tool.dispose()
      if (relay) {
        OAuth.unpublish()
        await relay.close()
      }
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

/**
 * Starts a relay when OpenCode holds an Anthropic credential meat cannot be
 * handed directly — a subscription OAuth token, or a key the TUI never sees.
 * `undefined` when there is no connection at all, which leaves meat on its own
 * environment exactly as before.
 */
async function relayFor(ctx: Plugin.Context): Promise<OAuth.Relay | undefined> {
  const resolve: OAuth.Resolve = async () => {
    const connection = await ctx.integration.connection.active(ANTHROPIC)
    if (!connection) return undefined
    const credential = await ctx.integration.connection.resolve(connection)
    if (credential?.type === "oauth") {
      // The console flow of opencode-anthropic-auth stores a real API key in the
      // same oauth-shaped credential, and that one must stay an x-api-key.
      const minted = credential.metadata?.[AUTH_MODE] === "api-key"
      return { kind: minted ? "key" : "oauth", value: credential.access }
    }
    if (credential?.type === "key") return { kind: "key", value: credential.key }
    return undefined
  }

  try {
    if (!(await resolve())) return undefined
    const relay = await OAuth.start(resolve)
    OAuth.publish(relay)
    return relay
  } catch {
    // A relay that cannot start must not take the plugin down with it: meat
    // still works for anyone whose key is already in the environment.
    return undefined
  }
}

/** Options still win: an explicitly configured key is never overridden by the relay. */
function relayed(config: MeatConfig, relay: OAuth.Relay | undefined): MeatConfig {
  if (!relay) return config
  return {
    ...config,
    env: { ANTHROPIC_BASE_URL: relay.url, ANTHROPIC_API_KEY: relay.key, ...config.env },
  }
}
