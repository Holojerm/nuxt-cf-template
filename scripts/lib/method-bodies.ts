// The source-reading half of `bun run methods:check` (scripts/check-method-bodies.ts).
//
// Strings in, answers out, so test/method-bodies.test.ts can drive every rule
// without a filesystem. The gate keeps the walk and the report.

/** Methods whose requests never carry a body on Workers. */
const BODYLESS = new Set(['get', 'head', 'delete'])

/**
 * A route file named `<name>.delete.ts` gives `delete`. Null for a route with no method
 * suffix (it answers every method) or a file that is not a route module.
 */
export function routeMethod(file: string): string | null {
  const match = /\.(get|head|post|put|patch|delete|options|connect|trace)\.(?:ts|js|mjs|mts)$/.exec(
    file,
  )
  return match?.[1] ?? null
}

export function isBodyless(method: string | null): boolean {
  return method !== null && BODYLESS.has(method)
}

/**
 * Blank out comments and string contents, keeping every newline and offset, so
 * a header comment that explains "this route used to call readBody()" does not
 * trip the gate and a `'// not a comment'` string does not hide real code.
 * Template-literal substitutions are treated as string text, which is wrong for
 * `${await readBody(event)}` and acceptable: nobody writes that.
 */
export function blankNonCode(source: string): string {
  let out = ''
  let i = 0
  const blank = (text: string) => text.replace(/[^\n]/g, ' ')
  while (i < source.length) {
    const ch = source[i]!
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      out += blank(source.slice(i, stop))
      i = stop
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      out += blank(source.slice(i, stop))
      i = stop
    } else if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < source.length && source[j] !== ch) j += source[j] === '\\' ? 2 : 1
      out += ch + blank(source.slice(i + 1, j)) + ch
      i = j + 1
    } else {
      out += ch
      i += 1
    }
  }
  return out
}

/** Every way a handler can pull a request body out of an h3 event. */
const BODY_READS = [
  /\b(readBody|readValidatedBody|readRawBody|readFormData|readMultipartFormData|getRequestWebStream)\s*\(/g,
  /\b(?:event\.(?:web\.request|req)|toWebRequest\(\s*event\s*\)|getWebRequest\(\s*event\s*\))\s*\.\s*(json|text|formData|arrayBuffer|blob|body)\b/g,
]

export interface BodyRead {
  line: number
  call: string
}

/** Marks a read as deliberate: `methods-check-ignore` on its line or the line above. */
export const IGNORE_MARKER = 'methods-check-ignore'

export function bodyReads(source: string): BodyRead[] {
  const code = blankNonCode(source)
  const rawLines = source.split('\n')
  const found: BodyRead[] = []
  for (const pattern of BODY_READS) {
    for (const match of code.matchAll(pattern)) {
      const line = code.slice(0, match.index).split('\n').length
      const ignored = [rawLines[line - 1], rawLines[line - 2]].some((l) =>
        l?.includes(IGNORE_MARKER),
      )
      if (!ignored) found.push({ line, call: (match[1] ?? match[0]).trim() })
    }
  }
  return found.sort((a, b) => a.line - b.line)
}
