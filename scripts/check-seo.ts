// SEO/AEO gate — run with `bun run seo:check`, wired into `bun run ci`.
//
// Same reasoning as scripts/check-design-tokens.ts: the SEO layer is only a
// contract if something enforces it. Nothing about a missing canonical tag or
// an unlisted page *fails* — the app builds, the page renders, and you find out
// months later from a traffic graph. That delay is exactly why it needs a gate
// and not a convention.
//
// Rules, all of them things this template has wired and can therefore expect:
//
//   1. Every page calls useSeo() exactly once. It is the only thing that emits
//      a canonical tag, Open Graph, and JSON-LD.
//   2. No page calls useSeoMeta()/useHead() to set SEO tags directly, which
//      would bypass all of the above while looking correct.
//   3. Indexable pages declare `definePageMeta({ publicPage: … })`, so they
//      reach sitemap.xml and llms.txt. noindex pages must not.
//   4. Descriptions are present everywhere, and a sensible length on the pages
//      where one is actually shown — a description Google truncates or rewrites
//      is a description you didn't write. noindex pages are exempt from the
//      length rules: nothing renders their snippet, so a rule there would be
//      busywork with a build failure attached.
//   5. Exactly one <h1> per page. Cheap to check, and the single most common
//      real regression in a component-composed page.
//   6. Blog posts carry the same contract in their frontmatter, plus one <h1>
//      and dates that are well-formed, in the past, and in the right order. A
//      post is a page whose copy lives in markdown rather than in a .vue file,
//      and rules 4 and 5 have to follow it there or they stop applying to the
//      pages most likely to be written in a hurry. See the second walk below.
//
// Escape hatch: `seo-check-ignore` in a comment on the same line or the line
// above, matching the design-token gate's convention.
//
// The string-reading half of rule 4 lives in scripts/lib/seo-source.ts, so it
// can be driven by ordinary vitest cases (test/seo-source.test.ts) instead of
// by fixtures embedded in a build script. What is left here is the walk, the
// rules, and the report.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { DESCRIPTION_MAX, DESCRIPTION_MIN, TITLE_MAX } from '../shared/utils/seo-bounds'
import { seoDescription, useSeoArgument } from './lib/seo-source'

const ROOT = resolve(import.meta.dir, '..')
const PAGES_DIR = join(ROOT, 'app', 'pages')
const POSTS_DIR = join(ROOT, 'content', 'blog')

interface Problem {
  file: string
  rule: string
  detail: string
  remedy: string
}

function walk(dir: string, extension = '.vue'): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...walk(full, extension))
    else if (entry.endsWith(extension)) found.push(full)
  }
  return found
}

