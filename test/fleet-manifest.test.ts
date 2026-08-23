// The fleet manifest schema, and the template's own fleet.json against it.
//
// The template's manifest is the worked example every fork starts from, so it
// had better parse — and `strictObject` had better reject the things a typo
// produces, because a silently ignored key is a lie the dashboard repeats.

import { describe, expect, it } from 'vitest'

import {
  FLEET_MANIFEST_SCHEMA_VERSION,
  FleetManifestSchema,
  placeholderBindings,
  type FleetManifestInput,
} from '../shared/utils/fleet-manifest'

import templateManifest from '../fleet.json'

const valid: FleetManifestInput = {
  schema: 1,
  slug: 'sinew',
  name: 'Sinew',
  stage: 'built',
  urls: { prod: 'https://sinew.coach' },
  workers: ['sinew'],
  bindings: {
    d1: [{ name: 'sinew-db', id: '3c5d50d8-e259-4f92-876b-db162c3df7cb' }],
    kv: ['e8010635aaaa4bbbbccccddddeeeeffff'],
    r2: ['sinew-blob'],
  },
  crons: ['0 3 * * *', '*/30 * * * *'],
  deploy: 'github-actions',
  template: { repo: 'Holojerm/nuxt-cf-template', syncedSha: 'd0b2f48' },
  features: { auth: true, billing: false, posthog: { projectId: 12345 }, opsEvents: true },
  secrets: ['NUXT_SESSION_PASSWORD', 'NUXT_FLEET_TOKEN'],
}

describe('FleetManifestSchema', () => {
  it('accepts this repo’s own fleet.json, whatever it has been renamed to', () => {
    // Deliberately not pinned to `my-app`: this test ships to every fork, and
    // `bun run rename` rewrites the manifest before anyone runs it there.
    const parsed = FleetManifestSchema.parse(templateManifest)
    expect(parsed.schema).toBe(FLEET_MANIFEST_SCHEMA_VERSION)
    expect(parsed.workers[0]).toBe(parsed.slug)
    expect(parsed.bindings.d1[0]?.name).toBe(`${parsed.slug}-db`)
  })

  it('accepts a fully populated manifest and fills the optional lists', () => {
    const parsed = FleetManifestSchema.parse(valid)
    expect(parsed.links).toEqual({})
    expect(parsed.template.syncedSha).toBe('d0b2f48')
  })

  it('defaults the lists a minimal manifest leaves out', () => {
    const minimal: FleetManifestInput = {
      ...valid,
      bindings: {},
      crons: undefined,
      secrets: undefined,
    }
    const parsed = FleetManifestSchema.parse(minimal)
    expect(parsed.bindings).toEqual({ d1: [], kv: [], r2: [] })
    expect(parsed.crons).toEqual([])
    expect(parsed.secrets).toEqual([])
  })

  it('rejects a key it does not know — a typo must fail, not vanish', () => {
    const result = FleetManifestSchema.safeParse({ ...valid, stage_: 'live' })
    expect(result.success).toBe(false)
  })

  it('rejects a schema version it does not know', () => {
    expect(FleetManifestSchema.safeParse({ ...valid, schema: 2 }).success).toBe(false)
  })

  it('rejects a slug that is not a Cloudflare resource name', () => {
    expect(FleetManifestSchema.safeParse({ ...valid, slug: 'My App' }).success).toBe(false)
    expect(FleetManifestSchema.safeParse({ ...valid, slug: '-app' }).success).toBe(false)
  })

  it('rejects a cron that is not five fields', () => {
    expect(FleetManifestSchema.safeParse({ ...valid, crons: ['0 4 * *'] }).success).toBe(false)
    expect(FleetManifestSchema.safeParse({ ...valid, crons: ['every day'] }).success).toBe(false)
  })

  it('rejects an unknown stage or deploy mechanism', () => {
    expect(FleetManifestSchema.safeParse({ ...valid, stage: 'prod' }).success).toBe(false)
    expect(FleetManifestSchema.safeParse({ ...valid, deploy: 'vercel' }).success).toBe(false)
  })

  it('rejects a secret that is not an environment variable name', () => {
    expect(FleetManifestSchema.safeParse({ ...valid, secrets: ['nuxt_session'] }).success).toBe(
      false,
    )
  })

  it('requires the template repo as owner/repo and the sha as hex', () => {
    expect(
      FleetManifestSchema.safeParse({
        ...valid,
        template: { repo: 'nuxt-cf-template', syncedSha: null },
      }).success,
    ).toBe(false)
    expect(
      FleetManifestSchema.safeParse({
        ...valid,
        template: { repo: 'Holojerm/nuxt-cf-template', syncedSha: 'main' },
      }).success,
    ).toBe(false)
  })
})

describe('placeholderBindings', () => {
  it('names every binding still carrying a template placeholder', () => {
    // Deliberately an inline fixture rather than the repo's own fleet.json:
    // this asserts what the function does with placeholder ids, not whether
    // this particular fork has been provisioned yet. Reading fleet.json made
    // the test fail the day the real ids landed, which told us nothing about
    // placeholderBindings().
    const unprovisioned = FleetManifestSchema.parse({
      ...valid,
      stage: 'unreleased',
      bindings: {
        d1: [{ name: 'my-app-db', id: 'YOUR_D1_DATABASE_ID' }],
        kv: ['YOUR_KV_NAMESPACE_ID'],
        r2: ['my-app-blob'],
      },
    })
    expect(placeholderBindings(unprovisioned)).toEqual(['d1:my-app-db', 'kv:YOUR_KV_NAMESPACE_ID'])
  })

  it('is empty once real ids are in', () => {
    expect(placeholderBindings(FleetManifestSchema.parse(valid))).toEqual([])
  })
})
