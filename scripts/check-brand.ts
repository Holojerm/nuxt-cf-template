// Brand asset gate — run with `bun run brand:check`, wired into `bun run ci`.
//
// The six files GENERATED_ASSETS lists (five in public/, plus
// shared/utils/brand-colors.generated.ts) are compiled output, and compiled
// output that nothing verifies goes stale silently. Nothing throws when a
// favicon is a redesign behind the app, or when og.png still says "My App"
// three weeks after `bun run rename` — the site builds, the pages render, and
// you find out from a link preview in someone else's Slack.
//
// So this compares a fingerprint of the generator's inputs (the mark, the
// DESIGN.md color roles, the fonts, the app name) against the one recorded in
// brand.lock.json when the assets were last built. Cheap and browserless: it
// reads files, it never launches Chromium.
//
// A fork that would rather hand-author its icons should drop `brand:check` from
// the `ci` script in package.json — the gate is for people using the pipeline.

import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import {
  collectBrandInputs,
  GENERATED_ASSETS,
  GENERATOR_VERSION,
  LOCK_FILE,
  ROOT,
} from './brand-inputs'

const REMEDY = 'Run `bun run brand:generate` and commit what it writes.'

function fail(...lines: string[]): never {
  console.error(`\nbrand:check failed\n`)
  for (const line of lines) console.error(`  ${line}`)
  console.error(`\n  → ${REMEDY}\n`)
  process.exit(1)
}

let inputs
try {
  inputs = collectBrandInputs()
} catch (error) {
  // A parse failure here is a contract failure, not a crash: DESIGN.md or the
  // logo component says something the pipeline can't read. The thrown message
  // already explains which, so surface it as the finding.
  fail(...String(error instanceof Error ? error.message : error).split('\n'))
}

const missing = GENERATED_ASSETS.filter((asset) => !existsSync(join(ROOT, asset)))
if (missing.length) fail(`Missing generated asset(s): ${missing.join(', ')}`)

if (!existsSync(LOCK_FILE)) {
  fail(
    `No ${relative(ROOT, LOCK_FILE)} — the generated assets have no recorded provenance,`,
    'so there is no way to tell whether they match the current mark.',
  )
}

const locked = JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as {
  fingerprint?: string
  generatorVersion?: string
}

// Checked before the fingerprint, and reported separately from it, because
// GENERATOR_VERSION is itself one of the things fingerprintOf() hashes — so a
// generator upgrade (say, when this template added the maskable icons and the
// manifest colors file) changes the fingerprint exactly the same way a real
// input change does. Without this split, every fork's first `bun run ci`
// after pulling that template update fails with "the mark, a color role, a
// font family, or the app name moved" — none of which is what happened; the
// pipeline itself changed under them, and `bun run brand:generate` is the fix
// either way, but a fork owner shouldn't have to go hunting for what "moved".
if (locked.generatorVersion !== GENERATOR_VERSION) {
  fail(
    `The brand pipeline's generator changed, not any of your inputs.`,
    `  recorded  generator v${locked.generatorVersion ?? '(none — predates this field)'}`,
    `  current   generator v${GENERATOR_VERSION}`,
    '',
    'This happens after picking up a template update to the brand pipeline itself',
    '(scripts/generate-brand-assets.ts) — regenerate to pick up whatever it now adds.',
  )
}

if (locked.fingerprint !== inputs.fingerprint) {
  fail(
    `The brand inputs changed since the assets were generated.`,
    `  recorded  ${locked.fingerprint ?? '(none)'}`,
    `  current   ${inputs.fingerprint}`,
    '',
    'Something the icons are built from moved — the mark, a color role in',
    'DESIGN.md › Brand mark, a font family, or the app name.',
  )
}

console.info(`brand:check — ${GENERATED_ASSETS.length} generated assets match the mark`)
