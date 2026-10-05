// Shared by `bun run email:build`, `email:check` and `email:dev` — one config, so
// what you preview is what gets compiled.

import { defineConfig } from '@maizzle/framework'

export default defineConfig({
  root: 'emails',
  // Components live beside the templates in emails/components/ and are
  // auto-imported by Maizzle, so only templates/ is a build target.
  content: ['templates/**/*.vue'],
  // Gmail clips a message near 102 KB and the compiled module ships inside the
  // Worker, so size counts. html-crush keeps lines under 500 characters, which
  // SMTP wants, so do not turn that limit off.
  html: { minify: true },
})
