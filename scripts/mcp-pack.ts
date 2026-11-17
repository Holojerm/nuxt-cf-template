// Builds the submission pack for the MCP directories — `bun run mcp:pack`.
//
// Two of the three directories take a submission by hand: Claude's is a
// ten-step portal form, ChatGPT's a ZIP upload. Neither has an API. What can be
// automated is everything up to the upload, so that submitting is pasting and
// attaching rather than rewriting the listing from memory in two formats.
//
// Writes mcp/.publish/ (gitignored, rebuilt from scratch each run):
//
//   server.json              the official MCP Registry entry (CI publishes it)
//   claude-connector.md      the Claude portal's fields, in order, filled in
//   chatgpt-plugin/          plugin.json, mcp.json and the two icons
//   chatgpt-plugin.zip       that directory, ready to upload
//
// Then prints what each directory still needs. That checklist is advice, not a
// gate: it never fails the run, because a fork may list in one directory and
// not another. The `/mcp-publish` command walks the whole submission.

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { hasMcpWorker, loadMcp, printProblems } from './lib/mcp-context'
import {
  buildPluginManifest,
  buildPluginMcpConfig,
  buildServerJson,
  claudeSubmission,
  listingProblems,
  readiness,
  type Check,
} from './lib/mcp-listing'

const ROOT = resolve(import.meta.dir, '..')

if (!hasMcpWorker(ROOT)) {
  console.info('mcp:pack — no mcp/ worker in this checkout')
  process.exit(0)
}

const { ctx, appMcpUrl, problems } = loadMcp(ROOT)
if (ctx) problems.push(...listingProblems(ctx, appMcpUrl))
if (!ctx || problems.length) {
  printProblems('mcp:pack', problems)
  process.exit(1)
}

const out = join(ROOT, 'mcp', '.publish')
const plugin = join(out, 'chatgpt-plugin')
rmSync(out, { recursive: true, force: true })
mkdirSync(join(plugin, 'assets'), { recursive: true })

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
writeFileSync(join(out, 'server.json'), json(buildServerJson(ctx)))
writeFileSync(join(out, 'claude-connector.md'), claudeSubmission(ctx))
writeFileSync(join(plugin, 'plugin.json'), json(buildPluginManifest(ctx)))
writeFileSync(join(plugin, 'mcp.json'), json(buildPluginMcpConfig(ctx)))

// Both icons come from the brand mark (`bun run brand:generate`); ChatGPT wants
// them square and at least 48px, which these are.
const missingIcons: string[] = []
for (const [source, target] of [
  ['icon-192.png', 'icon.png'],
  ['icon-512.png', 'logo.png'],
] as const) {
  const from = join(ROOT, 'public', source)
  if (existsSync(from)) copyFileSync(from, join(plugin, 'assets', target))
  else missingIcons.push(`public/${source}`)
}

let zipped = false
const zip = Bun.which('zip')
if (zip && missingIcons.length === 0) {
  const proc = Bun.spawn([zip, '-r', '-q', '-X', '../chatgpt-plugin.zip', '.'], { cwd: plugin })
  zipped = (await proc.exited) === 0
}

function section(title: string, checks: Check[]) {
  const open = checks.filter((item) => !item.ok)
  console.info(`\n${title} — ${open.length === 0 ? 'ready' : `${open.length} thing(s) missing`}`)
  for (const item of checks) {
    console.info(`  ${item.ok ? '✓' : '✗'} ${item.label}${item.ok ? '' : `\n      → ${item.fix}`}`)
  }
}

const ready = readiness(ctx)
console.info(`mcp:pack — ${ctx.listing.registry.name}@${ctx.version}, ${ctx.tools.length} tool(s)`)
console.info('  wrote mcp/.publish/server.json, claude-connector.md, chatgpt-plugin/')
if (zipped) console.info('  wrote mcp/.publish/chatgpt-plugin.zip')
else if (missingIcons.length) {
  console.info(`  no ZIP: ${missingIcons.join(', ')} missing — run \`bun run brand:generate\``)
} else
  console.info('  no ZIP: `zip` is not installed — compress mcp/.publish/chatgpt-plugin/ by hand')

section('Official MCP Registry (CI publishes when listing.json has publish: true)', ready.registry)
section('Claude Connectors Directory (claude.ai/directory/manage)', ready.claude)
section('ChatGPT directory (platform.openai.com/plugins)', ready.chatgpt)
console.info('\nRun /mcp-publish in Claude Code for the submission steps.\n')
