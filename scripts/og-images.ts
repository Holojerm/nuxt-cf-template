// Per-page share cards — run by `bun run build`, before `nuxt build`.
//
// Draws one 1200x630 PNG per public page into public/og/ (gitignored), so each
// card ships as a static asset and nothing is added to the Worker. `useSeo()`
// links a page to `/og/<route>.png` through shared/utils/og.ts; the home page
// and any page without a card keep the site card, /og.png.
//
// Cards come from three places:
//   - every static page with a literal `definePageMeta({ publicPage })`
//     (title and summary are the card's text),
//   - every non-draft post in content/blog/,
//   - `layers/*/og-cards.ts`, whose default export returns OgCard[] — how a
//     fork's own layer cards the dynamic routes it enumerates (see .claude/docs/seo.md).
//
//   bun run scripts/og-images.ts           draw
//   bun run scripts/og-images.ts --check   after `nuxt build`: every card is in .output/public/og

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { ROOT } from './brand-inputs'
import { readFrontmatter } from './lib/frontmatter'
import { createOgRenderer } from './lib/og-render'
import { cardOfPage, ogCardFile, type OgCard } from './lib/og-source'
import { walk } from './lib/walk'

async function collectCards(): Promise<OgCard[]> {
  const cards = new Map<string, OgCard>()
  const add = (card: OgCard) => {
    if (card.path !== '/') cards.set(card.path, card)
  }

  const layerDirs = existsSync(join(ROOT, 'layers'))
    ? readdirSync(join(ROOT, 'layers'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(ROOT, 'layers', entry.name))
    : []

  const pageDirs = [join(ROOT, 'app/pages'), ...layerDirs.map((dir) => join(dir, 'app/pages'))]
  for (const file of pageDirs.flatMap((dir) =>
    walk(dir, { extensions: ['.vue'], missingOk: true }),
  )) {
    const card = cardOfPage(relative(ROOT, file).split('\\').join('/'), readFileSync(file, 'utf8'))
    if (card) add(card)
  }

  for (const file of walk(join(ROOT, 'content/blog'), { extensions: ['.md'], missingOk: true })) {
    const front = readFrontmatter(readFileSync(file, 'utf8'))
    if (front.draft === 'true' || !front.title) continue
    const slug = file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/, '')
    add({ path: `/blog/${slug}`, title: front.title, summary: front.description })
  }

  for (const dir of layerDirs) {
    const file = join(dir, 'og-cards.ts')
    if (!existsSync(file)) continue
    const source = (await import(file)) as { default: () => OgCard[] | Promise<OgCard[]> }
    for (const card of await source.default()) add(card)
  }

  return [...cards.values()].sort((a, b) => a.path.localeCompare(b.path))
}

const cards = await collectCards()

if (process.argv.includes('--check')) {
  const missing = cards.filter((card) => !existsSync(join(ROOT, '.output', ogCardFile(card.path))))
  if (missing.length > 0) {
    console.error(`og-images: ${missing.length} card(s) missing from .output/public:`)
    for (const card of missing) console.error(`  ${card.path}  (${ogCardFile(card.path)})`)
    process.exit(1)
  }
  console.info(`og-images: ${cards.length} cards present in .output/public/og`)
} else {
  rmSync(join(ROOT, 'public/og'), { recursive: true, force: true })
  const renderer = createOgRenderer()
  for (const card of cards) {
    const file = join(ROOT, ogCardFile(card.path))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, await renderer.render(card))
  }
  console.info(`og-images: drew ${cards.length} cards into public/og`)
}
