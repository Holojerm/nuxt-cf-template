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
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
  // The app's own custom ramp — reachable only through semantic tokens.
  'clay',
].join('|')

const COLOR_UTILITIES = [
  'text',
  'bg',
  'border',
  'ring',
  'divide',
  'from',
  'via',
  'to',
  'outline',
  'decoration',
  'accent',
  'caret',
  'fill',
  'stroke',
  'placeholder',
  'shadow',
].join('|')

interface Rule {
  name: string
  pattern: RegExp
  remedy: string
  /** `line` matches within a single line (the default). `file` matches across the whole
   *  file, for markup whose attributes wrap onto several lines. */
  scope?: 'line' | 'file'
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

  // ── Accessibility (DESIGN.md › Accessibility) ──────────────────────────────
  // These are the subset of that section a regex can see. Contrast ratios,
  // heading order, and whether a label actually describes its field are not
  // machine-checkable here — they stay on review.
  {
    name: 'suppressed focus outline',
    pattern: /\boutline-none\b|outline:\s*none/g,
    remedy: 'focus must stay visible (DESIGN.md › Accessibility › Keyboard and focus)',
  },
  {
    name: 'fixed viewport height',
    pattern: /\b(?:min-|max-)?h-screen\b|\b(?:min-|max-)?h-\[100vh\]/g,
    remedy: 'use the dvh equivalent — 100vh overflows on mobile (DESIGN.md › Viewport and touch)',
  },
  {
    name: 'positive tabindex',
    pattern: /tabindex="[1-9]/g,
    remedy: 'let DOM order drive focus order; -1 is the only allowed value',
  },
  {
    name: 'image without alt',
    pattern: /<(?:img|UAvatar)\b(?:(?!>)[\s\S])*?\/?>/g,
    remedy: 'add alt (alt="" if decorative) — DESIGN.md › Accessibility › Structure and labels',
    scope: 'file',
  },
  {
    name: 'icon-only button without aria-label',
    pattern: /<UButton\b(?:(?!>)[\s\S])*?\/>/g,
    remedy: 'an icon is not an accessible name — add aria-label or a label',
    scope: 'file',
  },
  {
    name: 'icon-only button below the touch floor',
    pattern: /<UButton\b(?:(?!>)[\s\S])*?\/>/g,
    remedy: 'add the min-touch utility (DESIGN.md › Accessibility › Viewport and touch)',
    scope: 'file',
  },
]

/** Rules whose regex intentionally over-matches, narrowed here rather than in the
 *  pattern — a single regex for "tag that lacks attribute X" is unreadable and
 *  breaks on attribute order. Returns true when the match is a real violation. */
const REFINEMENTS: Record<string, (match: string) => boolean> = {
  'image without alt': (match) => !/\s:?alt[=\s]/.test(match),
  'icon-only button without aria-label': (match) =>
    /\s:?icon[=\s]/.test(match) &&
    !/\s:?label[=\s]/.test(match) &&
    !/\saria-label[=\s]/.test(match),
  // An icon-only button is square and small by construction — the one control
  // that reliably lands under 44px on a phone.
  'icon-only button below the touch floor': (match) =>
    /\s:?icon[=\s]/.test(match) && !/\s:?label[=\s]/.test(match) && !/\bmin-touch\b/.test(match),
}

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

/** Multi-line matches are unreadable in a one-line report. */
const collapse = (text: string) => text.trim().replace(/\s+/g, ' ')

for (const file of walk(SCAN_DIR)) {
  const relativePath = relative(ROOT, file)
  if (EXEMPT_FILES.includes(relativePath)) continue

  const content = readFileSync(file, 'utf8')
  const lines = content.split('\n')

  // A match is suppressed by `design-check-ignore` on its own line or the one
  // above it. For a file-scope rule that means the line the match *starts* on —
  // the escape hatch goes where a reader would naturally put it.
  const ignored = (index: number) =>
    (lines[index] ?? '').includes('design-check-ignore') ||
    (lines[index - 1] ?? '').includes('design-check-ignore')

  const record = (rule: Rule, match: string, index: number) => {
    const refine = REFINEMENTS[rule.name]
    if (refine && !refine(match)) return
    if (ignored(index)) return
    violations.push({
      file: relativePath,
      line: index + 1,
      rule,
      match: collapse(match),
      source: collapse(lines[index] ?? ''),
    })
  }

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0

    if (rule.scope === 'file') {
      for (const match of content.matchAll(rule.pattern)) {
        // Offset → line number, by counting newlines before the match.
        const index = content.slice(0, match.index).split('\n').length - 1
        record(rule, match[0], index)
      }
      continue
    }

    lines.forEach((source, index) => {
      rule.pattern.lastIndex = 0
      for (const match of source.matchAll(rule.pattern)) record(rule, match[0], index)
    })
  }
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
