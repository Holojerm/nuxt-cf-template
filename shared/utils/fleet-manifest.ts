// The fleet manifest — how an app forked from this template describes itself
// to the portfolio dashboard (`fleet`), and to anything else that wants to
// manage many of these apps at once.
//
// ── Why a file, and why this shape ──────────────────────────────────────────
// Everything a dashboard needs to *find* an app already exists somewhere in
// the repo — the Worker name in wrangler.toml, the crons in two places, the
// stage of the product in the README's tone of voice. None of it is readable
// by a program, and two of those sources are allowed to disagree without
// anything failing. `fleet.json` is the one place that says it all in a shape
// a Worker can fetch from GitHub and parse without a TOML library, and
// scripts/check-fleet.ts fails the build the moment it stops matching
// wrangler.toml. The manifest can therefore be trusted, which is the whole
// point of having one.
//
// ── Why shared/ ─────────────────────────────────────────────────────────────
// Three readers, three runtimes: the CI gate (Bun, via a relative import),
// `/api/status` (the Worker, via `#shared`), and the fleet dashboard itself
// (a copy of this file — it is a fork of this template, so the copy arrives
// with the sync). A schema that only one of them could import would be three
// schemas within a month.
//
// ── Versioning ──────────────────────────────────────────────────────────────
// `schema` is a literal. A breaking change to this shape bumps it, and a
// reader that sees a number it does not know reports "manifest newer than
// me" instead of guessing. Additive changes (a new optional key) do not bump
// it — `strictObject` rejects keys it has not heard of, which is deliberate:
// a typo'd key would otherwise be silently ignored, and a manifest field that
// is silently ignored is a lie the dashboard repeats.

import { z } from 'zod'

export const FLEET_MANIFEST_SCHEMA_VERSION = 1

/**
 * Where the product is in its life. Drives which findings apply: a `dormant`
 * app with no traffic is fine; a `live` app with no traffic is an outage.
 *
 *   live        — has users it would be bad to lose; everything is checked
 *   built       — feature-complete, not launched; health and drift checked,
 *                 traffic ignored
 *   dormant     — finished and deliberately parked; drift reported as info
 *   unreleased  — still being set up; placeholder ids are allowed
 *   personal    — a tool for the owner alone; no business counters
 */
export const FLEET_STAGES = ['live', 'built', 'dormant', 'unreleased', 'personal'] as const
export type FleetStage = (typeof FLEET_STAGES)[number]

/** How code reaches production. Decides where the dashboard looks for CI status. */
export const FLEET_DEPLOY_MECHANISMS = ['workers-builds', 'github-actions', 'manual'] as const
export type FleetDeployMechanism = (typeof FLEET_DEPLOY_MECHANISMS)[number]

/**
 * Binding ids the template ships with. A manifest may carry these only while
 * `stage` is `unreleased`; check-fleet fails the build on them anywhere else,
 * because a deploy with a placeholder id fails on Cloudflare's side with an
 * error that does not mention the placeholder.
 */
export const PLACEHOLDER_ID = /^YOUR_/

// Worker names, D1 names and R2 buckets share Cloudflare's resource-name rule,
// which is also the rule scripts/rename.ts enforces on the new name.
const resourceName = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,52}[a-z0-9]$/,
    'lowercase letters, digits and hyphens; starts and ends alphanumeric',
  )

// Five whitespace-separated fields. Deliberately not a full cron parser: the
// gate that matters is the exact-string match against wrangler.toml and
// nuxt.config.ts (scripts/check-crons.ts), and a looser shape here would let a
// typo reach that gate with a less useful error.
const cronExpression = z
  .string()
  .regex(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/, 'a five-field cron expression, e.g. "0 4 * * *"')

const gitSha = z.string().regex(/^[0-9a-f]{7,40}$/, 'a git commit sha (7–40 hex characters)')

const envVarName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'an environment variable name, e.g. NUXT_SESSION_PASSWORD')

