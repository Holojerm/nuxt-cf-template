// OAuth 1.0a request signing (RFC 5849, HMAC-SHA1) on WebCrypto.
//
// X's v2 write endpoints still take OAuth 1.0a user context, and signing is
// small enough that a dependency for it would be the larger risk. Pure and
// deterministic given `nonce` and `timestamp`, so test/oauth1.test.ts pins it
// to the worked example in X's own documentation.

export interface OAuth1Credentials {
  consumerKey: string
  consumerSecret: string
  token: string
  tokenSecret: string
}

export interface OAuth1Request {
  method: string
  /** Without a query string; pass query parameters in `params`. */
  url: string
  /** Query and form parameters. A JSON body is NOT signed — RFC 5849 §3.4.1.3. */
  params?: Record<string, string>
  nonce: string
  timestamp: number
}

/** RFC 3986 unreserved-only encoding, which `encodeURIComponent` is not (it leaves !'()*). */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

export async function oauth1Signature(
  creds: OAuth1Credentials,
  request: OAuth1Request,
): Promise<string> {
  const params: Record<string, string> = {
    ...request.params,
    ...oauthParams(creds, request),
  }
  const normalized = Object.keys(params)
    .map((key) => [percentEncode(key), percentEncode(params[key] ?? '')] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  const base = [request.method.toUpperCase(), percentEncode(request.url), percentEncode(normalized)]
  const key = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.tokenSecret)}`

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(base.join('&')))
  return btoa(String.fromCharCode(...new Uint8Array(mac)))
}

export async function oauth1Header(
  creds: OAuth1Credentials,
  request: OAuth1Request,
): Promise<string> {
  const header = {
    ...oauthParams(creds, request),
    oauth_signature: await oauth1Signature(creds, request),
  }
  const fields = Object.entries(header)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
  return `OAuth ${fields.join(', ')}`
}

function oauthParams(creds: OAuth1Credentials, request: OAuth1Request): Record<string, string> {
  return {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: request.nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(request.timestamp),
    oauth_token: creds.token,
    oauth_version: '1.0',
  }
}
