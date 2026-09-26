// Post to (or delete from) the product's X account — the only thing the
// `x-post` routine is allowed to do there (.claude/routines/x-post.md).
//
//   bun run scripts/x-post.ts --file post.txt       # prints the post URL
//   bun run scripts/x-post.ts --file post.txt --dry-run
//   bun run scripts/x-post.ts --delete <id>
//
// Credentials come from X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN /
// X_ACCESS_SECRET (an app with read+write, and the account's own access
// token). Deliberately no reply, like, follow or DM verbs: a routine cannot
// misuse a capability this script does not have.

import { readFileSync } from 'node:fs'

import { oauth1Header, type OAuth1Credentials } from './lib/oauth1'

const API = 'https://api.x.com/2/tweets'
/** X weighs URLs and some scripts differently; raw length is the conservative bound. */
const MAX_LENGTH = 280

function credentials(): OAuth1Credentials {
  const names = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'] as const
  const missing = names.filter((name) => !process.env[name])
  if (missing.length) fail(`missing ${missing.join(', ')}`)
  return {
    consumerKey: process.env.X_API_KEY!,
    consumerSecret: process.env.X_API_SECRET!,
    token: process.env.X_ACCESS_TOKEN!,
    tokenSecret: process.env.X_ACCESS_SECRET!,
  }
}

function fail(message: string): never {
  console.error(`x-post: ${message}`)
  process.exit(1)
}

async function call(method: 'POST' | 'DELETE', url: string, body?: unknown): Promise<unknown> {
  const authorization = await oauth1Header(credentials(), {
    method,
    url,
    nonce: crypto.randomUUID().replace(/-/g, ''),
    timestamp: Math.floor(Date.now() / 1000),
  })
  const res = await fetch(url, {
    method,
    headers: { authorization, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as unknown
  if (!res.ok) fail(`${method} ${url} → ${res.status} ${JSON.stringify(json)}`)
  return json
}

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

const deleteId = flag('--delete')
if (deleteId) {
  if (!/^\d+$/.test(deleteId)) fail('--delete takes a numeric post id')
  await call('DELETE', `${API}/${deleteId}`)
  console.info(`deleted ${deleteId}`)
  process.exit(0)
}

const file = flag('--file')
if (!file) fail('usage: --file <path> [--dry-run] | --delete <id>')
const text = readFileSync(file, 'utf8').trim()
if (!text) fail('the post is empty')
if (text.length > MAX_LENGTH)
  fail(`the post is ${text.length} characters; the limit is ${MAX_LENGTH}`)

if (args.includes('--dry-run')) {
  console.info(`dry run — would post ${text.length} characters:\n${text}`)
  process.exit(0)
}

const result = (await call('POST', API, { text })) as { data?: { id?: string } }
const id = result.data?.id
if (!id) fail(`posted, but the response had no id: ${JSON.stringify(result)}`)
console.info(`https://x.com/i/web/status/${id}`)
