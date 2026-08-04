import { Plugin } from "@opencode-ai/plugin"
import { formatResult, parseTarget, readConfig, runMeat } from "./meat.js"

export default Plugin.define({
  id: "meat",
  setup: async (ctx) => {
    const config = readConfig(ctx.options)

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

    return async () => {
      await tool.dispose()
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
