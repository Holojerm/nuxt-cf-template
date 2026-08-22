// Reading a page's `useSeo()` call out of its source, as pure string
// functions.
//
// Separate from scripts/check-seo.ts, which owns the filesystem walk and the
// reporting, so that everything with a rule in it can be imported by
// test/seo-source.test.ts and driven with ordinary vitest cases. The gate used
// to carry its own fixture harness for this, which is a strange thing for a
// build script to do and a worse thing to trust: the fixtures all happened to
// use the one call shape the extractor handled.
//
// ── The contract, because it decides what a green gate means ────────────────
// Extraction is bounded by the matched parentheses of the `useSeo(` call, and a
// call whose argument is not an object literal — directly, or one hop through a
// local `const` — is reported as UNREADABLE rather than skipped. That is the
// whole point. The previous version searched for the next `{` after the call
// with no upper bound, so `useSeo(pageSeo)` silently adopted whatever object
// came next in the file (a `toast.add({ description: … })` twenty lines down),
// and a page with no meta description passed by measuring a toast.
//
// Failing closed costs a false positive on a call shape nobody writes today.
// Failing open costs a page that quietly ships with no description, found
// months later in a traffic graph — which is the failure this gate exists for.

import { endOfString, findClosing, sliceBalanced } from './brace-match'

/** What `useSeo()` was passed, or why the gate could not tell. */
export type SeoArgument =
  | { kind: 'object'; text: string }
  | { kind: 'missing' }
  | { kind: 'unreadable'; detail: string }

/** One `key: value` pair at the top level of an object literal. */
export interface ObjectField {
  key: string
  /** The raw value expression, or null for the `{ shorthand }` form. */
  value: string | null
}

/**
 * The fields at depth 1 of an object literal — nested objects excluded.
 *
 * Depth matters. `useSeo({ title, description: post.description, schema: [
 * blogPostingSchema(site, { description: '…' }) ] })` contains two
 * `description` keys, and only one of them is this page's meta description.
 * A regex over the whole argument finds whichever comes first, so on
 * /pricing the rule passed only because `description` happens to be written
 * above `schema`.
 *
 * Returns the raw value text rather than a parsed value, so callers keep the
 * quoting and any `${}` interpolation intact — the length rule needs to know
 * the difference between a literal and a template.
 */
export function topLevelFields(objectText: string): ObjectField[] {
  const trimmed = objectText.trim()
  if (!trimmed.startsWith('{')) return []

  const fields: ObjectField[] = []
  const inner = trimmed.slice(1, -1)

  // Split on commas that sit at depth 0 of the object's own body. Strings and
  // comments are skipped by the shared scanner, so a comma inside either one
  // does not start a new field.
  const chunks: string[] = []
  let start = 0
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index] ?? ''
    if (char === "'" || char === '"' || char === '`') {
      const end = endOfString(inner, index)
      if (end === -1) return []
      index = end
      continue
    }
    if (char === '(' || char === '[' || char === '{') {
      const end = findClosing(inner, index)
      if (end === -1) return []
      index = end
      continue
    }
    if (char === ',') {
      chunks.push(inner.slice(start, index))
      start = index + 1
    }
  }
  chunks.push(inner.slice(start))

  for (const chunk of chunks) {
    // `key: value`, `'key': value`, or the `{ key }` shorthand. Anything else
    // (a spread, a computed key, a method) is not a field this gate reads.
    const named = /^\s*(['"]?)([A-Za-z_$][\w$]*)\1\s*:([\s\S]*)$/.exec(chunk)
    if (named) {
      fields.push({ key: named[2] ?? '', value: (named[3] ?? '').trim() })
      continue
    }
    const shorthand = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(chunk)
    if (shorthand) fields.push({ key: shorthand[1] ?? '', value: null })
  }

  return fields
}

/**
 * The object literal handed to `useSeo()`.
 *
 * Bounded by the call's own parentheses, so nothing outside them can be
 * mistaken for the argument. One indirection is followed — `useSeo(pageSeo)`
 * with a `const pageSeo = { … }` in the same file — because that is a real way
 * to write a page. Anything further (an imported constant, a function call, a
 * spread of computed values) is `unreadable`: the gate says so instead of
 * pretending to have checked.
 */
export function useSeoArgument(source: string): SeoArgument {
  const call = /\buseSeo\s*\(/.exec(source)
  if (!call) return { kind: 'missing' }

  const openParen = call.index + call[0].length - 1
  const closeParen = findClosing(source, openParen)
  if (closeParen === -1) {
    return { kind: 'unreadable', detail: "the useSeo() call's parentheses are unbalanced" }
  }

  const argument = source.slice(openParen + 1, closeParen).trim()

  if (argument.startsWith('{')) {
    const text = sliceBalanced(argument, 0)
    if (text === null) {
      return { kind: 'unreadable', detail: 'the useSeo() argument has unbalanced braces' }
    }
    return { kind: 'object', text }
  }

  const identifier = /^([A-Za-z_$][\w$]*)$/.exec(argument)?.[1]
  if (identifier) {
    const declaration = new RegExp(`\\bconst\\s+${identifier}\\s*=\\s*\\{`).exec(source)
    if (declaration) {
      const text = sliceBalanced(source, source.indexOf('{', declaration.index))
      if (text !== null) return { kind: 'object', text }
    }
    return {
      kind: 'unreadable',
      detail: `useSeo(${identifier}) — no local \`const ${identifier} = { … }\` to read`,
    }
  }

  return {
    kind: 'unreadable',
    detail: 'useSeo() was not passed an object literal or a local const holding one',
  }
}

/** What the gate could learn about the description handed to `useSeo()`. */
export interface SeoDescription {
  /** A description reached the composable. Every page owes this. */
  present: boolean
  /** Its text, when the gate can see it. Null means "computed at runtime". */
  literal: { quote: string; text: string } | null
}

/**
 * The `description` field of a `useSeo()` argument, and its text where that is
 * knowable.
 *
 * One hop through a local `const` is followed, because `useSeo({ description })`
 * above a `const description = 'A sentence…'` is the same page as writing it
 * inline. A value that resolves to anything else — a record field on a dynamic
 * page, a runtime-config read on the landing page — is present but unmeasurable,
 * which is the honest limit of reading source rather than running it.
 */
export function seoDescription(argument: string, source: string): SeoDescription {
  const field = topLevelFields(argument).find((entry) => entry.key === 'description')
  if (!field) return { present: false, literal: null }

  const asLiteral = (text: string | undefined) => {
    const match = /^(['"`])([\s\S]*)\1$/.exec((text ?? '').trim())
    return match ? { quote: match[1] ?? '', text: match[2] ?? '' } : null
  }

  const direct = field.value === null ? null : asLiteral(field.value)
  if (direct) return { present: true, literal: direct }

  // `{ description }` or `description: someIdentifier`.
  const identifier =
    field.value === null ? 'description' : /^([A-Za-z_$][\w$]*)$/.exec(field.value)?.[1]

  if (identifier) {
    const declared = new RegExp(`\\bconst\\s+${identifier}\\s*=\\s*(['"\`])([\\s\\S]*?)\\1`).exec(
      source,
    )
    return {
      present: true,
      literal: declared ? { quote: declared[1] ?? '', text: declared[2] ?? '' } : null,
    }
  }

  // A member expression, a call, a ternary — present, and not measurable here.
  return { present: field.value !== '', literal: null }
}
