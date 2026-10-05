// Compiles emails/templates/*.vue (Maizzle) and their .txt siblings into the one
// TypeScript module the Worker imports. Shared by `bun run email:build`, which
// writes it, and `bun run email:check`, which diffs it — same function, so the
// gate cannot disagree with the build.
//
// Maizzle runs here, in Bun, and nowhere near the Worker: it needs Node APIs,
// Vite and a CSS toolchain, none of which belong in a 3 MB bundle. The Worker
// gets strings and fills in the {{tags}} with Mustache (server/utils/render-email.ts).

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { render } from '@maizzle/framework'

import config from '../../emails/maizzle.config'
import { emailModuleSource, variableDrift, type CompiledEmail } from '../email-source'

const ROOT = resolve(import.meta.dir, '../..')
export const EMAILS_DIR = join(ROOT, 'emails')
const TEMPLATES_DIR = join(EMAILS_DIR, 'templates')
export const GENERATED_FILE = join(ROOT, 'server/emails/generated.ts')

export function templateNames(): string[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((file) => file.endsWith('.vue'))
    .map((file) => file.slice(0, -'.vue'.length))
    .sort()
}

/**
 * Vue reports a template tag it tried to evaluate — the symptom of a Mustache tag
 * written without <Raw> — as a console warning and then renders it as empty
 * text. That is a silently blank email, so any warning fails the build.
 */
async function renderQuietly(name: string): Promise<string> {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '))
  try {
    const { html } = await render(join(TEMPLATES_DIR, `${name}.vue`), {
      ...config,
      root: EMAILS_DIR,
    })
    if (warnings.length) {
      throw new Error(
        `${name}.vue rendered with warnings — usually a {{tag}} outside <Raw>:\n  ${warnings.join('\n  ')}`,
      )
    }
    return html
  } finally {
    console.warn = original
  }
}

function assertSameData(name: string, { html, text }: CompiledEmail): void {
  const { onlyHtml, onlyText } = variableDrift(html, text)
  if (!onlyHtml.length && !onlyText.length) return
  throw new Error(
    `${name}: the HTML and the .txt use different data.\n` +
      (onlyHtml.length ? `  only in ${name}.vue:  ${onlyHtml.join(', ')}\n` : '') +
      (onlyText.length ? `  only in ${name}.txt:  ${onlyText.join(', ')}\n` : '') +
      'Both parts of one email must read the same fields, or one of them is stale.\n' +
      'A field only the HTML needs is declared in the .txt as {{! html-only: a, b }}.',
  )
}

/** Every email ships a real plain-text alternative, so a template without one does not build. */
function readText(name: string): string {
  try {
    return readFileSync(join(TEMPLATES_DIR, `${name}.txt`), 'utf8')
  } catch {
    throw new Error(
      `${name}.vue has no ${name}.txt beside it — every email needs a plain-text part.`,
    )
  }
}

export async function compileEmails(): Promise<string> {
  const emails: Record<string, CompiledEmail> = {}
  const names = templateNames()
  const orphans = readdirSync(TEMPLATES_DIR).filter(
    (file) => file.endsWith('.txt') && !names.includes(file.slice(0, -'.txt'.length)),
  )
  if (orphans.length)
    throw new Error(`No template for: ${orphans.join(', ')} (a .txt needs its .vue).`)

  for (const name of names) {
    const html = await renderQuietly(name)
    const text = readText(name)
    assertSameData(name, { html, text })
    emails[name] = { html, text }
  }
  return emailModuleSource(emails)
}
