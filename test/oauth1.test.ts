// OAuth 1.0a signing, pinned to the worked example in X's documentation
// ("Creating a signature"), so a refactor that changes a single byte of the
// base string fails here rather than as a 401 in an unattended routine.

import { describe, expect, it } from 'vitest'

import { oauth1Signature, percentEncode } from '../scripts/lib/oauth1'

describe('oauth1Signature', () => {
  it('reproduces the documented signature', async () => {
    const signature = await oauth1Signature(
      {
        consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
        consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
        token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
        tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
      },
      {
        method: 'POST',
        url: 'https://api.twitter.com/1.1/statuses/update.json',
        params: {
          include_entities: 'true',
          status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
        },
        nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
        timestamp: 1318622958,
      },
    )
    expect(signature).toBe('hCtSmYh+iHYCEqBWrE7C7hYmtUk=')
  })
})

describe('percentEncode', () => {
  it('encodes the characters encodeURIComponent leaves alone', () => {
    expect(percentEncode("a!b'c(d)e*f")).toBe('a%21b%27c%28d%29e%2Af')
    expect(percentEncode('Ladies + Gentlemen')).toBe('Ladies%20%2B%20Gentlemen')
  })
})
