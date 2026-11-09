/** Frontmatter scalars, by key. Anything nested or multi-line is ignored. */
export function readFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}

  const fields: Record<string, string> = {}
  for (const line of (match[1] ?? '').split('\n')) {
    const field = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!field) continue
    const [, key = '', rawValue = ''] = field
    fields[key] = rawValue.trim().replace(/^(['"])([\s\S]*)\1$/, '$2')
  }
  return fields
}
