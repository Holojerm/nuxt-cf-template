// Read and answer the people who addressed the product's X account: the only
// thing the `x-replies` routine may do there (.claude/routines/x-replies.md).
//
//   bun run scripts/x-replies.ts list [--state <path>] [--max <n>] [--since <id>] [--dry-run]
//   bun run scripts/x-replies.ts reply --to <id> --file reply.txt [--state <path>] [--dry-run]
//
// `list` prints JSON and saves what it found, plus a cursor, to the state file.
// `reply` only answers an id that the last `list` marked replyable. Credentials:
// X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET, as for x-post.ts.
// `--dry-run` never calls a write endpoint and never advances the cursor.
// Deliberately no like, follow, repost, quote or DM verbs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { emptyState, listItems, sendReply, type Deps, type State } from './lib/x-replies'

function fail(message: string): never {
  console.error(`x-replies: ${message}`)
  process.exit(1)
}

function deps(): Deps {
  const names = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'] as const
  const missing = names.filter((name) => !process.env[name])
  if (missing.length) fail(`missing ${missing.join(', ')}`)
  return {
    fetch,
    creds: {
      consumerKey: process.env.X_API_KEY!,
      consumerSecret: process.env.X_API_SECRET!,
      token: process.env.X_ACCESS_TOKEN!,
      tokenSecret: process.env.X_ACCESS_SECRET!,
    },
    nonce: () => crypto.randomUUID().replace(/-/g, ''),
    now: () => Math.floor(Date.now() / 1000),
  }
}

const [verb, ...args] = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const dryRun = args.includes('--dry-run')
const statePath = flag('--state') ?? '.data/x-replies-state.json'

const state: State = existsSync(statePath)
  ? { ...emptyState(), ...JSON.parse(readFileSync(statePath, 'utf8')) }
  : emptyState()
const save = (next: State) => {
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`)
}

try {
  if (verb === 'list') {
    const max = flag('--max') ? Number(flag('--max')) : undefined
    if (max !== undefined && !(max >= 1 && max <= 10)) fail('--max takes 1 to 10')
    const since = flag('--since')
    if (since && !/^\d+$/.test(since)) fail('--since takes a numeric post id')
    const result = await listItems(deps(), state, { cap: max, since })
    // A dry run keeps the cursor where it was, so the next real run sees the same items.
    save(dryRun ? { ...result.state, cursor: state.cursor } : result.state)
    console.info(JSON.stringify(result.output, null, 2))
  } else if (verb === 'reply') {
    const to = flag('--to')
    const file = flag('--file')
    if (!to || !/^\d+$/.test(to) || !file) fail('usage: reply --to <id> --file <path> [--dry-run]')
    const result = await sendReply(deps(), state, {
      to,
      text: readFileSync(file, 'utf8'),
      allowLink: args.includes('--allow-link'),
      dryRun,
    })
    if (!dryRun) save(result.state)
    console.info(result.url ?? result.preview)
  } else {
    fail('usage: list | reply --to <id> --file <path>  (both take --dry-run, --state <path>)')
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
