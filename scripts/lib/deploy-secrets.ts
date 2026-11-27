// The rule behind `bun run deploy:secrets`: which of the secrets fleet.json says
// production needs are absent from the Worker. Pure, no wrangler, no network.

/**
 * Parse `wrangler secret list --format json` output into secret names. Wrangler
 * prints warnings (the proxy notice, update nags) around the JSON, and those carry
 * brackets of their own ("[WARNING]"), so the array starts at the first line that
 * opens with `[` followed by nothing, `{` or `]`, and ends at the last `]`.
 * Returns null when no JSON array of `{ name }` objects can be found.
 */
export function parseSecretList(stdout: string): string[] | null {
  const open = /^[ \t]*\[[ \t]*(?:$|\{|\])/m.exec(stdout)
  if (!open) return null
  const start = open.index
  const end = stdout.lastIndexOf(']')
  if (end < start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1))
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const names: string[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) return null
    const name = (entry as { name?: unknown }).name
    if (typeof name !== 'string') return null
    names.push(name)
  }
  return names
}

/** The required names the Worker does not have, in the manifest's order. */
export function missingSecrets(required: readonly string[], present: readonly string[]): string[] {
  const have = new Set(present)
  return required.filter((name) => !have.has(name))
}