/** Strip comments so an example in a doc block can't trip a rule. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

function ignored(source: string, needle: string): boolean {
  const lines = source.split('\n')
  return lines.some((line, index) => {
    if (!line.includes(needle)) return false
    const previous = lines[index - 1] ?? ''
    return line.includes('seo-check-ignore') || previous.includes('seo-check-ignore')
  })
}

const problems: Problem[] = []

for (const file of walk(PAGES_DIR)) {
  const relativePath = relative(ROOT, file)
  const raw = readFileSync(file, 'utf8')
  const source = stripComments(raw)

  // ── 1. exactly one useSeo() ────────────────────────────────────────────────
  const seoCalls = source.match(/\buseSeo\s*\(/g)?.length ?? 0
  if (seoCalls === 0) {
    problems.push({
      file: relativePath,
      rule: 'missing useSeo()',
      detail: 'page emits no title, description, canonical, or structured data',
      remedy: 'call useSeo({ title, description }) — add noindex: true if it is private',
    })
    continue
  }
  if (seoCalls > 1) {
    problems.push({
      file: relativePath,
      rule: 'duplicate useSeo()',
      detail: `called ${seoCalls} times`,
      remedy: 'call it once — the last call silently wins for some tags and merges for others',
    })
  }

  // ── 2. nothing bypasses it ─────────────────────────────────────────────────
  if (/\buseSeoMeta\s*\(/.test(source) && !ignored(raw, 'useSeoMeta')) {
    problems.push({
      file: relativePath,
      rule: 'useSeoMeta() bypass',
      detail: 'sets meta tags without a canonical tag or JSON-LD',
      remedy: 'move it into useSeo() — see app/composables/useSeo.ts',
    })
  }
  if (/\buseHead\s*\(\s*\{[\s\S]{0,400}?\b(?:title|meta|link)\s*:/.test(source)) {
    if (!ignored(raw, 'useHead')) {
      problems.push({
        file: relativePath,
        rule: 'useHead() bypass',
        detail: 'sets title/meta/link outside useSeo()',
        remedy: 'move it into useSeo(), or add `seo-check-ignore` if it is genuinely unrelated',
      })
    }
  }

  // ── 3. indexable ⇔ declared public ─────────────────────────────────────────
  const noindex = /\bnoindex\s*:\s*true\b/.test(source)
  const declaresPublic = /\bpublicPage\s*:\s*\{/.test(source)

  if (!noindex && !declaresPublic) {
    problems.push({
      file: relativePath,
      rule: 'indexable page not declared public',
      detail: 'absent from sitemap.xml and llms.txt',
      remedy:
        'add definePageMeta({ publicPage: { changefreq, priority, title, summary } }), or noindex: true',
    })
  }
  if (noindex && declaresPublic) {
    problems.push({
      file: relativePath,
      rule: 'noindex page declared public',
      detail: 'listed in sitemap.xml while telling crawlers not to index it',
      remedy: 'drop the publicPage meta, or drop noindex — the two contradict each other',
    })
  }

  // ── 4. description quality ─────────────────────────────────────────────────
  //
  // Read out of the useSeo() argument, bounded by the call's own parentheses —
  // never out of the whole file. See scripts/lib/seo-source.ts for why that
  // distinction is the difference between this rule working and this rule
  // appearing to work.
  //
  // Two separate claims: a description reached useSeo() at all, and — when the
  // gate can see its text — that text is a length a search result will print
  // rather than truncate. A description computed at runtime satisfies the first
  // and is exempt from the second, which is the honest limit of a source scan.
  const argument = useSeoArgument(source)
  if (argument.kind === 'unreadable') {
    // Fail closed. The gate cannot see what this page publishes, and reporting
    // nothing would be indistinguishable from reporting that it is fine.
    problems.push({
      file: relativePath,
      rule: 'unreadable useSeo() argument',
      detail: argument.detail,
      remedy:
        'pass an object literal, or a local `const x = { … }` — the gate reads source, ' +
        'so it cannot follow an import or a function call',
    })
  }

  const description =
    argument.kind === 'object'
      ? seoDescription(argument.text, source)
      : { present: false, literal: null }

  // An unreadable argument has already been reported; do not also claim the
  // description is missing, which would be a guess.
  if (!description.present && argument.kind === 'object') {
    problems.push({
      file: relativePath,
      rule: 'missing description',
      detail: 'no description passed to useSeo()',
      remedy: 'write one sentence describing what is on this page',
    })
  } else if (description.literal && !noindex) {
    const { quote, text } = description.literal
    const interpolated = quote === '`' && text.includes('${')
    // Interpolated values expand at runtime, so only flag a too-short literal
    // when there is nothing to expand.
    if (!interpolated && text.length < DESCRIPTION_MIN) {
      problems.push({
        file: relativePath,
        rule: 'description too short',
        detail: `${text.length} chars, minimum ${DESCRIPTION_MIN}`,
        remedy: 'search results and answer engines both quote this — make it a real sentence',
      })
    }
    if (text.length > DESCRIPTION_MAX) {
      problems.push({
        file: relativePath,
        rule: 'description too long',
        detail: `${text.length} chars, maximum ${DESCRIPTION_MAX}`,
        remedy: `Google truncates near ${DESCRIPTION_MAX} — say it shorter or it gets said for you`,
      })
    }
  }

  // ── 5. exactly one h1 ──────────────────────────────────────────────────────
  const template = raw.split('<template>').slice(1).join('<template>')
  const h1Count = template.match(/<h1[\s>]/g)?.length ?? 0
  if (h1Count > 1) {
    problems.push({
      file: relativePath,
      rule: 'multiple <h1>',
      detail: `${h1Count} found`,
      remedy: 'one h1 per page — demote the rest to h2',
    })
  }
}

// ── 6. blog frontmatter ──────────────────────────────────────────────────────
//
// The same contract as rule 4, applied where a post's copy actually lives. This
// is not duplicated enforcement: content.config.ts declares these bounds, but
// @nuxt/content converts a collection schema into SQL columns and does NOT run
// its refinements against your frontmatter — a 300-character description parses
// fine and ships. Nothing else would ever notice.
//
// A deliberately small YAML reader: these files are written by hand in a fixed
// shape, and a parser dependency to read four scalar keys would be a strange
// thing to add to a build gate.

/** Frontmatter scalars, by key. Anything nested or multi-line is ignored. */
function readFrontmatter(raw: string): Record<string, string> {
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

/** Everything after the frontmatter, with fenced code blocks removed. */
function postBody(raw: string): string {
  const withoutFrontmatter = raw.replace(/^---\r?\n[\s\S]*?\r?\n---/, '')
  // A `#` at the start of a line inside a fence is a comment in some language,
  // not a heading. Dropping fences first is cheaper and more honest than
  // trying to tell the two apart in one regex.
  return withoutFrontmatter.replace(/^```[\s\S]*?^```/gm, '')
}

/** Today in UTC, `YYYY-MM-DD`. Compared as a string — ISO dates sort correctly. */
const TODAY = new Date().toISOString().slice(0, 10)

if (existsSync(POSTS_DIR)) {
  for (const file of walk(POSTS_DIR, '.md')) {
    const relativePath = relative(ROOT, file)
    const raw = readFileSync(file, 'utf8')
    const front = readFrontmatter(raw)
    // YAML booleans arrive here as the string they were written as.
    const isDraft = front.draft === 'true'

    const report = (rule: string, detail: string, remedy: string) =>
      problems.push({ file: relativePath, rule, detail, remedy })

    if (!front.title) {
      report('post missing title', 'no `title` in frontmatter', 'add one — it becomes the <h1>')
    } else if (front.title.length > TITLE_MAX) {
      report(
        'post title too long',
        `${front.title.length} chars, maximum ${TITLE_MAX}`,
        'Google truncates a long title and substitutes its own — write a shorter one',
      )
    }

    // Rule 5, for markdown. The page renders `title` as the <h1>, so a level-1
    // heading in the body is a second one — and nothing else catches it: rule 5
    // above only reads .vue templates, and axe has no duplicate-h1 rule, so the
    // a11y sweep is green either way. DESIGN.md › Accessibility asks for one.
    const bodyH1 = /^#[ \t]+\S/m.exec(postBody(raw))
    if (bodyH1) {
      report(
        'post body has its own <h1>',
        `body starts a level-1 heading: ${bodyH1[0].trim()}…`,
        'the page renders `title` as the <h1> — start the body at `##`',
      )
    }

    if (!front.description) {
      report(
        'post missing description',
        'no `description` in frontmatter',
        'this is the search snippet, the og:description, and the llms.txt line — write it',
      )
    } else if (front.description.length < DESCRIPTION_MIN) {
      report(
        'post description too short',
        `${front.description.length} chars, minimum ${DESCRIPTION_MIN}`,
        'search results and answer engines both quote this — make it a real sentence',
      )
    } else if (front.description.length > DESCRIPTION_MAX) {
      report(
        'post description too long',
        `${front.description.length} chars, maximum ${DESCRIPTION_MAX}`,
        `Google truncates near ${DESCRIPTION_MAX} — say it shorter or it gets said for you`,
      )
    }

    // The dates are the post's `<lastmod>` and its `datePublished`. A missing
    // one leaves both null, which reads to a crawler as an undated article.
    const wellFormed = (value: string | undefined) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '')

    if (!wellFormed(front.date)) {
      report(
        'post date missing or malformed',
        `date: ${front.date ?? '(absent)'}`,
        "quote it and write it as 'YYYY-MM-DD' — it becomes <lastmod> and datePublished",
      )
    } else if (front.date! > TODAY && !isDraft) {
      // A future date on a PUBLISHED post is almost always a typo (a year
      // rolled forward, a month transposed), and it is the one wrong value that
      // damages rather than merely misinforms: a `datePublished` in the future
      // is a signal search engines treat as manipulation, and a `<lastmod>`
      // that has not happened yet trains a crawler to stop trusting the whole
      // file. String comparison is exact for zero-padded ISO dates, and UTC
      // keeps CI's timezone out of it.
      //
      // Skipped for a draft, and only this check is skipped. The remedy below
      // tells the writer to set `draft: true`, so refusing to accept the result
      // would be the gate arguing with its own advice — and a draft reaches no
      // crawler: it is filtered out of /blog, sitemap.xml, and llms.txt, and
      // 404s in production. Dating one next Tuesday is exactly how you stage a
      // post you intend to publish next Tuesday.
      report(
        'post dated in the future',
        `date: ${front.date} (today is ${TODAY} UTC)`,
        "publish it with today's date, or mark it `draft: true` until it is real",
      )
    }

    if (front.updated !== undefined) {
      if (!wellFormed(front.updated)) {
        report(
          'post updated date malformed',
          `updated: ${front.updated}`,
          "quote it and write it as 'YYYY-MM-DD', or remove the key",
        )
      } else if (front.updated > TODAY && !isDraft) {
        report(
          'post updated in the future',
          `updated: ${front.updated} (today is ${TODAY} UTC)`,
          'this becomes <lastmod> — a revision that has not happened cannot be advertised',
        )
      } else if (wellFormed(front.date) && front.updated < front.date!) {
        // blogPostLastmod() returns `updated || date`, so this would publish a
        // lastmod older than the article itself.
        report(
          'post updated before it was published',
          `updated: ${front.updated} precedes date: ${front.date}`,
          'the two are probably swapped — `updated` is the later of the pair',
        )
      }
    }

    if (!front.author) {
      report(
        'post missing author',
        'no `author` in frontmatter',
        'it becomes the JSON-LD author — use the legal entity to attribute it to the company',
      )
    }
  }
}

if (problems.length === 0) {
  console.info('seo:check — no problems')
  process.exit(0)
}

console.error(`\nseo:check failed — ${problems.length} problem(s)\n`)
for (const { file, rule, detail, remedy } of problems) {
  console.error(`  ${file}  ${rule}`)
  console.error(`    ${detail}`)
  console.error(`    → ${remedy}\n`)
}
console.error('app/composables/useSeo.ts is the contract. Add `seo-check-ignore`')
console.error('on the line above if this is a genuine exception.\n')
process.exit(1)
