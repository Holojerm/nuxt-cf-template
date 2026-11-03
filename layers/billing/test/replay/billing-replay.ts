// Webhook-replay parity check for billing.
//
// Boots the BUILT Worker (`wrangler dev -c .output/server/wrangler.json`) on a
// throwaway local D1, posts a fixed set of signed Paddle webhooks in order, and
// writes one normalised JSON document: every HTTP status, the entitlement /
// paddle-event / ops-event / audit rows, and the answers other surfaces gave
// afterwards (entitlement endpoint, export, admin views, fleet counters, the
// deletion guard, the paywall gate). Run it on two builds and diff the files:
// identical means the change did not alter what billing does.
//
//   bun run build
//   bun run billing:replay --out replay.json
//   diff replay.base.json replay.json
//
// To compare a change, build and replay the base commit in another worktree
// (copy this directory in if the base predates it), then diff the two dumps.
// The dump is key-order-insensitive and scrubs wall-clock values, so identical
// means identical behaviour. A vendoring fork runs it the same way against its
// own build; its wrangler.toml price/secret names are overridden by the throwaway
// .dev.vars the script writes.
//
// Needs: a build in `.output/`, `bunx wrangler`, free port. No Cloudflare
// account, no network, no real Paddle: the secret below is a throwaway and the
// D1 lives in a temp directory. Never point this at a deployed Worker.
//
// Options:  --root <dir>   repo to test (default: cwd)
//           --out <file>   write the dump there (default: stdout)
//           --port <n>     dev port (default 8799)
//           --extra-var K=V   extra Worker var, repeatable
//           --cancel-on-deletion  run as an app with billing.cancelOnDeletion on, against
//                             a stub Paddle API started here (NUXT_PADDLE_API_BASE): deletion
//                             cancels live subscriptions first. The dump gains `paddleApi`,
//                             the calls the stub saw. Without the flag the output is exactly
//                             that of a build without the option.
//           --no-referral  leave the referral loop out (a fork whose `users` table has no
//                             referral columns, or that never took the referral code)
//           --shared-account  run as an app that shares its Paddle account: sets
//                             NUXT_PADDLE_PRODUCT_ID and turns the unmatched-refund
//                             alert off (NUXT_BILLING_ALERT_UNMATCHED_ADJUSTMENTS=false)

import { Database } from 'bun:sqlite'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaults, seal } from 'iron-webcrypto'

import {
  CANCEL_USERS,
  MAGIC_LINK_SIGNUPS,
  PRICE_MONTHLY,
  PRICE_PASS,
  PRODUCT_OWN,
  REFERRAL_CODE,
  REFERRAL_USERS,
  REPLAY_SECRET,
  STUB_ANSWERS,
  USERS,
  buildSteps,
  type RequestStep,
  type UserKey,
  type Step,
  type WebhookStep,
} from './fixtures'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const flagAll = (name: string) =>
  args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []))

const cancelOnDeletion = args.includes('--cancel-on-deletion')
const referral = !args.includes('--no-referral')
const root = resolve(flag('--root') ?? process.cwd())
const out = flag('--out')
const port = Number(flag('--port') ?? 8799)
const base = `http://127.0.0.1:${port}`
const stateDir = process.env.REPLAY_STATE_DIR ?? mkdtempSync(join(tmpdir(), 'billing-replay-'))

const SESSION_PASSWORD = 'replay-session-password-0123456789abcdef'
const FLEET_TOKEN = 'replay-fleet-token-0123456789abcdef0123456789'
const WORKER_CONFIG = join(root, '.output/server/wrangler.json')

function sh(cmd: string[], cwd = root): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { cwd, env: process.env })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    child.on('close', (code) =>
      code === 0
        ? resolveRun(output)
        : reject(new Error(`${cmd.join(' ')} exited ${code}\n${output}`)),
    )
  })
}

