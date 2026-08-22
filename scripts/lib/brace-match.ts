// Finding the end of a bracketed span in TypeScript source, once.
//
// Two build gates need this and both used to carry their own loop:
// check-mirrors.ts, to lift a function body out of a file it cannot import, and
// check-seo.ts, to read the argument of a `useSeo()` call. Two copies of a
// scanner is two definitions of "balanced", and they had already diverged on
// what to do when the input is not.
//
// ── What this understands, and what it does not ─────────────────────────────
// It skips string literals (single, double, and template, including `${}`
// interpolation, which nests) and both comment forms, so a brace or paren
// inside a quoted string cannot end the span. That matters: the gates run over
// hand-written source, and `'a { b'` is a perfectly ordinary thing to write.
//
// It does NOT understand regular-expression literals — telling `/[)]/` from a
// division is not decidable without parsing, and neither caller has one in
// range. If that changes, the failure is loud rather than subtle: the span ends
// early, and check-mirrors' extracted function fails to compile while
// check-seo's rule fails closed.
//
// ── One error behaviour ─────────────────────────────────────────────────────
// Unbalanced input returns -1 / null. It never throws and never guesses at a
// span. Each caller decides what that means — check-mirrors turns it into a
// mirror failure, check-seo into a reported problem — but neither invents its
// own scan.

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/**
 * Index of the quote that ends the string literal starting at `start`, or -1.
 *
 * `start` must point at `'`, `"`, or a backtick. A `${` inside a template
 * literal re-enters code, so the expression's own strings and braces are
 * handled by recursing through `findClosing`.
 */
export function endOfString(source: string, start: number): number {
  const quote = source[start]
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index]
    if (char === '\\') {
      index++
      continue
    }
    if (char === quote) return index
    // An unescaped newline ends a non-template string: the source is broken,
    // and scanning on would silently swallow the rest of the file.
    if (quote !== '`' && char === '\n') return -1
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      const close = findClosing(source, index + 1)
      if (close === -1) return -1
      index = close
    }
  }
  return -1
}

/**
 * Index of the delimiter closing the one at `openIndex`, or -1 when the span is
 * unbalanced or `openIndex` does not point at `(`, `[`, or `{`.
 *
 * Only the opener's own pair is counted, which is sufficient for source that
 * nests properly — a `}` inside a paren span is simply not a `)`.
 */
export function findClosing(source: string, openIndex: number): number {
  const open = source[openIndex] ?? ''
  const close = PAIRS[open]
  if (!close) return -1

  let depth = 0
  for (let index = openIndex; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]

    if (char === '/' && next === '/') {
      const newline = source.indexOf('\n', index)
      if (newline === -1) return -1
      index = newline
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      if (end === -1) return -1
      index = end + 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const end = endOfString(source, index)
      if (end === -1) return -1
      index = end
      continue
    }

    if (char === open) depth++
    else if (char === close) {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * The bracketed span at `openIndex`, delimiters included, or null when
 * unbalanced.
 */
export function sliceBalanced(source: string, openIndex: number): string | null {
  const close = findClosing(source, openIndex)
  return close === -1 ? null : source.slice(openIndex, close + 1)
}

/**
 * A whole `function name(…) { … }` declaration, or null when it is absent or
 * unbalanced. Used by check-mirrors.ts to lift a function out of a file it
 * cannot import.
 */
export function extractFunction(source: string, name: string): string | null {
  const declaration = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(source)
  if (!declaration) return null

  const open = source.indexOf('{', declaration.index)
  if (open === -1) return null

  const close = findClosing(source, open)
  return close === -1 ? null : source.slice(declaration.index, close + 1)
}
