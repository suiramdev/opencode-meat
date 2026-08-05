/**
 * meat emits a *reading* diff: it keeps git's own headers but drops the lines
 * not worth reading, so every `@@ -a,b +c,d @@` count is left stale on purpose.
 * OpenTUI's `<diff>` renders through a real unified-diff parser, which rejects a
 * hunk whose counts disagree with the lines under it, and only ever renders the
 * first file of a patch. Both are handled here: the patch is cut into one entry
 * per file, and each hunk header is rewritten to the lines that actually
 * survived. Starts are left alone — they are meat's, and they are right.
 */

export interface ReadingHunk {
  /** The original `@@ … @@ context` line, shown above the hunk. */
  readonly header: string
  /** File headers plus this one hunk: a patch `<diff>` accepts on its own. */
  readonly patch: string
  /** Rendered rows, so the renderable reserves height before it highlights. */
  readonly rows: number
}

export interface ReadingFile {
  readonly path: string
  /** Tree-sitter language for syntax highlighting, or `undefined` when unknown. */
  readonly filetype: string | undefined
  readonly additions: number
  readonly deletions: number
  readonly hunks: readonly ReadingHunk[]
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

export interface ReadingDiff {
  /**
   * Whatever came before the first file — for a commit meat read, `git show`'s
   * own header and message. Worth keeping: it is often the only prose there is.
   */
  readonly preamble: string
  readonly files: readonly ReadingFile[]
}

/** Cuts a reading diff into one renderable entry per file. */
export function readingDiff(diff: string): ReadingDiff {
  const preamble: string[] = []
  const files: ReadingFile[] = []
  let current: string[] | undefined
  let inHunks = false
  const push = () => {
    const file = current && readFile(current)
    if (file) files.push(file)
  }
  for (const line of diff.split("\n")) {
    // `diff --git` is what git writes and what meat passes through, but a patch
    // piped to meat may carry nothing but `---`/`+++`, so a bare file header
    // opens a section too — as long as it is not the `---` of an open hunk.
    if (line.startsWith("diff --git ") || (line.startsWith("--- ") && (!current || inHunks))) {
      push()
      current = []
      inHunks = false
    }
    if (!current) {
      preamble.push(line)
      continue
    }
    if (line.startsWith("@@")) inHunks = true
    current.push(line)
  }
  push()
  return { preamble: preamble.join("\n").trim(), files }
}

function readFile(lines: readonly string[]): ReadingFile | undefined {
  const prelude: string[] = []
  let index = 0
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (line.startsWith("@@")) break
    prelude.push(line)
  }

  const path = filePath(prelude)
  if (!path) return undefined

  // `<diff>` only reads the two file headers, and only to decide nothing we
  // care about — but a patch without them is not a patch, and jsdiff says so.
  const headers = prelude.filter((line) => line.startsWith("--- ") || line.startsWith("+++ "))
  const preface = headers.length === 2 ? `${headers.join("\n")}\n` : `--- a/${path}\n+++ b/${path}\n`

  const hunks: ReadingHunk[] = []
  let additions = 0
  let deletions = 0
  while (index < lines.length) {
    const header = lines[index] ?? ""
    index += 1
    const body: string[] = []
    for (; index < lines.length; index += 1) {
      const line = lines[index] ?? ""
      if (line.startsWith("@@")) break
      // An unclassifiable line inside a hunk makes the parser throw, and a
      // reading diff is exactly where a stray line can turn up.
      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line.startsWith("\\")) body.push(line)
      else if (line.length === 0) body.push(" ")
    }
    const hunk = rewrite(header, body, preface)
    if (!hunk) continue
    hunks.push(hunk)
    for (const line of body) {
      if (line.startsWith("+")) additions += 1
      if (line.startsWith("-")) deletions += 1
    }
  }

  return { path, filetype: filetype(path), additions, deletions, hunks }
}

/** Restates the hunk header over the lines meat kept, leaving both starts as they are. */
function rewrite(header: string, body: readonly string[], preface: string): ReadingHunk | undefined {
  const match = HUNK.exec(header)
  if (!match) return undefined
  let oldLines = 0
  let newLines = 0
  let rows = 0
  let additions = 0
  let deletions = 0
  for (const line of body) {
    if (line.startsWith("\\")) continue
    if (line.startsWith("+")) {
      newLines += 1
      additions += 1
      continue
    }
    if (line.startsWith("-")) {
      oldLines += 1
      deletions += 1
      continue
    }
    oldLines += 1
    newLines += 1
    // A run of additions renders beside the deletions it replaces in split view.
    rows += Math.max(additions, deletions) + 1
    additions = 0
    deletions = 0
  }
  rows += Math.max(additions, deletions)
  if (oldLines === 0 && newLines === 0) return undefined
  const restated = `@@ -${match[1]},${oldLines} +${match[2]},${newLines} @@${match[3] ?? ""}`
  return { header, patch: `${preface}${restated}\n${body.join("\n")}\n`, rows }
}

/** `+++ b/path` names the file, except for a deletion, where only `---` has it. */
function filePath(prelude: readonly string[]): string | undefined {
  for (const prefix of ["+++ ", "--- "]) {
    const line = prelude.find((candidate) => candidate.startsWith(prefix))
    const name = line?.slice(prefix.length).trim()
    if (!name || name === "/dev/null") continue
    return name.replace(/^[ab]\//, "")
  }
  const git = prelude.find((line) => line.startsWith("diff --git "))
  const target = git?.slice("diff --git ".length).split(" b/")[1]
  return target?.trim()
}

/**
 * Extension to tree-sitter language. Only what OpenTUI can actually highlight
 * matters; anything else renders as plain text, which is what `undefined` asks
 * for. JSX and TSX are read as their base language, as OpenCode's own diff
 * viewer does.
 */
const FILETYPES: Record<string, string> = {
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cxx: "cpp",
  go: "go",
  h: "c",
  hpp: "cpp",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  lua: "lua",
  md: "markdown",
  mjs: "javascript",
  mts: "typescript",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "typescript",
  yaml: "yaml",
  yml: "yaml",
  zig: "zig",
}

function filetype(path: string): string | undefined {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  return FILETYPES[extension]
}
