// Design token gate — run with `bun run design:check`, wired into `bun run ci`.
//
// DESIGN.md is only a contract if something enforces it. Without this, agents
// and humans drift back to `text-gray-900` and `rounded-lg` around feature #4
// and the app's design personality quietly dissolves into Tailwind defaults.
//
// Scans app/ for values that bypass the token layer. Everything flagged here
// has a semantic equivalent declared in DESIGN.md.
//
// Escape hatch: put `design-check-ignore` in a comment on the same line or the
// line directly above. Use it for genuine exceptions (a third-party brand
// color, a canvas fill) — not to silence a rule you find inconvenient.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const SCAN_DIR = join(ROOT, 'app')
const SCAN_EXTENSIONS = ['.vue', '.ts', '.css']

// Generated from DESIGN.md — these are where raw values are supposed to live.
const EXEMPT_FILES = ['app/assets/css/main.css', 'app/app.config.ts']

const TAILWIND_PALETTES = [
  'slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber',
  'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue',
  'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
  // The app's own custom ramp — reachable only through semantic tokens.
  'clay',
].join('|')

const COLOR_UTILITIES = [
  'text', 'bg', 'border', 'ring', 'divide', 'from', 'via', 'to', 'outline',
  'decoration', 'accent', 'caret', 'fill', 'stroke', 'placeholder', 'shadow',
].join('|')

interface Rule {
  name: string
  pattern: RegExp
  remedy: string
}

const RULES: Rule[] = [
  {
    name: 'numbered color scale',
    pattern: new RegExp(`\\b(?:${COLOR_UTILITIES})-(?:${TAILWIND_PALETTES})-(?:50|\\d{3})\\b`, 'g'),
    remedy: 'use a semantic token (DESIGN.md › Color › Surface and text rules)',
  },
  {
    name: 'raw hex color',
    pattern: /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g,
    remedy: 'add it to the ramp in DESIGN.md › Color, then /design-sync',
  },
  {
    name: 'dead shadcn token',
    pattern: /\b(?:text-foreground|bg-background|border-border|bg-foreground|text-background)\b/g,
    remedy: 'not a NuxtUI v4 class — use text-highlighted / bg-default / border-default',
  },
  {
    name: 'arbitrary type size',
    pattern: /\btext-\[[^\]]+\]/g,
    remedy: 'use a step from DESIGN.md › Typography › Scale',
  },
  {
    name: 'arbitrary radius',
    pattern: /\brounded(?:-[a-z]+)?-\[[^\]]+\]/g,
    remedy: '--ui-radius drives all radii (DESIGN.md › Space, shape, elevation)',
  },
  {
    name: 'static inline style',
    pattern: /\sstyle="/g,
    remedy: 'use utilities; :style is allowed only for animated dynamic values',
  },
]

function walk(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...walk(full))
    } else if (SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      found.push(full)
    }
  }
  return found
}

interface Violation {
  file: string
  line: number
  rule: Rule
  match: string
  source: string
}

const violations: Violation[] = []

for (const file of walk(SCAN_DIR)) {
  const relativePath = relative(ROOT, file)
  if (EXEMPT_FILES.includes(relativePath)) continue

  const lines = readFileSync(file, 'utf8').split('\n')

  lines.forEach((source, index) => {
    const previous = lines[index - 1] ?? ''
    if (source.includes('design-check-ignore') || previous.includes('design-check-ignore')) return

    for (const rule of RULES) {
      rule.pattern.lastIndex = 0
      for (const match of source.matchAll(rule.pattern)) {
        violations.push({
          file: relativePath,
          line: index + 1,
          rule,
          match: match[0].trim(),
          source: source.trim(),
        })
      }
    }
  })
}

if (violations.length === 0) {
  console.info('design:check — no token violations')
  process.exit(0)
}

console.error(`\ndesign:check failed — ${violations.length} token violation(s)\n`)
for (const { file, line, rule, match, source } of violations) {
  console.error(`  ${file}:${line}  ${rule.name}: ${match}`)
  console.error(`    ${source.length > 96 ? `${source.slice(0, 96)}…` : source}`)
  console.error(`    → ${rule.remedy}\n`)
}
console.error('DESIGN.md is the contract. Change it there and run /design-sync,')
console.error('or add `design-check-ignore` if this is a genuine exception.\n')
process.exit(1)