// ── 1. Database: real migrations, then the four users ────────────────────────
rmSync(stateDir, { recursive: true, force: true })
mkdirSync(stateDir, { recursive: true })
await sh([
  'bunx',
  'wrangler',
  'd1',
  'migrations',
  'apply',
  'DB',
  '--local',
  '--persist-to',
  stateDir,
])

function findDb(): string {
  const dir = join(stateDir, 'v3/d1/miniflare-D1DatabaseObject')
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.sqlite')) continue
    const db = new Database(join(dir, f), { readonly: true })
    const has = db.query("select 1 from sqlite_master where name = 'users'").get()
    db.close()
    if (has) return join(dir, f)
  }
  throw new Error('no migrated D1 file found')
}

const dbFile = findDb()
{
  const db = new Database(dbFile)
  const now = Math.floor(Date.now() / 1000)
  for (const u of [
    ...Object.values(USERS),
    ...(cancelOnDeletion ? Object.values(CANCEL_USERS) : []),
  ]) {
    db.query(
      'insert into users (id, email, name, role, created_at, updated_at) values (?, ?, ?, ?, ?, ?)',
    ).run(u.id, u.email, u.name, u.role, now, now)
  }
  if (referral) {
    for (const u of Object.values(REFERRAL_USERS)) {
      db.query(
        'insert into users (id, email, name, role, referral_code, referred_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(u.id, u.email, u.name, u.role, u.referralCode, u.referredBy, now, now)
    }
    // The sign-in links the invited people will redeem. Only the hash is ever
    // stored by the app; the replay holds the plaintext, as the email would.
    for (const link of Object.values(MAGIC_LINK_SIGNUPS)) {
      const hash = new Bun.CryptoHasher('sha256').update(link.token).digest('hex')
      db.query(
        'insert into magic_link_tokens (id, email, mailbox, token_hash, expires_at, referral_code, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        crypto.randomUUID(),
        link.email,
        link.email,
        hash,
        now + 3600,
        link.referralCode,
        now,
        now,
      )
    }
  }
  db.close()
}

// ── 2. Worker: throwaway secrets, the built bundle ───────────────────────────
// A stand-in for api.paddle.com, only for --cancel-on-deletion: the Worker is
// pointed at it through NUXT_PADDLE_API_BASE. It records what it was asked and
// answers per subscription id (STUB_ANSWERS), 200 otherwise.
const STUB_API_KEY = 'pdl_replay_stub_key'
const stubCalls: unknown[] = []
const stub = cancelOnDeletion
  ? Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const id = /^\/subscriptions\/([^/]+)\/cancel$/.exec(new URL(req.url).pathname)?.[1]
        stubCalls.push({
          method: req.method,
          path: new URL(req.url).pathname,
          authorized: req.headers.get('authorization') === `Bearer ${STUB_API_KEY}`,
          body: await req.json().catch(() => null),
        })
        const answer = (id && STUB_ANSWERS[id]) || { status: 200 }
        return Response.json(
          answer.code ? { error: { code: answer.code, detail: 'replay stub' } } : { data: {} },
          { status: answer.status },
        )
      },
    })
  : null

const extraVars = [
  ...(stub
    ? [
        'NUXT_BILLING_CANCEL_ON_DELETION=true',
        `NUXT_PADDLE_API_KEY=${STUB_API_KEY}`,
        `NUXT_PADDLE_API_BASE=http://127.0.0.1:${stub.port}`,
      ]
    : []),
  ...flagAll('--extra-var'),
  ...(args.includes('--shared-account')
    ? [`NUXT_PADDLE_PRODUCT_ID=${PRODUCT_OWN}`, 'NUXT_BILLING_ALERT_UNMATCHED_ADJUSTMENTS=false']
    : []),
]
writeFileSync(
  join(root, '.output/server/.dev.vars'),
  [
    `NUXT_PADDLE_WEBHOOK_SECRET=${REPLAY_SECRET}`,
    `NUXT_PUBLIC_PADDLE_PRICE_PASS=${PRICE_PASS}`,
    `NUXT_PUBLIC_PADDLE_PRICE_MONTHLY=${PRICE_MONTHLY}`,
    `NUXT_SESSION_PASSWORD=${SESSION_PASSWORD}`,
    `NUXT_FLEET_TOKEN=${FLEET_TOKEN}`,
    ...extraVars,
  ].join('\n') + '\n',
)

