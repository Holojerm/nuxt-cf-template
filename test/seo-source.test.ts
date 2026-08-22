// The source-reading half of `bun run seo:check`.
//
// These functions decide what a green SEO gate means, and every one of the bugs
// below shipped green: the extractor grabbed an object from the wrong part of
// the file, the description regex matched at any nesting depth, and the gate's
// own embedded fixtures all used the one call shape that happened to work.
//
// They live in scripts/lib/ precisely so they can be tested here — no
// filesystem, no Nuxt, just strings in and answers out. The gate keeps the walk
// and the reporting; everything with a rule in it is below.

import { describe, expect, it } from 'vitest'

import { endOfString, extractFunction, findClosing } from '../scripts/lib/brace-match'
import { seoDescription, topLevelFields, useSeoArgument } from '../scripts/lib/seo-source'

describe('findClosing', () => {
  it('matches its own delimiter through nested pairs', () => {
    const source = 'useSeo({ a: [1, 2], b: f(3) })'
    expect(findClosing(source, source.indexOf('('))).toBe(source.length - 1)
    expect(source.slice(source.indexOf('{'), findClosing(source, source.indexOf('{')) + 1)).toBe(
      '{ a: [1, 2], b: f(3) }',
    )
  })

  it('ignores delimiters inside string literals', () => {
    // The reason this scanner exists rather than a depth counter: `'a { b'` is
    // an ordinary thing to write, and a naive count ends the span in the wrong
    // place — silently, with a plausible-looking result.
    const source = `{ title: 'a { b', description: "c ) d", raw: \`e } f\` }`
    expect(findClosing(source, 0)).toBe(source.length - 1)
  })

  it('handles template interpolation, which re-enters code', () => {
    const source = '{ a: `x ${ { y: 1 } } z` }'
    expect(findClosing(source, 0)).toBe(source.length - 1)
  })

  it('ignores delimiters inside comments', () => {
    const source = '{ a: 1, /* } */ b: 2 } // }'
    expect(source.slice(0, findClosing(source, 0) + 1)).toBe('{ a: 1, /* } */ b: 2 }')
  })

  it('returns -1 rather than guessing when the span never closes', () => {
    expect(findClosing('{ a: 1', 0)).toBe(-1)
    expect(findClosing("{ a: 'unterminated", 0)).toBe(-1)
    // Not an opening delimiter at all.
    expect(findClosing('abc', 0)).toBe(-1)
  })

  it('stops an unescaped newline from swallowing the rest of the file', () => {
    expect(endOfString("'no closing quote\nnext line'", 0)).toBe(-1)
    expect(endOfString("'it\\'s escaped'", 0)).toBe(14)
  })
})

describe('extractFunction', () => {
  // What check-mirrors.ts relies on to compare two implementations of one rule.
  const source = [
    'export function normalizeEmail(email: string): string {',
    '  return email.trim().toLowerCase()',
    '}',
    '',
    'function other() { return "}" }',
  ].join('\n')

  it('lifts a whole declaration out of a file it cannot import', () => {
    expect(extractFunction(source, 'normalizeEmail')).toBe(
      'function normalizeEmail(email: string): string {\n  return email.trim().toLowerCase()\n}',
    )
  })

  it('is not fooled by a brace inside a string in the body', () => {
    expect(extractFunction(source, 'other')).toBe('function other() { return "}" }')
  })

  it('returns null for an absent or unbalanced function', () => {
    expect(extractFunction(source, 'missing')).toBeNull()
    expect(extractFunction('function broken() { if (x) {', 'broken')).toBeNull()
  })
})

describe('useSeoArgument', () => {
  it('reads the object literal passed to the call', () => {
    const source = `useSeo({ title: 'Pricing', description: 'Plans.' })`
    expect(useSeoArgument(source)).toEqual({
      kind: 'object',
      text: `{ title: 'Pricing', description: 'Plans.' }`,
    })
  })

  it('does not reach past the call for its argument', () => {
    // The bug this replaces: extraction started at the next `{` ANYWHERE after
    // the call, so a page calling `useSeo(pageSeo)` adopted whatever object
    // came next — here a toast — and shipped with no meta description while the
    // gate reported it fine.
    const source = [
      `useSeo(pageSeo)`,
      `function save() {`,
      `  toast.add({ title: 'Saved', description: 'Done.' })`,
      `}`,
    ].join('\n')

    const argument = useSeoArgument(source)
    expect(argument.kind).toBe('unreadable')
    expect(argument.kind === 'unreadable' && argument.detail).toContain('pageSeo')
  })

  it('follows exactly one hop through a local const', () => {
    const source = [
      `const pageSeo = { title: 'Home', description: 'A sentence.' }`,
      `useSeo(pageSeo)`,
    ].join('\n')
    expect(useSeoArgument(source)).toEqual({
      kind: 'object',
      text: `{ title: 'Home', description: 'A sentence.' }`,
    })
  })

  it('accepts whitespace before the parenthesis', () => {
    // Rule 1 counts calls with `\buseSeo\s*\(`; if extraction used the literal
    // string 'useSeo(' the two rules would disagree about the same page.
    expect(useSeoArgument(`useSeo (\n  { title: 'Home' },\n)`).kind).toBe('object')
  })

  it('reports a missing call separately from an unreadable one', () => {
    expect(useSeoArgument('const x = 1').kind).toBe('missing')
    expect(useSeoArgument(`useSeo(buildSeo(page))`).kind).toBe('unreadable')
    expect(useSeoArgument(`useSeo({ title: 'x'`).kind).toBe('unreadable')
  })
})

