// The email build's pure parts: reading a template's {{tags}} and writing the
// generated module. No Maizzle, no filesystem, so test/email-source.test.ts can
// run it in workerd. scripts/lib/email-compile.ts is the half that does I/O.

export interface CompiledEmail {
  html: string
  text: string
}

/** Supplied to every email by EmailLayout (logo, footer link), so a .txt may skip them. */
const LAYOUT_VARIABLES = new Set(['appName', 'appUrl'])

/** `{{x}}`, `{{{x}}}`, `{{#x}}`, `{{^x}}`, `{{/x}}` → `x`. Comments (`{{! … }}`) never match. */
const TAG = /\{\{\{?\s*[#^/&]?\s*([\w.]+)\s*\}?\}\}/g

export function variablesOf(source: string): Set<string> {
  return new Set([...source.matchAll(TAG)].map((match) => match[1]!))
}

/**
 * Fields only the HTML needs (a tone flag, a link target) are declared in the
 * .txt as `{{! html-only: a, b }}` — a Mustache comment, so it renders to nothing,
 * and a visible, reviewable exception rather than a silent one.
 */
export function htmlOnlyVariables(text: string): Set<string> {
  const list = text.match(/\{\{!\s*html-only:([^}]*)\}\}/)?.[1] ?? ''
  return new Set(
    list
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  )
}

export interface VariableDrift {
  onlyHtml: string[]
  onlyText: string[]
}

/** What one half of an email reads that the other does not — the sign that one is stale. */
export function variableDrift(html: string, text: string): VariableDrift {
  const exempt = htmlOnlyVariables(text)
  const keep = (name: string) => !LAYOUT_VARIABLES.has(name)
  const inHtml = [...variablesOf(html)].filter((name) => keep(name) && !exempt.has(name))
  const inText = [...variablesOf(text)].filter(keep)
  return {
    onlyHtml: inHtml.filter((name) => !inText.includes(name)),
    onlyText: inText.filter((name) => !variablesOf(html).has(name)),
  }
}

/** The generated TypeScript module, entries sorted by name so a rebuild is byte-stable. */
export function emailModuleSource(emails: Record<string, CompiledEmail>): string {
  const names = Object.keys(emails).sort()
  const entries = names.map(
    (name) =>
      `  ${JSON.stringify(name)}: {\n    html: ${JSON.stringify(emails[name]!.html)},\n    text: ${JSON.stringify(emails[name]!.text)},\n  },`,
  )

  return `// GENERATED — edit emails/*.vue, then bun run email:build
// Plain text is the .txt beside each template. Compiled by scripts/lib/email-compile.ts;
// \`bun run email:check\` (part of \`bun run ci\`) fails when this file drifts from them.
// Mustache tags are still in here — server/utils/render-email.ts fills them at send time.

export interface CompiledEmail {
  html: string
  text: string
}

export type EmailName = ${names.map((name) => JSON.stringify(name)).join(' | ')}

export const EMAILS: Record<EmailName, CompiledEmail> = {
${entries.join('\n')}
}
`
}