const logs: string[] = []
const worker = spawn(
  'bunx',
  [
    'wrangler',
    'dev',
    '-c',
    WORKER_CONFIG,
    '--persist-to',
    stateDir,
    '--port',
    String(port),
    '--ip',
    '127.0.0.1',
    '--test-scheduled',
  ],
  {
    cwd: root,
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
    // Own process group, so the whole tree (wrangler, workerd) can be stopped.
    detached: true,
  },
)
worker.stdout.on('data', (d) => logs.push(String(d)))
worker.stderr.on('data', (d) => logs.push(String(d)))

function stopWorker(signal: NodeJS.Signals) {
  try {
    process.kill(-worker.pid!, signal)
  } catch {}
}

async function waitReady() {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.status < 500) return
    } catch {}
    await Bun.sleep(500)
  }
  throw new Error(`worker never became ready\n${logs.join('')}`)
}

// ── 3. Sessions: sealed exactly the way h3/nuxt-auth-utils seal them ─────────
async function sessionCookie(user: {
  id: string
  email: string
  name: string
  role: string
}): Promise<string> {
  const session = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    data: {
      user: { id: user.id, email: user.email, name: user.name, avatarUrl: null, role: user.role },
      issuedAt: Math.floor(Date.now() / 1000),
    },
  }
  const sealed = await seal(crypto, session, SESSION_PASSWORD, {
    ...defaults,
    ttl: 60 * 60 * 24 * 30 * 1000,
  })
  return `nuxt-session=${sealed}`
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function signature(step: WebhookStep): Promise<string> {
  const age = step.signing.kind === 'stale' ? step.signing.ageSeconds : 0
  const ts = Math.floor(Date.now() / 1000) - age
  const secret = step.signing.kind === 'bad_signature' ? 'not-the-secret' : REPLAY_SECRET
  return `ts=${ts};h1=${await hmacHex(secret, `${ts}:${step.body}`)}`
}

// ── 4. Normalisation: drop what legitimately differs run to run ──────────────
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/
function wallClock(value: string): boolean {
  // Far-future (2099) instants come from the fixtures; anything else is "now".
  return ISO.test(value) && !value.startsWith('2099-')
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !['durationMs', 'exportedAt', 'ipHash', 'stack', 'cutoff'].includes(k))
        .map(([k, v]) => [k, scrub(v)]),
    )
  }
  if (typeof value === 'string' && wallClock(value)) return '<now>'
  if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value)) return '<uuid>'
  // Inside a longer string (audit metadata is JSON text): ids and the salted
  // mailbox hash in a welcome ref are minted per run.
  if (typeof value === 'string') {
    return value
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
      .replace(/welcome_[0-9a-f]{16,}/g, 'welcome_<hash>')
  }
  return value
}

// A code minted at sign-in is random; the ones the fixtures hold are not.
const FIXED_CODES = new Set([
  REFERRAL_CODE,
  ...Object.values(REFERRAL_USERS).map((u) => u.referralCode),
])
function mintedCode(code: unknown): unknown {
  return typeof code === 'string' && !FIXED_CODES.has(code) ? '<minted>' : code
}

// Object key order is not part of any wire contract here (JSON consumers read
// by name), and registrations reorder it harmlessly: sort keys, keep arrays.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    )
  }
  return value
}

