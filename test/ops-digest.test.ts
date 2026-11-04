import { describe, expect, it } from 'vitest'

import {
  OPS_DIGEST_ROWS_PER_KIND,
  formatOpsTime,
  groupOpsRows,
  opsDigestSubject,
  opsKindLabel,
  opsLogsUrl,
  renderOpsDigest,
  type OpsDigestRow,
} from '../server/utils/ops-digest'

const T = new Date('2026-10-04T20:01:30Z')

function row(kind: string, over: Partial<OpsDigestRow> = {}): OpsDigestRow {
  return { kind, detail: null, path: null, createdAt: T, ...over }
}

describe('opsKindLabel', () => {
  it('turns snake and kebab ids into a sentence', () => {
    expect(opsKindLabel('paddle_webhook_rejected')).toBe('Paddle webhook rejected')
    expect(opsKindLabel('db-down')).toBe('Db down')
    expect(opsKindLabel('__x__')).toBe('X')
    expect(opsKindLabel('')).toBe('')
  })
})

describe('formatOpsTime', () => {
  it('is absolute and UTC', () => {
    expect(formatOpsTime(T)).toBe('Oct 4, 20:01 UTC')
    expect(formatOpsTime(new Date('2026-01-01T00:05:00Z'))).toBe('Jan 1, 00:05 UTC')
  })
})

describe('opsLogsUrl', () => {
  it('points at the worker observability page', () => {
    expect(opsLogsUrl('my-worker')).toContain('/workers/services/view/my-worker/production')
  })
})

describe('groupOpsRows / opsDigestSubject', () => {
  const rows = [row('a'), row('b'), row('b'), row('b'), row('c'), row('c')]

  it('groups by kind, loudest first', () => {
    const grouped = groupOpsRows(rows)
    expect(grouped.map(([k, r]) => [k, r.length])).toEqual([
      ['b', 3],
      ['c', 2],
      ['a', 1],
    ])
  })

  it('returns nothing for no rows', () => {
    expect(groupOpsRows([])).toEqual([])
  })

  it('names the loudest kind and counts the rest', () => {
    expect(opsDigestSubject('Acme', groupOpsRows(rows))).toBe('Acme alert · B ×3 + 3 more')
    expect(opsDigestSubject('Acme', groupOpsRows([row('x_failed')]))).toBe(
      'Acme alert · X failed ×1',
    )
  })
})

describe('renderOpsDigest', () => {
  const opts = { appName: 'Acme', now: T, appUrl: 'https://acme.test', workerName: 'acme' }

  it('HTML-escapes details and paths', () => {
    const kinds = groupOpsRows([
      row('request_failed', {
        detail: '<script>alert("x")</script>',
        path: '/<img src=x onerror=1>',
      }),
    ])
    const { html, text } = renderOpsDigest(kinds, 1, T, opts)
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;script&gt;')
    // Plain text has no markup to break out of, so it is verbatim.
    expect(text).toContain('<script>alert("x")</script>')
  })

  it('summarises and singularises the count', () => {
    const one = renderOpsDigest(groupOpsRows([row('k')]), 1, T, opts)
    expect(one.text).toContain('1 new event since Oct 4, 20:01 UTC')
    const many = renderOpsDigest(groupOpsRows([row('k'), row('k')]), 2, T, opts)
    expect(many.text).toContain('2 new events since')
  })

  it('caps rows per kind and reports the overflow', () => {
    const rows = Array.from({ length: OPS_DIGEST_ROWS_PER_KIND + 3 }, (_, i) =>
      row('boom_failed', { detail: `detail-${i}` }),
    )
    const { text } = renderOpsDigest(groupOpsRows(rows), rows.length, T, opts)
    expect(text).toContain(`detail-${OPS_DIGEST_ROWS_PER_KIND - 1}`)
    expect(text).not.toContain(`detail-${OPS_DIGEST_ROWS_PER_KIND}`)
    expect(text).toMatch(/3 more/)
  })

  it('links only app-relative paths, and only when the origin is known', () => {
    const kinds = groupOpsRows([
      row('k_failed', { path: '/api/thing' }),
      row('k_failed', { path: 'https://evil.test/x' }),
    ])
    const withUrl = renderOpsDigest(kinds, 2, T, opts)
    expect(withUrl.html).toContain('href="https://acme.test/api/thing"')
    expect(withUrl.html).not.toContain('href="https://acme.testhttps')
    const noUrl = renderOpsDigest(kinds, 2, T, { ...opts, appUrl: undefined })
    expect(noUrl.html).not.toContain('/api/thing"')
  })
})
