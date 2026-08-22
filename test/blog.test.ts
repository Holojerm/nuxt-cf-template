// The blog's visibility rule.
//
// Everything else about the blog is either rendering (covered in seo.test.ts)
// or a content-collection query, which cannot be reached from here: the pool
// runs in workerd and @nuxt/content's Nitro entry resolves a `#content/*` build
// alias that only exists inside a Nuxt build. What CAN be tested is the rule
// that decides whether a post is allowed to be seen — and that rule is the one
// with a real cost attached if it is wrong in either direction.

import { describe, expect, it, vi } from 'vitest'

import { isPostVisible, loadBlogPosts } from '../shared/utils/blog'

describe('isPostVisible', () => {
  const published = { draft: false }
  const draft = { draft: true }

  it('serves a published post in both environments', () => {
    expect(isPostVisible(published, true)).toBe(true)
    expect(isPostVisible(published, false)).toBe(true)
  })

  it('treats an absent flag as published', () => {
    // `draft` has a schema default of false, so the column is never NULL — but
    // this function is also called with objects assembled in other ways, and
    // "no flag" must never mean "hidden". A post that silently fails to publish
    // is the worse of the two failures: nobody reports a page they never saw.
    expect(isPostVisible({}, false)).toBe(true)
  })

  it('hides a draft in production and shows it in dev', () => {
    // The dev exception is the point of the flag. A draft you cannot open is a
    // draft you cannot proofread, and the workflow that replaces it — flip the
    // flag, look, flip it back — is how an unfinished post gets published by
    // accident.
    expect(isPostVisible(draft, false)).toBe(false)
    expect(isPostVisible(draft, true)).toBe(true)
  })
})

describe('loadBlogPosts', () => {
  const POST = {
    path: '/blog/how-billing-works',
    title: 'How the billing model works',
    description: 'Two products, one entitlements table.',
    date: '2026-06-18',
    author: 'My Company Ltd',
  }

  it('reports a successful load as trustworthy', async () => {
    const report = vi.fn()
    await expect(loadBlogPosts(async () => [POST], report)).resolves.toEqual({
      posts: [POST],
      ok: true,
    })
    expect(report).not.toHaveBeenCalled()
  })

  it('turns a failure into an explicitly incomplete result rather than throwing', async () => {
    // sitemap.xml and llms.txt must keep serving when the collection cannot be
    // read — a document missing its posts beats a 500 and a crawl error.
    const report = vi.fn()
    const result = await loadBlogPosts(async () => {
      throw new Error('D1_ERROR: no such table: _content_blog')
    }, report)

    expect(result).toEqual({ posts: [], ok: false })
    expect(report).toHaveBeenCalledWith(expect.stringContaining('_content_blog'))
  })

  it('runs the loader exactly once, so a failure is not silently retried', async () => {
    // The loader the server passes is Nitro's cached wrapper. This composition
    // is what keeps a failure out of the cache: the cache is inside the loader,
    // the catch is outside it, and Nitro only writes an entry after the
    // resolver has resolved — so `ok: false` is never persisted and the next
    // request queries again instead of being served a cached emptiness.
    const load = vi.fn(async () => {
      throw new Error('transient')
    })
    await loadBlogPosts(load, () => {})
    expect(load).toHaveBeenCalledTimes(1)
  })
})
