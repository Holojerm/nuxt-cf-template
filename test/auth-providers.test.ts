// Which sign-in buttons /login renders.
//
// Two things worth pinning, and neither is obvious from reading the route:
// the ORDER (a consumer product does not lead with a developer credential) and
// the Apple availability rule, which has one more condition than it looks like
// it should.

import { describe, expect, it } from 'vitest'

import { describeOAuthProviders } from '../server/utils/auth-providers'

const APPLE_COMPLETE = {
  clientId: 'com.example.app.web',
  teamId: 'TEAM123456',
  keyId: 'KEY1234567',
  privateKey: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
  redirectURL: 'https://app.example.com/api/auth/apple',
}

const available = (oauth: Parameters<typeof describeOAuthProviders>[0], id: string) =>
  describeOAuthProviders(oauth).find((provider) => provider.id === id)?.available

describe('describeOAuthProviders ordering', () => {
  it('puts the consumer providers first and GitHub last', () => {
    // GitHub is a developer credential. Leading a consumer sign-in page with it
    // tells most visitors the product isn't for them, and it is the clearest
    // tell that a fork was never re-aimed. Magic link is the primary control and
    // is deliberately absent from this list — it needs no credentials.
    expect(describeOAuthProviders({}).map((provider) => provider.id)).toEqual([
      'apple',
      'google',
      'github',
    ])
  })

  it('reports nothing available on a fresh fork', () => {
    expect(describeOAuthProviders({}).every((provider) => !provider.available)).toBe(true)
  })

  it('never leaks a credential into the response', () => {
    const serialized = JSON.stringify(
      describeOAuthProviders({
        apple: APPLE_COMPLETE,
        google: { clientId: 'g-id', clientSecret: 'g-secret' },
        github: { clientId: 'gh-id', clientSecret: 'gh-secret' },
      }),
    )
    for (const secret of [APPLE_COMPLETE.privateKey, 'g-secret', 'gh-secret', 'g-id', 'gh-id']) {
      expect(serialized).not.toContain(secret)
    }
  })
})

describe('Apple availability', () => {
  it('is available only when all five values are set', () => {
    expect(available({ apple: APPLE_COMPLETE }, 'apple')).toBe(true)
  })

  it('is NOT available without a redirect URL', () => {
    // The finding this test exists for. nuxt-auth-utils 0.5.30's Apple handler
    // sends the RAW `config.redirectURL` in the token exchange — unlike google
    // and github, which fall back to the request's own origin. Unset, it
    // serialises as `redirect_uri=undefined` and Apple answers `invalid_grant`
    // AFTER a successful consent screen, so every earlier step looks fine and
    // the failure is unattributable. Not rendering the button is the only way
    // this is ever noticed before a user hits it.
    expect(available({ apple: { ...APPLE_COMPLETE, redirectURL: '' } }, 'apple')).toBe(false)
    expect(available({ apple: { ...APPLE_COMPLETE, redirectURL: undefined } }, 'apple')).toBe(false)
  })

  it('is NOT available when any signing input is missing', () => {
    // Apple has no static client secret — the server signs an ES256 JWT per
    // request — so three of these four are inputs to that signature and each is
    // individually fatal.
    for (const key of ['clientId', 'teamId', 'keyId', 'privateKey'] as const) {
      expect(available({ apple: { ...APPLE_COMPLETE, [key]: '' } }, 'apple'), key).toBe(false)
    }
  })
})

describe('Google and GitHub availability', () => {
  it('needs both halves of the pair', () => {
    expect(available({ google: { clientId: 'id', clientSecret: 'secret' } }, 'google')).toBe(true)
    expect(available({ google: { clientId: 'id' } }, 'google')).toBe(false)
    expect(available({ github: { clientId: 'id', clientSecret: 'secret' } }, 'github')).toBe(true)
    expect(available({ github: { clientSecret: 'secret' } }, 'github')).toBe(false)
  })

  it('does not need a redirect URL — only Apple does', () => {
    // Worth stating: the asymmetry is a quirk of one library handler, not a
    // property of OAuth, and someone will otherwise "fix" the inconsistency.
    expect(available({ google: { clientId: 'id', clientSecret: 'secret' } }, 'google')).toBe(true)
  })
})
