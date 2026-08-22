// The blog's visibility rule.
//
// Everything else about the blog is either rendering (covered in seo.test.ts)
// or a content-collection query, which cannot be reached from here: the pool
// runs in workerd and @nuxt/content's Nitro entry resolves a `#content/*` build
// alias that only exists inside a Nuxt build. What CAN be tested is the rule
// that decides whether a post is allowed to be seen — and that rule is the one
// with a real cost attached if it is wrong in either direction.

import { describe, expect, it } from 'vitest'

import { isPostVisible } from '../shared/utils/blog'

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
