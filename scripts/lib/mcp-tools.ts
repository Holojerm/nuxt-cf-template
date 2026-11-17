// Reading the MCP worker's `registerTool()` calls out of its source, as pure
// string functions.
//
// Separate from scripts/check-mcp.ts, which owns the filesystem and the
// reporting, so the rules can be driven from test/mcp-tools.test.ts.
//
// ── Why source, and not the running server ──────────────────────────────────
// The honest list of tools is what `tools/list` returns, and that is what the
// Claude and ChatGPT directories read. But asking the server means installing
// mcp/'s own dependencies, and the root install that CI runs does not: mcp/ is a
// separate package with a separate lockfile. A gate that only runs where
// someone remembered a second `bun install` is not a gate. So this reads the
// calls as text, the way check-mirrors.ts reads the same file.
//
// ── The contract that makes that sound ──────────────────────────────────────
// A tool's name is a string literal, and its config is an object literal whose
// `title`, `description` and three `annotations` hints are literals too. A call
// written any other way (a config held in a variable, a hint computed at
// runtime) is reported as UNREADABLE rather than skipped. Failing closed costs a
// false positive on a shape nobody needs; failing open is a tool that reaches a
// directory review with no annotations, which is the failure this exists for.

import { endOfString, findClosing, sliceBalanced } from './brace-match'
import { topLevelFields } from './seo-source'

/** The three hints both directories want stated, never defaulted. */
export const TOOL_HINTS = ['readOnlyHint', 'destructiveHint', 'openWorldHint'] as const
export type ToolHint = (typeof TOOL_HINTS)[number]

export interface McpTool {
  name: string
  /** 1-based line of the `registerTool(` call. */
  line: number
  title: string | null
  description: string | null
  /** null for a hint that is absent or not a boolean literal. */
  hints: Record<ToolHint, boolean | null>
}

export interface McpToolProblem {
  line: number
  /** The tool's name, or null when the call was too unusual to find one. */
  tool: string | null
  detail: string
}

/** MCP's own rule for a tool name. */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/

/** ChatGPT cuts a longer tool title; Claude's portal accepts it. */
const MAX_TITLE = 60

/**
 * Comments replaced by spaces, every offset and newline kept, strings left
 * alone. The field reader below splits on commas and matches `key:` at the
 * start of a chunk, and a `// note, with a comma` between two fields would
 * otherwise break both.
 */
export function blankComments(source: string): string {
  let out = ''
  let index = 0
  const blank = (text: string) => text.replace(/[^\n]/g, ' ')
  while (index < source.length) {
    const char = source[index] ?? ''
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index)
      const stop = end === -1 ? source.length : end
      out += blank(source.slice(index, stop))
      index = stop
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      out += blank(source.slice(index, stop))
      index = stop
    } else if (char === "'" || char === '"' || char === '`') {
      const end = endOfString(source, index)
      const stop = end === -1 ? source.length : end + 1
      out += source.slice(index, stop)
      index = stop
    } else {
      out += char
      index += 1
    }
  }
  return out
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r' }

/**
 * The value of a string-literal expression: one literal, or several joined
 * with `+`. Null for anything else, including a template with `${}` in it.
 */
export function stringLiteral(expression: string): string | null {
  let value = ''
  let index = 0
  const skipSpace = () => {
    while (/\s/.test(expression[index] ?? '')) index++
  }
  for (;;) {
    skipSpace()
    const quote = expression[index]
    if (quote !== "'" && quote !== '"' && quote !== '`') return null
    const end = endOfString(expression, index)
    if (end === -1) return null
    const inner = expression.slice(index + 1, end)
    if (quote === '`' && inner.includes('${')) return null
    value += inner.replace(/\\([\s\S])/g, (_, char: string) => ESCAPES[char] ?? char)
    index = end + 1
    skipSpace()
    if (index >= expression.length) return value
    if (expression[index] !== '+') return null
    index++
  }
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

/**
 * Every `registerTool()` call in `source`, and everything wrong with them.
 *
 * `problems` covers one file's worth of rules: a call the reader cannot follow,
 * a missing title, description or hint, and a read-only tool that also claims
 * to be destructive. Duplicate names are the caller's to find, because they can
 * span files.
 */
export function readMcpTools(source: string): { tools: McpTool[]; problems: McpToolProblem[] } {
  const code = blankComments(source)
  const tools: McpTool[] = []
  const problems: McpToolProblem[] = []

  for (const call of code.matchAll(/\.registerTool\s*\(/g)) {
    const line = lineOf(code, call.index)
    const open = call.index + call[0].length - 1
    const close = findClosing(code, open)
    if (close === -1) {
      problems.push({ line, tool: null, detail: 'the registerTool() call is unbalanced' })
      continue
    }
    const args = code.slice(open + 1, close)

    // First argument: the name, as a plain string literal.
    const nameStart = args.search(/\S/)
    const nameEnd = /['"`]/.test(args[nameStart] ?? '') ? endOfString(args, nameStart) : -1
    const name = nameEnd === -1 ? null : stringLiteral(args.slice(nameStart, nameEnd + 1))
    if (name === null) {
      problems.push({
        line,
        tool: null,
        detail: 'the tool name is not a string literal, so the gate cannot read this call',
      })
      continue
    }

    // Second argument: the config, as an object literal.
    const afterName = args.slice(nameEnd + 1)
    const configText = /^\s*,\s*\{/.test(afterName)
      ? sliceBalanced(afterName, afterName.indexOf('{'))
      : null
    if (configText === null) {
      problems.push({
        line,
        tool: name,
        detail: 'the config is not an inline object literal, so the gate cannot read it',
      })
      continue
    }

    const fields = new Map(topLevelFields(configText).map((field) => [field.key, field.value]))
    const literalField = (key: string): string | null => {
      const value = fields.get(key)
      return value ? stringLiteral(value) : null
    }

    const hints: McpTool['hints'] = {
      readOnlyHint: null,
      destructiveHint: null,
      openWorldHint: null,
    }
    const annotations = fields.get('annotations')
    if (annotations?.startsWith('{')) {
      for (const field of topLevelFields(annotations)) {
        if (!TOOL_HINTS.includes(field.key as ToolHint)) continue
        if (field.value === 'true' || field.value === 'false') {
          hints[field.key as ToolHint] = field.value === 'true'
        }
      }
    }

    const tool: McpTool = {
      name,
      line,
      title: literalField('title'),
      description: literalField('description'),
      hints,
    }
    tools.push(tool)

    const report = (detail: string) => problems.push({ line, tool: name, detail })
    if (!TOOL_NAME.test(name)) {
      report('the name must be 1–64 characters of letters, digits, "_", "-" or "."')
    }
    if (!tool.title) report('no `title` (a string literal): the name a person sees for the tool')
    else if (tool.title.length > MAX_TITLE) {
      report(`\`title\` is ${tool.title.length} characters; keep it to ${MAX_TITLE}`)
    }
    if (!tool.description) report('no `description` (a string literal)')
    for (const hint of TOOL_HINTS) {
      if (hints[hint] === null) report(`\`annotations.${hint}\` is not set to true or false`)
    }
    if (hints.readOnlyHint === true && hints.destructiveHint === true) {
      report('readOnlyHint and destructiveHint are both true; a read-only tool destroys nothing')
    }
  }

  return { tools, problems }
}
