// A rendered page's policy and scripts: a nonce in place of 'unsafe-inline', on the
// framework's scripts only. The browser half is in test/csp/csp.spec.ts.

import { describe, expect, it } from 'vitest'

import { newNonce, nonceFrameworkScripts, noncedPolicy } from '../shared/script-nonce'
import { contentSecurityPolicy } from '../shared/security-headers'

const directive = (policy: string, name: string) =>
  new RegExp(`(?:^|; )${name} ([^;]+)`).exec(policy)?.[1] ?? ''

describe("a page's policy", () => {
  const nonce = newNonce()
  const base = contentSecurityPolicy(false)
  const policy = noncedPolicy(base, nonce)

  it("allows inline script by nonce only, never by 'unsafe-inline'", () => {
    const sources = directive(policy, 'script-src').split(' ')
    expect(sources).not.toContain("'unsafe-inline'")
    expect(sources).toEqual([
      ...directive(base, 'script-src')
        .split(' ')
        .filter((source) => source !== "'unsafe-inline'"),
      `'nonce-${nonce}'`,
    ])
  })

  it('changes nothing else in the policy', () => {
    const others = (text: string) => text.split('; ').filter((d) => !d.startsWith('script-src '))
    expect(others(policy)).toEqual(others(base))
    expect(directive(policy, 'style-src')).toBe("'self' 'unsafe-inline'")
  })

  it('is new for every page', () => {
    expect(newNonce()).not.toBe(newNonce())
    expect(newNonce()).toMatch(/^[\w-]{22}$/)
  })
})

describe("a page's scripts", () => {
  it("stamps the framework's scripts and leaves the page's own markup alone", () => {
    const chunks = {
      head: [
        '<script type="importmap">{}</script><script type="module" src="/_nuxt/a.js"></script>',
        '<script>"use strict";(()=>{})()</script><scripted-thing></scripted-thing>',
      ],
      body: ['<div><script>window.injected=1</script></div>'],
      bodyAppend: ['<script>window.__NUXT__={}</script><script nonce="kept">1</script>'],
    }
    nonceFrameworkScripts(chunks, 'n0nce')
    expect(chunks.head.join('')).toBe(
      '<script nonce="n0nce" type="importmap">{}</script>' +
        '<script nonce="n0nce" type="module" src="/_nuxt/a.js"></script>' +
        '<script nonce="n0nce">"use strict";(()=>{})()</script><scripted-thing></scripted-thing>',
    )
    expect(chunks.bodyAppend.join('')).toBe(
      '<script nonce="n0nce">window.__NUXT__={}</script><script nonce="kept">1</script>',
    )
    expect(chunks.body).toEqual(['<div><script>window.injected=1</script></div>'])
  })
})
