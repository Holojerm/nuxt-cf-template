// The rules behind `bun run methods:check`: which routes may not read a body,
// and what counts as reading one. Pure strings, no filesystem.

import { describe, expect, it } from 'vitest'

import { blankNonCode, bodyReads, isBodyless, routeMethod } from '../scripts/lib/method-bodies'

describe('routeMethod', () => {
  it('reads the method from the filename suffix', () => {
    expect(routeMethod('server/api/files/[id].delete.ts')).toBe('delete')
    expect(routeMethod('server/api/account/delete.post.ts')).toBe('post')
    expect(routeMethod('layers/feedback/server/api/feedback.get.ts')).toBe('get')
    expect(routeMethod('server/api/health.head.mjs')).toBe('head')
  })

  it('treats a bare route or a non-route file as having no method', () => {
    expect(routeMethod('server/api/auth/google.ts')).toBeNull()
    expect(routeMethod('server/utils/delete.ts')).toBeNull()
    expect(routeMethod('server/api/notes.delete.test.ts')).toBeNull()
  })

  it('names delete, get and head as the bodyless methods', () => {
    expect(['get', 'head', 'delete'].every(isBodyless)).toBe(true)
    expect(['post', 'put', 'patch', null].some((m) => isBodyless(m))).toBe(false)
  })
})

describe('bodyReads', () => {
  it('finds every h3 way of reading a body', () => {
    const source = [
      'const a = await readBody(event)',
      'const b = await readValidatedBody(event, schema.parse)',
      'const c = await readRawBody(event)',
      'const d = await readMultipartFormData(event)',
      'const e = await event.web.request.json()',
      'const f = await toWebRequest(event).formData()',
    ].join('\n')
    expect(bodyReads(source).map((r) => r.call)).toEqual([
      'readBody',
      'readValidatedBody',
      'readRawBody',
      'readMultipartFormData',
      'json',
      'formData',
    ])
  })

  it('reports the line of each read', () => {
    expect(bodyReads('a()\n\nawait readBody(event)')).toEqual([{ line: 3, call: 'readBody' }])
  })

  it('ignores comments and strings that merely mention a read', () => {
    const source = [
      '// This route used to call readBody(event).',
      '/* readValidatedBody(event, x) is why it moved */',
      "const hint = 'call readBody() on a POST'",
      'const route = `// readBody(event)`',
      'const { id } = getRouterParams(event)',
    ].join('\n')
    expect(bodyReads(source)).toEqual([])
  })

  it('still sees code that follows a string holding a comment marker', () => {
    expect(bodyReads("const url = 'http://x'; await readBody(event)")).toHaveLength(1)
  })

  it('honours methods-check-ignore on the line or the line above', () => {
    expect(bodyReads('await readBody(event) // methods-check-ignore')).toEqual([])
    expect(bodyReads('// methods-check-ignore: proxied\nawait readBody(event)')).toEqual([])
    expect(bodyReads('// methods-check-ignore\n\nawait readBody(event)')).toHaveLength(1)
  })

  it('does not match a similarly named function', () => {
    expect(bodyReads('await myreadBody(event); await readBodyLater(event)')).toEqual([])
  })
})

describe('blankNonCode', () => {
  it('keeps length and line breaks so offsets still point at the source', () => {
    const source = "a // c\n'x\\'y' /* m\nn */ b"
    const blanked = blankNonCode(source)
    expect(blanked).toHaveLength(source.length)
    expect(blanked.split('\n')).toHaveLength(source.split('\n').length)
  })
})
