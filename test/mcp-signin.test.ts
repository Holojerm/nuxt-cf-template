// The MCP worker's sign-in, across the seam between the two builds: the app
// mints a code (server/utils/mcp-connect.ts) and the worker spends it
// (mcp/src/signin.ts), through a real D1 inside workerd. The two sides hash the
// code separately because the worker cannot import the app's TypeScript; this
// file is what holds them to one answer.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  SIGNIN_COOKIE,
  beginSignin,
  hashConnectCode as workerHash,
  peekConnectCode,
  readSignin,
  redeemConnectCode,
} from '../mcp/src/signin'
import * as schema from '../server/db/schema'
import {
  ConnectRequestSchema,
  connectCallbackUrl,
  hashConnectCode as appHash,
  mintConnectCode,
} from '../server/utils/mcp-connect'

const db = drizzle(env.DB, { schema })
const USER = 'user-1'
const QUERY =
  'response_type=code&client_id=abc&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&state=x%2By'
const now = () => Math.floor(Date.now() / 1000)

/** The browser's side of a sign-in: the request the worker started, as it comes back. */
async function startedSignin() {
  const { requestId, cookie } = await beginSignin(QUERY)
  const request = new Request('https://mcp.test/authorize/callback', {
    headers: { cookie: cookie.split(';')[0]! },
  })
  return { requestId, request }
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM mcp_connect_codes')
  await env.DB.exec('DELETE FROM users')
  await db
    .insert(schema.users)
    .values({ id: USER, email: 'ada@example.com', name: 'Ada', referralCode: 'ADA22222' })
})

describe('the pending sign-in cookie', () => {
  it('round-trips the request id and the original query', async () => {
    const { requestId, request } = await startedSignin()
    expect(ConnectRequestSchema.safeParse({ request: requestId }).success).toBe(true)
    expect(await readSignin(request)).toEqual({ requestId, query: QUERY })
  })

  it('keeps the secret out of the request id', async () => {
    const { requestId, cookie } = await beginSignin(QUERY)
    const secret = cookie.slice(SIGNIN_COOKIE.length + 1).split('.')[0]!
    expect(requestId).not.toContain(secret)
  })

  it('reads nothing from a browser that started no sign-in', async () => {
    expect(await readSignin(new Request('https://mcp.test/authorize/callback'))).toBeNull()
    const garbled = new Request('https://mcp.test/', { headers: { cookie: `${SIGNIN_COOKIE}=x` } })
    expect(await readSignin(garbled)).toBeNull()
  })
})

describe('a code minted by the app', () => {
  it('hashes to the same value on both sides', async () => {
    expect(await appHash('abcd-2345', 'r1')).toBe(await workerHash('ABCD2345', 'r1'))
    expect(await appHash('ABCD2345', 'r1')).not.toBe(await workerHash('ABCD2345', 'r2'))
  })

  it('names its owner, is spent once, and is then dead', async () => {
    const { requestId } = await startedSignin()
    const code = await mintConnectCode(db, { userId: USER, requestId })

    expect(await peekConnectCode(env.DB, code, requestId, now())).toEqual({
      email: 'ada@example.com',
    })
    expect(await redeemConnectCode(env.DB, code, requestId, now())).toEqual({ userId: USER })
    expect(await redeemConnectCode(env.DB, code, requestId, now())).toBeNull()
    expect(await peekConnectCode(env.DB, code, requestId, now())).toBeNull()
  })

  it('cannot finish a sign-in it was not minted for', async () => {
    const mine = await startedSignin()
    const theirs = await startedSignin()
    const code = await mintConnectCode(db, { userId: USER, requestId: theirs.requestId })

    expect(await redeemConnectCode(env.DB, code, mine.requestId, now())).toBeNull()
  })

  it('expires', async () => {
    const { requestId } = await startedSignin()
    const code = await mintConnectCode(db, { userId: USER, requestId })
    await db
      .update(schema.mcpConnectCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.mcpConnectCodes.userId, USER))

    expect(await peekConnectCode(env.DB, code, requestId, now())).toBeNull()
    expect(await redeemConnectCode(env.DB, code, requestId, now())).toBeNull()
  })
})

describe('where the browser is sent back', () => {
  const input = { requestId: 'a'.repeat(64), code: 'ABCD' }

  it('is the configured worker, however the URL was written', () => {
    const expected = `https://mcp.example.com/authorize/callback?request=${input.requestId}&code=ABCD`
    expect(connectCallbackUrl('https://mcp.example.com', input)).toBe(expected)
    expect(connectCallbackUrl('https://mcp.example.com/mcp/', input)).toBe(expected)
  })

  it('is nowhere when no worker is configured', () => {
    expect(connectCallbackUrl('', input)).toBeNull()
  })
})
