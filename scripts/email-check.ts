// Email gate — run with `bun run email:check`, wired into `bun run ci`.
//
// server/emails/generated.ts is compiled output, and compiled output nothing
// verifies goes stale quietly: someone edits a template, forgets `bun run
// email:build`, and production keeps sending the old wording. This rebuilds in
// memory and compares. Needs no browser, so it runs in the Workers Builds image.

import { existsSync, readFileSync } from 'node:fs'

import { compileEmails, GENERATED_FILE } from './lib/email-compile'

const REMEDY = 'Run `bun run email:build` and commit what it writes.'

function fail(...lines: string[]): never {
  console.error('\nemail:check failed\n')
  for (const line of lines) console.error(`  ${line}`)
  console.error(`\n  → ${REMEDY}\n`)
  process.exit(1)
}

let expected: string
try {
  expected = await compileEmails()
} catch (error) {
  fail(...String(error instanceof Error ? error.message : error).split('\n'))
}

if (!existsSync(GENERATED_FILE)) fail('server/emails/generated.ts does not exist.')

if (readFileSync(GENERATED_FILE, 'utf8') !== expected) {
  fail(
    'server/emails/generated.ts no longer matches emails/templates/.',
    'A template, a component, or the theme changed since it was compiled.',
  )
}

console.info('email:check — server/emails/generated.ts matches emails/templates/')
