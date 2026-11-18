import { describe, expect, it } from 'vitest'

import { buildOfflinePage } from '../server/utils/offline-page'

const page = (overrides: Partial<Parameters<typeof buildOfflinePage>[0]> = {}) =>
  buildOfflinePage({
    appName: 'My App',
    title: 'You are offline',
    body: 'Check your connection.',
    retry: 'Try again',
    colors: { ground: '#fafaf9', ink: '#1c1917', muted: '#79716b', mark: '#c74f2f' },
    ...overrides,
  })

describe('buildOfflinePage', () => {
  it('loads nothing: the worker has only this one document cached', () => {
    const html = page()
    expect(html).not.toMatch(/<script|<link|<img|url\(|@import|src=/)
  })

  it('retries the address the person asked for', () => {
    expect(page()).toContain('<a href="">Try again</a>')
  })

  it('escapes what an app configured', () => {
    const html = page({ appName: 'Salt & <Pepper>', title: `"Offline"` })
    expect(html).toContain('<title>&quot;Offline&quot; · Salt &amp; &lt;Pepper&gt;</title>')
    expect(html).not.toContain('<Pepper>')
  })

  it('takes its colours from the brand', () => {
    const html = page({
      colors: { ground: '#000001', ink: '#fffffe', muted: '#aaaaab', mark: '#123456' },
    })
    for (const colour of ['#000001', '#fffffe', '#aaaaab', '#123456'])
      expect(html).toContain(colour)
  })
})