describe('topLevelFields', () => {
  it('reads only depth 1, so a nested key cannot answer for the page', () => {
    const argument = `{ title: t, schema: [build(site, { description: 'nested' })] }`
    expect(topLevelFields(argument).map((field) => field.key)).toEqual(['title', 'schema'])
  })

  it('keeps the raw value text, quoting and interpolation intact', () => {
    const fields = topLevelFields("{ a: 'x', b: `y ${z}`, c }")
    expect(fields).toEqual([
      { key: 'a', value: `'x'` },
      { key: 'b', value: '`y ${z}`' },
      { key: 'c', value: null },
    ])
  })

  it('is not split by a comma inside a string or a nested call', () => {
    const fields = topLevelFields(`{ a: 'x, y', b: f(1, 2) }`)
    expect(fields.map((field) => field.key)).toEqual(['a', 'b'])
  })
})

describe('seoDescription', () => {
  const read = (source: string) => {
    const argument = useSeoArgument(source)
    return argument.kind === 'object'
      ? seoDescription(argument.text, source)
      : { present: false, literal: null }
  }

  it('measures a literal written inline', () => {
    expect(read(`useSeo({ description: 'the real one' })`).literal?.text).toBe('the real one')
  })

  it('never measures a description from outside the call', () => {
    const source = [
      `toast.add({ description: 'short' })`,
      `useSeo({ description: 'the real one' })`,
    ].join('\n')
    expect(read(source).literal?.text).toBe('the real one')
  })

  it('never measures a description nested inside the call', () => {
    // /pricing passed only because `description` happens to be written above
    // `schema`. Order is not a rule; depth is.
    const source = `useSeo({ description: 'the real one', schema: [f({ description: 'nested' })] })`
    expect(read(source).literal?.text).toBe('the real one')

    const onlyNested = `useSeo({ title: 'x', schema: [f({ description: 'nested' })] })`
    expect(read(onlyNested)).toEqual({ present: false, literal: null })
  })

  it('follows a shorthand or an identifier one hop to a local const', () => {
    const shorthand = [
      `const description = 'A real sentence about this page.'`,
      `useSeo({ title: 'Home', description })`,
    ].join('\n')
    expect(read(shorthand).literal?.text).toBe('A real sentence about this page.')

    const named = [`const blurb = 'Another real sentence.'`, `useSeo({ description: blurb })`].join(
      '\n',
    )
    expect(read(named).literal?.text).toBe('Another real sentence.')
  })

  it('accepts a runtime value as present but declines to measure it', () => {
    // The landing page binds its description to runtime config, and a post
    // binds it to the record being rendered. Both genuinely have a description;
    // neither has one this gate can read, and demanding a literal would only
    // produce a decorative string that never renders.
    const fromConfig = [
      `const description = config.public.appDescription`,
      `useSeo({ title: 'Home', description })`,
    ].join('\n')
    expect(read(fromConfig)).toEqual({ present: true, literal: null })

    const fromRecord = `useSeo({ title: post.title, description: post.description })`
    expect(read(fromRecord)).toEqual({ present: true, literal: null })
  })

  it('preserves a template literal so the length rule can see the interpolation', () => {
    // A `${…}` expands at runtime, so the gate must not measure the literal
    // part and call it too short.
    const literal = read(
      'useSeo({ description: `Everything in ${appName}, newest first.` })',
    ).literal
    expect(literal?.quote).toBe('`')
    expect(literal?.text).toContain('${appName}')
  })

  it('reports a call with no description at all', () => {
    expect(read(`useSeo({ title: 'Customer' })`)).toEqual({ present: false, literal: null })
  })
})
