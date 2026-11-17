// Gathers everything the MCP listing is derived from, for the three scripts
// that need it: check-mcp.ts, mcp-publish.ts and mcp-pack.ts. The rules live in
// mcp-listing.ts and mcp-tools.ts, which are pure; this is the filesystem half.

import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { McpListingSchema, type ListingContext, type ListingProblem } from './mcp-listing'
import { readMcpTools, type McpTool } from './mcp-tools'
import { walk } from './walk'

export interface LoadedMcp {
  /** Null when a file the listing is built from is missing or invalid. */
  ctx: ListingContext | null
  /** wrangler.toml [vars] NUXT_PUBLIC_MCP_URL, or '' when unset. */
  appMcpUrl: string
  /** Everything that stops the listing being read: files, schema, tools. */
  problems: ListingProblem[]
}

/**
 * True when this checkout has the optional MCP worker at all.
 *
 * Asked of mcp/package.json, not the directory: git does not track empty
 * directories, so a merge or a half-finished removal can leave `mcp/src/` behind
 * with nothing in it, and a gate that took that for a worker went on to crash
 * reading the files a worker would have.
 */
export const hasMcpWorker = (root: string) => existsSync(join(root, 'mcp', 'package.json'))

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function loadMcp(root: string): LoadedMcp {
  const problems: ListingProblem[] = []
  const report = (rule: string, detail: string, remedy: string) =>
    problems.push({ rule, detail, remedy })

  // ── Tools, read from the worker's source ──────────────────────────────────
  const tools: McpTool[] = []
  const seen = new Map<string, string>()
  for (const file of walk(join(root, 'mcp', 'src'), { extensions: ['.ts'] })) {
    const where = relative(root, file)
    const read = readMcpTools(readFileSync(file, 'utf8'))
    for (const problem of read.problems) {
      report(
        `tool ${problem.tool ? `"${problem.tool}"` : '(unreadable)'} at ${where}:${problem.line}`,
        problem.detail,
        'see "What every tool declares" in mcp/src/server.ts',
      )
    }
    for (const tool of read.tools) {
      const first = seen.get(tool.name)
      if (first) {
        report(
          `tool "${tool.name}" is registered twice`,
          `${first} and ${where}:${tool.line}`,
          'the second registration throws when the server starts; rename one',
        )
      }
      seen.set(tool.name, `${where}:${tool.line}`)
      tools.push(tool)
    }
  }

  // ── The version ───────────────────────────────────────────────────────────
  const pkg = readJson(join(root, 'mcp', 'package.json')) as { version?: unknown }
  const version = typeof pkg.version === 'string' ? pkg.version : ''
  if (!version) {
    report(
      'mcp/package.json has no version',
      'the server, its Server Card and the registry entry all report this one field',
      'add "version": "0.1.0"',
    )
  }

  // ── The app, from fleet.json and wrangler.toml ────────────────────────────
  const fleet = readJson(join(root, 'fleet.json')) as {
    slug?: string
    name?: string
    urls?: { prod?: string }
  }
  const wrangler = Bun.TOML.parse(readFileSync(join(root, 'wrangler.toml'), 'utf8')) as {
    vars?: Record<string, unknown>
  }
  const stringVar = (name: string) => {
    const value = wrangler.vars?.[name]
    return typeof value === 'string' ? value : ''
  }

  // ── The listing ───────────────────────────────────────────────────────────
  const listingPath = join(root, 'mcp', 'listing.json')
  let listing: ListingContext['listing'] | null = null
  if (!existsSync(listingPath)) {
    report(
      'mcp/listing.json missing',
      'the worker imports it for its Server Card, so it will not build either',
      'restore it from the template',
    )
  } else {
    let raw: unknown
    try {
      raw = readJson(listingPath)
    } catch (error) {
      report('mcp/listing.json unreadable', String(error), 'fix the JSON')
    }
    if (raw !== undefined) {
      const parsed = McpListingSchema.safeParse(raw)
      if (parsed.success) listing = parsed.data
      else {
        for (const issue of parsed.error.issues) {
          report(
            `mcp/listing.json invalid: ${issue.path.join('.') || '(root)'}`,
            issue.message,
            'see scripts/lib/mcp-listing.ts for the shape and the length limits',
          )
        }
      }
    }
  }

  const ctx: ListingContext | null =
    listing && version
      ? {
          listing,
          version,
          app: { slug: fleet.slug ?? '', name: fleet.name ?? '', url: fleet.urls?.prod ?? '' },
          publisher: {
            name: stringVar('NUXT_PUBLIC_LEGAL_ENTITY'),
            email: stringVar('NUXT_PUBLIC_SUPPORT_EMAIL'),
          },
          tools,
        }
      : null

  return { ctx, appMcpUrl: stringVar('NUXT_PUBLIC_MCP_URL'), problems }
}

export function printProblems(gate: string, problems: ListingProblem[]) {
  console.error(`\n${gate} failed — ${problems.length} problem(s)\n`)
  for (const { rule, detail, remedy } of problems) {
    console.error(`  ${rule}`)
    console.error(`    ${detail}`)
    if (remedy) console.error(`    → ${remedy}`)
    console.error('')
  }
}
