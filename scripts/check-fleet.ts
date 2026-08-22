// Fleet-manifest gate — run with `bun run fleet:check`, wired into `bun run ci`.
//
// fleet.json is only worth reading if it is true, and nothing about a stale
// manifest *fails*: the app builds, deploys, and serves, while the dashboard
// polls a Worker name that was renamed last month. So the manifest is checked
// against the files it summarises on every CI run, the same way
// check-design-tokens.ts checks the token layer and check-seo.ts the SEO one.
//
// Rules:
//
//   1. fleet.json exists and matches FleetManifestSchema (shared/utils/fleet-manifest.ts).
//   2. `workers[0]` is wrangler.toml's `name` — the dashboard looks the Worker
//      up by this string.
//   3. The D1, KV and R2 bindings are exactly wrangler.toml's, ids included.
//   4. `crons` is exactly `[triggers] crons`.
//   5. `urls.prod` is NUXT_PUBLIC_APP_URL, when that var is set — the dashboard
//      fetches /api/status relative to it.
//   6. No binding id is a template placeholder unless `stage` is "unreleased".
//   7. If mcp/wrangler.jsonc exists, its Worker is listed in `workers`.
//
// Reads the TOML with Bun's built-in parser, so this runs with no dependency
// the app does not already have. It is a Bun script rather than a vitest case
// for the same reason check-mirrors.ts is: the test suite runs inside workerd,
// which has no filesystem.

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  FleetManifestSchema,
  placeholderBindings,
  type FleetManifest,
} from '../shared/utils/fleet-manifest'

const ROOT = resolve(import.meta.dir, '..')

interface Problem {
  rule: string
  detail: string
  remedy: string
}

const problems: Problem[] = []
const report = (rule: string, detail: string, remedy: string) =>
  problems.push({ rule, detail, remedy })

// ── wrangler.toml, the thing the manifest must agree with ───────────────────

interface WranglerConfig {
  name?: string
  d1_databases?: { database_name?: string; database_id?: string }[]
  kv_namespaces?: { id?: string }[]
  r2_buckets?: { bucket_name?: string }[]
  triggers?: { crons?: string[] }
  vars?: Record<string, unknown>
}

const wrangler = Bun.TOML.parse(readFileSync(join(ROOT, 'wrangler.toml'), 'utf8')) as WranglerConfig

// ── 1. the manifest parses ──────────────────────────────────────────────────

const manifestPath = join(ROOT, 'fleet.json')
let manifest: FleetManifest | null = null

if (!existsSync(manifestPath)) {
  report(
    'fleet.json missing',
    'no manifest at the repository root',
    'copy the template’s fleet.json and fill it in',
  )
} else {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    report('fleet.json unreadable', String(error), 'fix the JSON — no comments, no trailing commas')
  }
  if (raw !== undefined) {
    const parsed = FleetManifestSchema.safeParse(raw)
    if (parsed.success) {
      manifest = parsed.data
    } else {
      for (const issue of parsed.error.issues) {
        const where = issue.path.length ? issue.path.join('.') : '(root)'
        report(
          `fleet.json invalid: ${where}`,
          issue.message,
          'see shared/utils/fleet-manifest.ts for the shape',
        )
      }
    }
  }
}

/** Set equality with a readable diff; order never matters for any of these lists. */
function compareSets(rule: string, have: string[], want: string[], remedy: string) {
  const missing = want.filter((item) => !have.includes(item))
  const extra = have.filter((item) => !want.includes(item))
  if (missing.length === 0 && extra.length === 0) return
  const parts: string[] = []
  if (missing.length) parts.push(`missing from fleet.json: ${missing.join(', ')}`)
  if (extra.length) parts.push(`in fleet.json but not wrangler.toml: ${extra.join(', ')}`)
  report(rule, parts.join('; '), remedy)
}

