// The `[[ratelimits]] namespace_id` a renamed project gets.
//
// The namespace is scoped to the Cloudflare ACCOUNT, not the Worker, so two
// apps on one account that both ship "1001" share one set of counters — a
// sign-in burst on one throttles the other, and nothing in the logs says why.
// Every fork therefore needs its own pair, and `bun run rename` derives it
// from the name rather than leaving a number to remember: stable (the same
// name always gets the same ids), spread across 1100–9999 so the template's
// own 1001/1002 are never produced, and preview = production + 1.

export const NAMESPACE_MIN = 1100
export const NAMESPACE_MAX = 9999

/** FNV-1a, 32-bit — small, dependency-free, and stable across runtimes. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export interface NamespaceIds {
  production: number
  preview: number
}

export function deriveNamespaceIds(name: string): NamespaceIds {
  // Even numbers only, so production + 1 for preview never collides with
  // another name's production id.
  const slots = Math.floor((NAMESPACE_MAX - NAMESPACE_MIN) / 2)
  const production = NAMESPACE_MIN + (fnv1a(name) % slots) * 2
  return { production, preview: production + 1 }
}

/**
 * Rewrite every `namespace_id = "…"` in a wrangler.toml: blocks under
 * `[[env.preview.ratelimits]]` get the preview id, every other `[[ratelimits]]`
 * block the production one. Returns the new text and how many ids changed.
 */
export function rewriteNamespaceIds(
  toml: string,
  ids: NamespaceIds,
): { toml: string; replaced: number } {
  let replaced = 0
  let current: 'production' | 'preview' | null = null
  const lines = toml.split('\n').map((line) => {
    const header = /^\s*\[\[([^\]]+)\]\]/.exec(line)
    if (header) {
      const table = header[1]!
      current = table.endsWith('ratelimits')
        ? table.startsWith('env.preview')
          ? 'preview'
          : 'production'
        : null
      return line
    }
    if (current && /^\s*namespace_id\s*=/.test(line)) {
      replaced++
      return line.replace(/namespace_id\s*=\s*"[^"]*"/, `namespace_id = "${ids[current]}"`)
    }
    return line
  })
  return { toml: lines.join('\n'), replaced }
}
