// The rules behind `bun run mcp:check`'s tool half: what counts as a readable
// `registerTool()` call, and what a tool must declare. Pure strings.

import { describe, expect, it } from 'vitest'

import { blankComments, readMcpTools, stringLiteral } from '../scripts/lib/mcp-tools'

const HINTS = '{ readOnlyHint: true, destructiveHint: false, openWorldHint: false }'

const tool = (config: string, name = "'whoami'") =>
  `server.registerTool(${name}, ${config}, async () => text('ok'))`

describe('stringLiteral', () => {
  it('reads each quote style and joins concatenated literals', () => {
    expect(stringLiteral("'one'")).toBe('one')
    expect(stringLiteral('"two"')).toBe('two')
    expect(stringLiteral('`three`')).toBe('three')
    expect(stringLiteral("'a ' +\n  'b'")).toBe('a b')
    expect(stringLiteral("'it\\'s'")).toBe("it's")
  })

  it('refuses anything whose value is not known from the source', () => {
    expect(stringLiteral('TITLE')).toBeNull()
    expect(stringLiteral('`Hello ${name}`')).toBeNull()
    expect(stringLiteral("'a' + suffix")).toBeNull()
  })
})

describe('blankComments', () => {
  it('blanks comments, keeps offsets, and leaves a // inside a string alone', () => {
    const source = "const a = 'https://x' // gone, with a comma\n/* gone */ const b = 1"
    const blanked = blankComments(source)
    expect(blanked).toHaveLength(source.length)
    expect(blanked).toContain("'https://x'")
    expect(blanked).not.toContain('gone')
    expect(blanked).toContain('const b = 1')
  })
})

describe('readMcpTools', () => {
  it('reads a fully declared tool and reports nothing', () => {
    const source = tool(
      `{
        // a comment, with a comma, between fields
        title: 'Who am I',
        description: 'Show the user this connection acts as',
        inputSchema: { productKey: z.string().default('default') },
        annotations: ${HINTS},
      }`,
    )
    const { tools, problems } = readMcpTools(source)
    expect(problems).toEqual([])
    expect(tools).toEqual([
      {
        name: 'whoami',
        line: 1,
        title: 'Who am I',
        description: 'Show the user this connection acts as',
        hints: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
    ])
  })

  it('reports each missing declaration by name', () => {
    const { problems } = readMcpTools(tool("{ description: 'd' }"))
    expect(problems.map((p) => p.detail)).toEqual([
      expect.stringContaining('`title`'),
      expect.stringContaining('annotations.readOnlyHint'),
      expect.stringContaining('annotations.destructiveHint'),
      expect.stringContaining('annotations.openWorldHint'),
    ])
    expect(problems.every((p) => p.tool === 'whoami')).toBe(true)
  })

  it('does not take a nested description for the tool’s own', () => {
    const source = tool(
      `{ title: 'T', inputSchema: { q: z.string().describe('description: nested') }, annotations: ${HINTS} }`,
    )
    expect(readMcpTools(source).problems.map((p) => p.detail)).toEqual([
      expect.stringContaining('`description`'),
    ])
  })

  it('treats a hint that is not a boolean literal as unset', () => {
    const source = tool(
      "{ title: 'T', description: 'd', annotations: { readOnlyHint: READ_ONLY, destructiveHint: false, openWorldHint: false } }",
    )
    expect(readMcpTools(source).problems.map((p) => p.detail)).toEqual([
      expect.stringContaining('annotations.readOnlyHint'),
    ])
  })

  it('refuses a read-only tool that also claims to be destructive', () => {
    const source = tool(
      "{ title: 'T', description: 'd', annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: false } }",
    )
    expect(readMcpTools(source).problems.map((p) => p.detail)).toEqual([
      expect.stringContaining('both true'),
    ])
  })

  it('fails closed on a call it cannot read, instead of skipping it', () => {
    const variableConfig = readMcpTools('server.registerTool("a", config, handler)')
    expect(variableConfig.tools).toEqual([])
    expect(variableConfig.problems[0]?.detail).toContain('not an inline object literal')

    const variableName = readMcpTools(`server.registerTool(NAME, { title: 'T' }, handler)`)
    expect(variableName.tools).toEqual([])
    expect(variableName.problems[0]?.detail).toContain('not a string literal')
  })

  it('ignores a registerTool() that only appears in a comment', () => {
    expect(readMcpTools('// server.registerTool("gone", {}, h)\n')).toEqual({
      tools: [],
      problems: [],
    })
  })

  it('reports the line of each call', () => {
    const source = `\n\n${tool(`{ title: 'A', description: 'd', annotations: ${HINTS} }`, "'a'")}\n${tool(`{ title: 'B', description: 'd', annotations: ${HINTS} }`, "'b'")}`
    expect(readMcpTools(source).tools.map((t) => [t.name, t.line])).toEqual([
      ['a', 3],
      ['b', 4],
    ])
  })

  it('rejects a name MCP would not accept', () => {
    const source = tool(`{ title: 'T', description: 'd', annotations: ${HINTS} }`, "'has space'")
    expect(readMcpTools(source).problems[0]?.detail).toContain('1–64 characters')
  })
})
