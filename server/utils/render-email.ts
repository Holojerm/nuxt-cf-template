// The runtime half of the email system: fill a compiled template's {{tags}}.
//
// The templates are authored in Maizzle (emails/templates/*.vue) and compiled at
// build time into server/emails/generated.ts — Maizzle itself needs Node and a
// CSS toolchain and must never reach the Worker. What reaches it is two strings
// per email with Mustache tags still in them, and this file, which is the only
// place those tags are ever evaluated.
//
// ── Trust ────────────────────────────────────────────────────────────────────
// Mustache never sees an untrusted TEMPLATE: they are ours, compiled in CI.
// It only ever sees untrusted DATA (an OAuth display name, a feedback message,
// an error string), and that is what its escaping is for.
//
//   {{name}}     HTML-escaped. The default, and what every tag should be.
//   {{{html}}}   Verbatim. Only for markup this code built itself, never for a
//                value that began life outside it. Each use needs a comment
//                saying where the value comes from. Today there are none.
//
// Mustache's stock escape also encodes `/`, `=` and backticks, which turns every
// href into `https:&#x2F;&#x2F;…` — valid, but unreadable in source and a flag
// for some link scanners. The five characters below are all an HTML text node or
// a double-quoted attribute needs.
//
// Text is the opposite problem: there is no markup to break out of, and
// escaping would print `&amp;` into someone's plain-text inbox. So it renders
// with escaping off.
//
// This file is imported by ops-digest.ts as well as the transactional emails.
// It is deliberately the only piece they share: forks that remove transactional
// email (TEARDOWN.md) keep their alerts.

import Mustache from 'mustache'

import { EMAILS, type EmailName } from '../emails/generated'

export type { EmailName }

/** Whatever the template's tags read. Strings, numbers, booleans, lists, nested objects. */
export type EmailData = Record<string, unknown>

export interface RenderedEmail {
  html: string
  text: string
}

const asIs = (value: unknown): string => String(value)

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
const escapeHtml = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!)

export function renderEmail(name: EmailName, data: EmailData): RenderedEmail {
  const email = EMAILS[name]
  return {
    html: Mustache.render(email.html, data, undefined, { escape: escapeHtml }),
    text: Mustache.render(email.text, data, undefined, { escape: asIs }),
  }
}
