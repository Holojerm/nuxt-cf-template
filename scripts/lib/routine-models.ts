// Routine model tiers — shared by `scripts/check-routine-models.ts` (the
// offline gate) and `scripts/routine-models.ts` (the online freshness check).
//
// A routine's frontmatter names a tier (`model: opus`), never a model ID. The
// one table in `.claude/routines/models.json` maps each tier to the exact ID
// `/routines sync` writes into the live routine, because the routines API
// accepts only an exact ID: `opus` and `sonnet` are refused as invalid models
// (tried 2026-11-25). A new release is then a one-line change to that table,
// not a hunt through every definition, which is how 30 live routines sat on
// Sonnet 5 a month after Sonnet 5.5 shipped.

export const TIERS = ['opus', 'sonnet', 'haiku'] as const
export type Tier = (typeof TIERS)[number]

export interface ModelTable {
  source: string
  tiers: Record<Tier, string>
}

const MODEL_ID = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value)
}

/** `claude-opus-5-5` → { tier: 'opus', version: [5, 5] }; null for anything else. */
export function parseModelId(id: string): { tier: Tier; version: [number, number] } | null {
  const match = MODEL_ID.exec(id)
  if (!match) return null
  const [, tier = '', major = '0', minor = '0'] = match
  if (!isTier(tier)) return null
  return { tier, version: [Number(major), Number(minor)] }
}

function compareVersion(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1]
}

/** Problems with the table itself: a missing tier, or an ID that is not that tier's. */
export function tableProblems(table: unknown): string[] {
  if (!table || typeof table !== 'object') return ['models.json is not an object']
  const tiers = (table as { tiers?: unknown }).tiers
  if (!tiers || typeof tiers !== 'object') return ['models.json has no `tiers` object']

  const problems: string[] = []
  for (const tier of TIERS) {
    const id = (tiers as Record<string, unknown>)[tier]
    if (typeof id !== 'string') {
      problems.push(`tier \`${tier}\` has no model ID`)
      continue
    }
    const parsed = parseModelId(id)
    if (!parsed || parsed.tier !== tier)
      problems.push(
        `tier \`${tier}\` maps to \`${id}\`, which is not a claude-${tier}-<version> ID`,
      )
  }
  for (const key of Object.keys(tiers))
    if (!isTier(key)) problems.push(`unknown tier \`${key}\` (tiers are ${TIERS.join(', ')})`)
  return problems
}

/**
 * The tier a routine's `model:` line names, or a problem. The value may carry a
 * trailing `# comment`, which the shared frontmatter reader keeps.
 */
export function routineModelProblem(model: string | undefined): string | null {
  if (model === undefined) return 'no `model:` line'
  const value = model.replace(/\s+#.*$/, '').trim()
  if (isTier(value)) return null
  const parsed = parseModelId(value)
  if (parsed)
    return `\`model: ${value}\` pins a version; write \`model: ${parsed.tier}\` and let models.json name the ID`
  return `\`model: ${value}\` is not a tier (${TIERS.join(', ')})`
}

/** A row of frontier-terminal's `GET /api/prices` catalog — only the fields read here. */
export interface PriceRow {
  provider: string
  model_slug: string
  removed: boolean
}

/**
 * The newest model ID per tier among the Anthropic rows still on the price
 * list. A row the source has since removed is skipped, so a retired model can
 * never be picked; so is any slug that is not a plain `claude-<tier>-<version>`
 * (the catalog also carries rows like `claude-haiku-5-5-(for-prompts-…)`).
 */
export function newestByTier(rows: readonly PriceRow[]): Partial<Record<Tier, string>> {
  const best: Partial<Record<Tier, { id: string; version: [number, number] }>> = {}
  for (const row of rows) {
    if (row.provider !== 'anthropic' || row.removed) continue
    const parsed = parseModelId(row.model_slug)
    if (!parsed) continue
    const current = best[parsed.tier]
    if (!current || compareVersion(parsed.version, current.version) > 0)
      best[parsed.tier] = { id: row.model_slug, version: parsed.version }
  }
  const result: Partial<Record<Tier, string>> = {}
  for (const tier of TIERS) {
    const entry = best[tier]
    if (entry) result[tier] = entry.id
  }
  return result
}

/** Tiers where the source lists a newer model than the table. */
export function behind(
  table: ModelTable,
  newest: Partial<Record<Tier, string>>,
): Array<{ tier: Tier; current: string; newest: string }> {
  const out: Array<{ tier: Tier; current: string; newest: string }> = []
  for (const tier of TIERS) {
    const latest = newest[tier]
    const current = parseModelId(table.tiers[tier])
    const candidate = latest ? parseModelId(latest) : null
    if (latest && current && candidate && compareVersion(candidate.version, current.version) > 0)
      out.push({ tier, current: table.tiers[tier], newest: latest })
  }
  return out
}
