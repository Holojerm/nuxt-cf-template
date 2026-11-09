// Pure helpers behind `scripts/og-images.ts`, kept free of fs and fonts so
// vitest can drive them (test/og-cards.test.ts).

import { ogCardPath } from '../../shared/utils/og'

export interface OgCard {
  /** The route this card represents: `/pricing`, `/blog/hello`. */
  path: string
  title: string
  /** One line of context under the title. Optional. */
  summary?: string
}

/** The output file for a card, relative to the project root. */
export function ogCardFile(path: string): string {
  return `public${ogCardPath(path)}`
}

/** `app/pages/blog/index.vue` → `/blog`; dynamic segments → null. */
export function routeOfPageFile(relative: string): string | null {
  const match = relative.match(/(?:^|\/)app\/pages\/(.+)\.vue$/)
  if (!match) return null
  const segments = match[1]!.split('/')
  if (segments.some((segment) => segment.includes('[') || segment.startsWith('_'))) return null
  if (segments.at(-1) === 'index') segments.pop()
  return `/${segments.join('/')}`
}

function literal(source: string, key: string): string | null {
  const match = source.match(
    new RegExp(
      `\\b${key}\\s*:\\s*(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)"|\`([^\`]*)\`)`,
    ),
  )
  const value = match?.[1] ?? match?.[2] ?? match?.[3]
  return value === undefined ? null : value.replace(/\\(['"`\\])/g, '$1')
}

/**
 * The card a page file asks for, from its literal `publicPage` block, or null
 * when the page is private, noindex, or the block is not literal (Nuxt requires
 * literals there, so this only skips pages that would not be public anyway).
 */
export function cardOfPage(relative: string, source: string): OgCard | null {
  const path = routeOfPageFile(relative)
  if (path === null) return null
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  if (/\bnoindex\s*:\s*true\b/.test(code)) return null
  const block = code.match(/\bpublicPage\s*:\s*\{([\s\S]*?)\n\s*\},?\s*\n/)?.[1]
  if (!block) return null
  const title = literal(block, 'title')
  if (!title) return null
  const summary = literal(block, 'summary') ?? undefined
  return { path, title, summary }
}

/** Shortens to the nearest word boundary under `max`, with an ellipsis. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max).replace(/\s+\S*$/, '')
  return `${cut.replace(/[\s,.;:–—-]+$/, '')}…`
}

/** Title size on the 1200x630 canvas: longer titles step down so they keep to three lines. */
export function titleSize(title: string): number {
  if (title.length <= 22) return 112
  if (title.length <= 40) return 92
  if (title.length <= 64) return 76
  return 64
}
