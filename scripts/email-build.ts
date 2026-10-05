// Compile the email templates — run with `bun run email:build`.
// See scripts/lib/email-compile.ts, and .claude/docs/email.md for the workflow.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'

import { compileEmails, GENERATED_FILE, templateNames } from './lib/email-compile'

try {
  // A fork adopting this for the first time has no server/emails/ yet.
  mkdirSync(dirname(GENERATED_FILE), { recursive: true })
  writeFileSync(GENERATED_FILE, await compileEmails())
} catch (error) {
  console.error(`\nemail:build failed\n\n${error instanceof Error ? error.message : error}\n`)
  process.exit(1)
}

console.info(
  `email:build — ${templateNames().length} emails → ${relative(process.cwd(), GENERATED_FILE)}`,
)
