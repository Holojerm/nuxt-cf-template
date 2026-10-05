// Write every email, filled with its sample data, to HTML and text files you can
// open — `bun run email:preview [dir]`. The point is to look at the real output
// of the real runtime path (compiled module + Mustache), which `email:dev` does
// not show: it previews the template, this previews what gets sent.

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { SAMPLES } from '../emails/samples'
import { renderEmail, type EmailName } from '../server/utils/render-email'

const out = resolve(process.argv[2] ?? '.email-preview')
mkdirSync(out, { recursive: true })

// The sample origin does not exist, so the logo would be a broken image in a
// browser. Copy it beside the previews and point at that — the one thing a sent
// email fetches from the live site.
copyFileSync(join(import.meta.dir, '../public/email-logo.png'), join(out, 'email-logo.png'))

for (const [name, data] of Object.entries(SAMPLES)) {
  const { html, text } = renderEmail(name as EmailName, data)
  writeFileSync(
    join(out, `${name}.html`),
    html.replace(/src="[^"]*email-logo\.png"/, `src="email-logo.png"`),
  )
  writeFileSync(join(out, `${name}.txt`), text)
}

console.info(`email:preview — ${Object.keys(SAMPLES).length} emails → ${out}`)
