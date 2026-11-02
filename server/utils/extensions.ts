// Extension points: the places core reads data that belongs to an optional
// feature. A feature registers a contributor here instead of core importing
// its tables, so removing the feature (or, later, not extending its layer)
// leaves core compiling and behaving correctly with one fewer section.
//
// ── Why a plain registry, not Nitro hooks ────────────────────────────────────
// Every consumer below takes the Drizzle client as an argument so the workerd
// test suite can drive it without booting Nitro. Nitro runtime hooks only exist
// inside a running Nitro app, so they would vanish exactly where the tests run.
// Features register from a Nitro plugin (see layers/feedback/server/plugins/feedback.ts) and
// tests call the same register function directly.
//
// ── Typing ───────────────────────────────────────────────────────────────────
// Each section map below is an empty interface a feature augments with
// `declare module`, so a contributor's output stays typed all the way to the
// JSON response and the page that renders it. Consumers spread sections at the
// top level of their response, which keeps every wire shape unchanged.

import type { BatchItem } from 'drizzle-orm/batch'
import type { drizzle } from 'drizzle-orm/d1'
import type * as tables from '../db/schema'
import type { OnboardingInputs } from '#shared/utils/onboarding'
import type { PurgeOptions } from './purge'

/** The Drizzle client shape — matches the `db` NuxtHub auto-imports. */
export type ExtensionDb = ReturnType<typeof drizzle<typeof tables>>

/** Sections a feature adds to the self-serve data export. */
export interface AccountExportSections {}

/** Sections a feature adds to the admin console's one-customer view. */
export interface AdminUserSections {}

/** Counter groups a feature adds to GET /api/fleet. */
export interface FleetCounterSections {}

/** A key with an export section must match its AccountExportSections type. */
type ExportSectionOf<K extends string> = K extends keyof AccountExportSections
  ? AccountExportSections[K]
  : never

export interface AccountContributor<K extends string = string> {
  key: K
  /**
   * Rows deletion will touch, read before anything is touched. Recorded on the
   * `account.deleted` audit row as `<key>Count` (audit before act).
   */
  countForDeletion: (db: ExtensionDb, userId: string) => Promise<number>
  /**
   * Work that cannot join the batch, run just before it (after the audit row):
   * e.g. sweeping R2 objects while their rows still name them. Must not throw
   * for a best-effort failure — the person is waiting on their deletion.
   */
  beforeDeletion?: (db: ExtensionDb, userId: string) => Promise<void>
  /** Statements that run inside deleteAccount's single D1 batch. */
  deletionStatements?: (db: ExtensionDb, userId: string) => BatchItem<'sqlite'>[]
  /** Omit when the feature's rows are not part of the data export. */
  exportSection?: (db: ExtensionDb, userId: string) => Promise<ExportSectionOf<K>>
}

export interface AdminUserContributor<K extends keyof AdminUserSections = keyof AdminUserSections> {
  key: K
  /** Runs inside the route's withAudit callback, after the view is recorded. */
  load: (db: ExtensionDb, userId: string) => Promise<AdminUserSections[K]>
}

export interface FleetCounterContributor<
  K extends keyof FleetCounterSections = keyof FleetCounterSections,
> {
  key: K
  /** Counts only. The payload is stored for months in another app's database. */
  collect: (db: ExtensionDb, now: Date) => Promise<FleetCounterSections[K]>
}

export interface PurgeContributor {
  /** Reported under this key in the purge task's result and log line. */
  key: string
  /** One bounded sweep; `truncated` when a full batch came back. */
  run: (db: ExtensionDb, options: PurgeOptions) => Promise<{ count: number; truncated: boolean }>
}

export interface OnboardingSignalContributor {
  key: string
  /** Partial OnboardingInputs merged over the core signals. */
  read: (db: ExtensionDb, userId: string) => Promise<Partial<OnboardingInputs>>
}

// Keyed by contributor key, so registering twice (plugin + test, or a dev
// reload) replaces rather than duplicates.
const accountContributors = new Map<string, AccountContributor>()
const adminUserContributors = new Map<string, AdminUserContributor>()
const fleetCounterContributors = new Map<string, FleetCounterContributor>()
const onboardingSignalContributors = new Map<string, OnboardingSignalContributor>()
const purgeContributors = new Map<string, PurgeContributor>()

export function registerAccountContributor<K extends string>(
  contributor: AccountContributor<K>,
): void {
  accountContributors.set(contributor.key, contributor as unknown as AccountContributor)
}

export function registerAdminUserContributor<K extends keyof AdminUserSections>(
  contributor: AdminUserContributor<K>,
): void {
  adminUserContributors.set(contributor.key, contributor as unknown as AdminUserContributor)
}

export function registerFleetCounterContributor<K extends keyof FleetCounterSections>(
  contributor: FleetCounterContributor<K>,
): void {
  fleetCounterContributors.set(contributor.key, contributor as unknown as FleetCounterContributor)
}

export function registerOnboardingSignalContributor(
  contributor: OnboardingSignalContributor,
): void {
  onboardingSignalContributors.set(contributor.key, contributor)
}

export function registerPurgeContributor(contributor: PurgeContributor): void {
  purgeContributors.set(contributor.key, contributor)
}

export function getPurgeContributors(): PurgeContributor[] {
  return [...purgeContributors.values()]
}

export function getAccountContributors(): AccountContributor[] {
  return [...accountContributors.values()]
}

export function getAdminUserContributors(): AdminUserContributor[] {
  return [...adminUserContributors.values()]
}

export function getFleetCounterContributors(): FleetCounterContributor[] {
  return [...fleetCounterContributors.values()]
}

export function getOnboardingSignalContributors(): OnboardingSignalContributor[] {
  return [...onboardingSignalContributors.values()]
}

/** Run each contributor's loader in parallel and key the results. */
export async function collectSections<C extends { key: string }, S>(
  contributors: C[],
  load: (contributor: C) => Promise<unknown>,
): Promise<Partial<S>> {
  const values = await Promise.all(contributors.map(load))
  return Object.fromEntries(contributors.map((c, i) => [c.key, values[i]])) as Partial<S>
}

/** Test-only: forget every registration, to exercise core with no features. */
export function clearExtensionsForTest(): void {
  accountContributors.clear()
  adminUserContributors.clear()
  fleetCounterContributors.clear()
  onboardingSignalContributors.clear()
  purgeContributors.clear()
}