if (manifest) {
  // ── 2. the Worker name ──────────────────────────────────────────────────
  if (manifest.workers[0] !== wrangler.name) {
    report(
      'workers[0] is not the Worker',
      `fleet.json says "${manifest.workers[0]}", wrangler.toml name is "${wrangler.name ?? '(unset)'}"`,
      'the app Worker goes first in `workers`; mcp/ and any others follow',
    )
  }
  if (manifest.slug !== wrangler.name) {
    report(
      'slug differs from the Worker name',
      `slug "${manifest.slug}" vs name "${wrangler.name ?? '(unset)'}"`,
      'keep them equal — `bun run rename` rewrites both',
    )
  }

  // ── 3. bindings ─────────────────────────────────────────────────────────
  compareSets(
    'D1 bindings differ',
    manifest.bindings.d1.map((d1) => `${d1.name}=${d1.id}`),
    (wrangler.d1_databases ?? []).map((d1) => `${d1.database_name}=${d1.database_id}`),
    'copy database_name and database_id from [[d1_databases]] into bindings.d1',
  )
  compareSets(
    'KV bindings differ',
    manifest.bindings.kv,
    (wrangler.kv_namespaces ?? []).map((kv) => kv.id ?? ''),
    'copy every [[kv_namespaces]] id into bindings.kv',
  )
  compareSets(
    'R2 bindings differ',
    manifest.bindings.r2,
    (wrangler.r2_buckets ?? []).map((r2) => r2.bucket_name ?? ''),
    'copy every [[r2_buckets]] bucket_name into bindings.r2',
  )

  // ── 4. crons ────────────────────────────────────────────────────────────
  compareSets(
    'crons differ',
    manifest.crons,
    wrangler.triggers?.crons ?? [],
    'copy [triggers] crons verbatim — scripts/check-crons.ts checks that list against nuxt.config.ts',
  )

  // ── 5. production origin ────────────────────────────────────────────────
  const appUrl = wrangler.vars?.NUXT_PUBLIC_APP_URL
  if (
    typeof appUrl === 'string' &&
    appUrl.replace(/\/+$/, '') !== manifest.urls.prod.replace(/\/+$/, '')
  ) {
    report(
      'urls.prod differs from NUXT_PUBLIC_APP_URL',
      `fleet.json "${manifest.urls.prod}" vs wrangler.toml [vars] "${appUrl}"`,
      'the dashboard fetches /api/status relative to urls.prod, so it must be the origin the Worker serves',
    )
  }

  // ── 6. placeholders ─────────────────────────────────────────────────────
  const placeholders = placeholderBindings(manifest)
  if (placeholders.length && manifest.stage !== 'unreleased') {
    report(
      'placeholder binding ids',
      `${placeholders.join(', ')} still carry the template’s YOUR_… value while stage is "${manifest.stage}"`,
      'paste the real ids from the Cloudflare dashboard, or set stage to "unreleased" until you have',
    )
  }

  // ── 7. the MCP worker, if present ───────────────────────────────────────
  const mcpConfigPath = join(ROOT, 'mcp', 'wrangler.jsonc')
  if (existsSync(mcpConfigPath)) {
    const mcpName = readJsoncName(readFileSync(mcpConfigPath, 'utf8'))
    if (mcpName === null) {
      report(
        'mcp/wrangler.jsonc unreadable',
        'could not find a top-level "name"',
        'keep `"name": "…"` as a plain string at the top level',
      )
    } else if (!manifest.workers.includes(mcpName)) {
      report(
        'MCP worker not listed',
        `mcp/wrangler.jsonc deploys "${mcpName}", which is not in fleet.json workers`,
        'add it after the app Worker — the dashboard checks every Worker this repo deploys',
      )
    }
  }
}

/**
 * The top-level `name` of a wrangler.jsonc. Comments and trailing commas make
 * it not-JSON, and a JSONC parser is a strange dependency for a build gate
 * that needs one string, so this reads the key directly. Returns null when
 * there is no such key rather than guessing.
 */
function readJsoncName(source: string): string | null {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const match = withoutComments.match(/^\s*"name"\s*:\s*"([^"]+)"/m)
  return match?.[1] ?? null
}

// ── report ──────────────────────────────────────────────────────────────────

if (problems.length === 0) {
  console.info('fleet:check — fleet.json matches wrangler.toml')
  process.exit(0)
}

console.error(`\nfleet:check failed — ${problems.length} problem(s)\n`)
for (const { rule, detail, remedy } of problems) {
  console.error(`  ${rule}`)
  console.error(`    ${detail}`)
  console.error(`    → ${remedy}\n`)
}
console.error(
  'fleet.json is what the portfolio dashboard reads; shared/utils/fleet-manifest.ts is its shape.\n',
)
process.exit(1)