export const FleetManifestSchema = z.strictObject({
  schema: z.literal(FLEET_MANIFEST_SCHEMA_VERSION),

  /** Stable identifier; the dashboard keys everything on it. Matches the Worker name. */
  slug: resourceName,
  /** Display name, as in NUXT_PUBLIC_APP_NAME. */
  name: z.string().min(1).max(80),
  stage: z.enum(FLEET_STAGES),

  urls: z.strictObject({
    /**
     * The production origin, no trailing slash. The dashboard fetches
     * `/api/status` and `/api/fleet` relative to this, so it must be the
     * origin the Worker actually serves — the same value as
     * NUXT_PUBLIC_APP_URL in wrangler.toml, which check-fleet verifies.
     */
    prod: z.url(),
    /**
     * Where liveness and status answer, as paths on `prod`. Defaults are the
     * contract's own routes; an app that is not a template fork (a Hono API
     * with `/health`) says so here instead of being reported as down.
     */
    health: z.string().regex(/^\//, 'a path, e.g. /api/health').default('/api/health'),
    status: z.string().regex(/^\//, 'a path, e.g. /api/status').default('/api/status'),
  }),

  /**
   * Every Worker this repository deploys, the app first. The MCP worker in
   * mcp/ is the usual second entry. Each one is looked up in the Cloudflare
   * account by this exact name.
   */
  workers: z.array(resourceName).min(1),

  /** The production bindings, as declared in wrangler.toml. */
  bindings: z.strictObject({
    d1: z.array(z.strictObject({ name: resourceName, id: z.string().min(1) })).default([]),
    kv: z.array(z.string().min(1)).default([]),
    r2: z.array(resourceName).default([]),
  }),

  /** `[triggers] crons` from wrangler.toml, verbatim. */
  crons: z.array(cronExpression).default([]),

  deploy: z.enum(FLEET_DEPLOY_MECHANISMS),

  template: z.strictObject({
    /** `owner/repo` of the template this app was forked from. */
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/repo'),
    /**
     * The template commit this app was last synced to. Written by the
     * /sync-forks command; null until the first sync. "How far behind the
     * template is this fork" is computed from here, because the forks are
     * plain copies rather than GitHub forks and have no other shared ancestor
     * the API can see.
     */
    syncedSha: gitSha.nullable(),
  }),

  /** Which optional template modules this app kept. Decides which counters exist. */
  features: z.strictObject({
    /** Has a `users` table and sign-in; false for a single-user tool. */
    auth: z.boolean(),
    /** Paddle billing and the `entitlements` table. */
    billing: z.boolean(),
    /** PostHog project, or null when analytics is not wired up. */
    posthog: z.strictObject({ projectId: z.number().int().positive() }).nullable(),
    /** The `ops_events` spool and its digest cron. */
    opsEvents: z.boolean(),
  }),

  /**
   * Secret NAMES the production Worker must have set. Values never appear
   * here. The dashboard compares this list against the names Cloudflare
   * reports, so a secret that was never `wrangler secret put` is a finding
   * rather than a 500 on the first request that needs it.
   */
  secrets: z.array(envVarName).default([]),

  /** Deep links the dashboard shows. All optional. */
  links: z
    .strictObject({
      github: z.url().optional(),
    })
    .default({}),
})

export type FleetManifest = z.infer<typeof FleetManifestSchema>
export type FleetManifestInput = z.input<typeof FleetManifestSchema>

/** Binding ids still carrying a template placeholder, as `d1:<name>` / `kv:<id>`. */
export function placeholderBindings(manifest: FleetManifest): string[] {
  const found: string[] = []
  for (const d1 of manifest.bindings.d1) {
    if (PLACEHOLDER_ID.test(d1.id)) found.push(`d1:${d1.name}`)
  }
  for (const kv of manifest.bindings.kv) {
    if (PLACEHOLDER_ID.test(kv)) found.push(`kv:${kv}`)
  }
  return found
}
