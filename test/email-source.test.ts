// The email build's pure parts. The failure worth pinning is silent: an HTML
// and a .txt that read different fields, where one of them is quietly stale.

import { describe, expect, it } from 'vitest'

import {
  emailModuleSource,
  htmlOnlyVariables,
  variableDrift,
  variablesOf,
} from '../scripts/email-source'

describe('variablesOf', () => {
  it('reads double, triple, section and inverted tags — and nothing from comments', () => {
    const tags = variablesOf('{{a}} {{{b}}} {{#c}}x{{/c}} {{^d}}y{{/d}} {{ e.f }} {{! g }}')
    expect([...tags].sort()).toEqual(['a', 'b', 'c', 'd', 'e.f'])
  })
})

describe('variableDrift', () => {
  it('is quiet when both halves read the same fields', () => {
    expect(variableDrift('<p>{{name}}</p>', 'Hi {{name}}')).toEqual({ onlyHtml: [], onlyText: [] })
  })

  it('names the field one half forgot', () => {
    expect(variableDrift('{{name}} {{date}}', '{{name}}').onlyHtml).toEqual(['date'])
    expect(variableDrift('{{name}}', '{{name}} {{date}}').onlyText).toEqual(['date'])
  })

  it('lets the layout supply appName and appUrl without the text repeating them', () => {
    expect(variableDrift('{{appName}} {{appUrl}} {{name}}', '{{name}}')).toEqual({
      onlyHtml: [],
      onlyText: [],
    })
  })

  it('honours an explicit html-only declaration, and only for the HTML', () => {
    const text = '{{! html-only: bad, pathUrl }}\n{{name}}'
    expect(htmlOnlyVariables(text)).toEqual(new Set(['bad', 'pathUrl']))
    expect(variableDrift('{{#bad}}{{pathUrl}}{{/bad}}{{name}}', text).onlyHtml).toEqual([])
    expect(variableDrift('{{name}}', '{{! html-only: bad }}\n{{name}} {{bad}}').onlyText).toEqual([
      'bad',
    ])
  })
})

describe('emailModuleSource', () => {
  const emails = {
    b: { html: '<p>"quoted" {{x}}</p>', text: 'line\nbreak' },
    a: { html: '<p>a</p>', text: 'a' },
  }

  it('marks itself generated and sorts entries, so a rebuild is byte-stable', () => {
    const source = emailModuleSource(emails)
    expect(source.startsWith('// GENERATED — edit emails/*.vue, then bun run email:build')).toBe(
      true,
    )
    expect(source.indexOf('"a":')).toBeLessThan(source.indexOf('"b":'))
    expect(emailModuleSource({ a: emails.a, b: emails.b })).toBe(source)
  })

  it('types the names, and keeps strings JSON-escaped', () => {
    const source = emailModuleSource(emails)
    expect(source).toContain('export type EmailName = "a" | "b"')
    expect(source).toContain('"<p>\\"quoted\\" {{x}}</p>"')
    expect(source).toContain('"line\\nbreak"')
  })
})