function normaliseBody(path: string, body: unknown): unknown {
  const clone = scrub(body) as Record<string, unknown> | unknown[] | string
  if (path === '/api/referral/me' && clone && typeof clone === 'object' && 'code' in clone) {
    const me = clone as Record<string, unknown>
    if (mintedCode(me.code) === '<minted>') {
      me.code = '<minted>'
      me.shareUrl = String(me.shareUrl).replace(/\?ref=.*$/, '?ref=<minted>')
    }
  }
  const sortBy = (rows: unknown, key: string) =>
    Array.isArray(rows)
      ? [...rows].sort((a, b) => String((a as never)[key]).localeCompare(String((b as never)[key])))
      : rows
  // Rows created in the same second have no stable order; sort what the page
  // sorts by creation time.
  if (clone && typeof clone === 'object' && !Array.isArray(clone)) {
    if ('history' in clone) clone.history = sortBy(clone.history, 'ref')
    if (path.includes('/admin/users/') && 'billing' in clone) {
      const billing = clone.billing as Record<string, unknown>
      billing.history = sortBy(billing.history, 'ref')
    }
    if ('entitlement' in clone && clone.entitlement && typeof clone.entitlement === 'object') {
      const e = clone.entitlement as Record<string, unknown>
      e.history = sortBy(e.history, 'ref')
    }
    if ('entitlements' in clone)
      clone.entitlements = sortBy(clone.entitlements, 'paddleSubscriptionId')
    if (path.startsWith('/api/admin/users/') && Array.isArray(clone.audit)) clone.audit = []
    if (Array.isArray(clone.auditEntries)) clone.auditEntries = []
  }
  return clone
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

// Server log lines are JSON objects with a `kind`; keep those, in order.
function logRecords(): unknown[] {
  const records: unknown[] = []
  for (const line of logs.join('').split('\n')) {
    const start = line.indexOf('{"kind"')
    if (start === -1) continue
    // Warnings and errors arrive wrapped in terminal colour codes.
    const clean = line.slice(start).replace(ANSI, '')
    try {
      records.push(scrub(JSON.parse(clean.slice(0, clean.lastIndexOf('}') + 1))))
    } catch {}
  }
  return records
}

// ── 5. Replay ────────────────────────────────────────────────────────────────
interface StepResult {
  step: string
  status: number
  /** Redirect target, for a 3xx. */
  location?: string
  body?: unknown
}

const cookies: Partial<Record<UserKey, string>> = {
  buyer: await sessionCookie(USERS.buyer),
  live: await sessionCookie(USERS.live),
  free: await sessionCookie(USERS.free),
  admin: await sessionCookie(USERS.admin),
  blocked: await sessionCookie(CANCEL_USERS.blocked),
  settled: await sessionCookie(CANCEL_USERS.settled),
  ...(referral
    ? {
        referrer: await sessionCookie(REFERRAL_USERS.referrer),
        refereePass: await sessionCookie(REFERRAL_USERS.refereePass),
        refereeSub: await sessionCookie(REFERRAL_USERS.refereeSub),
        twin: await sessionCookie(REFERRAL_USERS.twin),
      }
    : {}),
}

async function run(step: Step): Promise<StepResult> {
  if (step.type === 'webhook') {
    const res = await fetch(`${base}/paddle/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'paddle-signature': await signature(step) },
      body: step.body,
    })
    return { step: step.name, status: res.status, body: tryJson(await res.text()) }
  }
  const req = step as RequestStep
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (req.as === 'fleet') headers.authorization = `Bearer ${FLEET_TOKEN}`
  else if (req.as !== 'anonymous') headers.cookie = cookies[req.as] ?? ''
  const res = await fetch(`${base}${req.path}`, {
    method: req.method,
    headers,
    body: req.json === undefined ? undefined : JSON.stringify(req.json),
    redirect: 'manual',
  })
  if (req.capture) {
    // The session this sign-in just issued, kept so later steps can be that person.
    const session = res.headers.getSetCookie().find((c) => c.startsWith('nuxt-session='))
    if (session) cookies[req.capture] = session.split(';')[0]!
  }
  const location = res.headers.get('location') ?? undefined
  return {
    step: req.name,
    status: res.status,
    ...(location ? { location } : {}),
    body: normaliseBody(req.path, tryJson(await res.text())),
  }
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // An HTML page (SSR, or Nitro's error page): its title is what identifies it;
    // the rest is build-specific markup.
    if (/^\s*<!doctype html/i.test(text)) {
      return { html: /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1] ?? null }
    }
    // A sitemap: the URLs it lists are the contract, the lastmod stamp is the build's.
    if (/^\s*<\?xml/i.test(text)) {
      return {
        locs: [...text.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => new URL(m[1]!).pathname),
      }
    }
    return text.length > 200 ? `${text.slice(0, 200)}…` : text
  }
}

// ── 6. Row dumps ─────────────────────────────────────────────────────────────
function dumpTables() {
  const db = new Database(dbFile, { readonly: true })
  const iso = (n: number | null) => (n == null ? null : new Date(n * 1000).toISOString())
  const rows = (sql: string) => db.query(sql).all() as Record<string, unknown>[]
  const dump = {
    entitlements: rows('select * from entitlements order by paddle_subscription_id').map((r) => ({
      user_id: r.user_id,
      paddle_customer_id: r.paddle_customer_id,
      paddle_subscription_id: r.paddle_subscription_id,
      product_key: r.product_key,
      status: r.status,
      period_start: iso(r.period_start as number | null),
      current_period_end: iso(r.current_period_end as number | null),
      scheduled_change_action: r.scheduled_change_action,
      scheduled_change_at: iso(r.scheduled_change_at as number | null),
      restore_period_end: iso(r.restore_period_end as number | null),
      earned_from_ref: r.earned_from_ref,
      first_transaction_id: r.first_transaction_id,
      last_event_at: iso(r.last_event_at as number | null),
    })),
    paddle_events: rows('select * from paddle_events order by event_id').map((r) => ({
      event_id: r.event_id,
      event_type: r.event_type,
      occurred_at: iso(r.occurred_at as number | null),
    })),
    ops_events: rows('select kind, detail, path from ops_events order by kind, detail'),
    audit_log: rows(
      'select action, actor_type, target_type, target_id, metadata from audit_log order by action, target_id',
    ),
    users: referral
      ? rows('select id, email, role, referral_code, referred_by from users order by email').map(
          (r) => ({ ...r, referral_code: mintedCode(r.referral_code) }),
        )
      : rows('select id, email, role from users order by email'),
  }
  db.close()
  return dump
}

try {
  await waitReady()
  const results: StepResult[] = []
  for (const step of buildSteps({ cancelOnDeletion, referral })) results.push(await run(step))
  if (process.env.REPLAY_HOLD) {
    // Debugging aid: leave the Worker up until the named file is deleted.
    writeFileSync(process.env.REPLAY_HOLD, `${cookies.live}\n`)
    while (await Bun.file(process.env.REPLAY_HOLD).exists()) await Bun.sleep(500)
  }

  // The nightly purge: proves every registered sweep runs in the real bundle.
  const purge = await fetch(`${base}/cdn-cgi/handler/scheduled?cron=0+4+*+*+*`)
  results.push({ step: 'scheduled: nightly purge', status: purge.status })
  await Bun.sleep(1500)

  stopWorker('SIGTERM')
  await Bun.sleep(1000)

  const dump = sortKeys(
    scrub({
      results,
      tables: dumpTables(),
      logs: logRecords(),
      ...(cancelOnDeletion ? { paddleApi: stubCalls } : {}),
    }),
  )
  const text = JSON.stringify(dump, null, 2) + '\n'
  if (process.env.REPLAY_RAW_LOG) writeFileSync(process.env.REPLAY_RAW_LOG, logs.join(''))
  if (out) writeFileSync(out, text)
  else process.stdout.write(text)
} finally {
  stopWorker('SIGKILL')
  stub?.stop(true)
  rmSync(join(root, '.output/server/.dev.vars'), { force: true })
  if (!process.env.REPLAY_STATE_DIR) rmSync(stateDir, { recursive: true, force: true })
}
