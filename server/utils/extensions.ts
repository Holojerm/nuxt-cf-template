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
import type { SQLWrapper } from 'drizzle-orm'
import type * as tables from '../db/schema'
import type { OnboardingInputs } from '#shared/utils/onboarding'
import { clearAccessGateForTest } from './access-gate'
import { clearBillingOutcomeHandlersForTest } from './billing-outcome'
import { clearEarnedAccessForTest } from './earned-access'
import { clearEntitlementViewFieldsForTest } from './entitlement-view-fields'
import { clearSignupContributorsForTest } from './signup-contributors'
import type { LifecycleStep } from '../types/extension-types'
import type { PurgeOptions } from './purge'

/** The Drizzle client shape — matches the `db` NuxtHub auto-imports. */
export type ExtensionDb = ReturnType<typeof drizzle<typeof tables>>

/** Sections a feature adds to the self-serve data export. */
export interface AccountExportSections {}

/** Sections a feature adds to the admin console's one-customer view. */
export interface AdminUserSections {}

/** Counter groups a feature adds to GET /api/fleet. */
export interface FleetCounterSections {}

/** Sections a feature adds to the admin console's read-only "view as" payload. */
export interface AdminViewAsSections {}

/** A key with an export section must match its AccountExportSections type. */
type ExportSectionOf<K extends string> = K extends keyof AccountExportSections
  ? AccountExportSections[K]
  : never

export interface AccountContributor<K extends string = string> {
  key: K
  /**
   * Rows deletion will touch, read before anything is touched. Recorded on the
   * `account.deleted` audit row as `<key>Count` (audit before act). Omit it
   * when the contributor deletes nothing (an export-only section), so the
   * audit row gains no count of zero.
   */
  countForDeletion?: (db: ExtensionDb, userId: string) => Promise<number>
  /**
   * Overrides the `<key>Count` metadata name. For an app whose audit history
   * already records this count under another name: rows are append-only, so a
   * rename would split that history in two.
   */
  countKey?: string
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

/**
 * Plain numbers a fork adds to `extra` in GET /api/fleet (sessions run, plans
 * created). Use `FleetCounterContributor` instead for a typed, nested group.
 * `extra` is what the fleet dashboard already renders generically, so a counter
 * here needs no change on the dashboard.
 */
export interface FleetExtraContributor {
  key: string
  /**
   * Counts only, like every fleet counter. Names must be unique across
   * contributors; on a clash the contributor registered later wins.
   */
  collect: (db: ExtensionDb, now: Date) => Promise<Record<string, number>>
}

/**
 * What deleteAccount() knows about the request, handed to every guard and
 * resolver so the audit rows they write describe it the way the route's own
 * rows do. Optional on both sides: a caller with no request (a test, a script)
 * passes none, and a guard or resolver that ignores it keeps working.
 */
export interface DeletionContext {
  /** Salted IP hash for an audit row (`auditIpHash(event)`); null when unknown. */
  ipHash?: string | null
}

/**
 * Why an account may not be deleted right now. `code` and `data` reach the
 * client verbatim on a 409, so a UI can branch on them; `message` is the text
 * the person reads.
 */
export interface DeletionBlock {
  code: string
  message: string
  data?: Record<string, unknown>
}

/**
 * A veto over account deletion, asked before anything is touched. For the rare
 * case where deleting would hurt the person, not the app (billing: Paddle would
 * keep charging a card nobody can look up). First registered guard to refuse
 * wins. Must be a read: nothing here may write.
 */
export interface DeletionGuard {
  key: string
  check: (
    db: ExtensionDb,
    userId: string,
    context?: DeletionContext,
  ) => Promise<DeletionBlock | null>
}

/**
 * Work that has to happen before an account can be deleted, and may write:
 * billing cancels the subscription at its provider here. Runs after every
 * DeletionGuard has passed and before deleteAccount() reads its counts or writes
 * its audit row. Returns a block to refuse (nothing is deleted; whatever the
 * resolver already did stays done), or null to let deletion go on. It must fail
 * closed: if it cannot do what deletion depends on, it returns a block, never
 * null. A guard is for "may we delete", a resolver for "make it deletable".
 * Register few: they run in registration order and are not rolled back.
 */
export interface DeletionResolver {
  key: string
  resolve: (
    db: ExtensionDb,
    userId: string,
    context?: DeletionContext,
  ) => Promise<DeletionBlock | null>
}

/**
 * One section of the admin "view as" payload, plus the gates it contributes
 * (route-level conditions the console reports as pass/fail). The payload is
 * `{ readOnly, user, ...sections, gates: { auth: true, ...gates }, dashboardReachable }`
 * where `dashboardReachable` is true only if every gate passes.
 */
export interface AdminViewAsContributor<
  K extends keyof AdminViewAsSections = keyof AdminViewAsSections,
> {
  key: K
  load: (
    db: ExtensionDb,
    userId: string,
  ) => Promise<{ value: AdminViewAsSections[K]; gates?: Record<string, boolean> }>
}

/**
 * The count behind a funnel stage that only a feature can answer. Today one
 * stage: `paid`, users in the signup cohort who bought something. With no
 * contributor the stage reports 0, so GET /api/fleet keeps its shape.
 */
export interface FunnelStageContributor {
  key: 'paid'
  /** `cohort` is a subquery of the user ids that signed up in the window. */
  count: (db: ExtensionDb, cohort: SQLWrapper) => Promise<number>
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
const fleetExtraContributors = new Map<string, FleetExtraContributor>()
const onboardingSignalContributors = new Map<string, OnboardingSignalContributor>()
const purgeContributors = new Map<string, PurgeContributor>()
const deletionGuards = new Map<string, DeletionGuard>()
const deletionResolvers = new Map<string, DeletionResolver>()
const adminViewAsContributors = new Map<string, AdminViewAsContributor>()
const funnelStageContributors = new Map<string, FunnelStageContributor>()
const lifecycleSteps = new Map<string, LifecycleStep>()

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

export function registerFleetExtraContributor(contributor: FleetExtraContributor): void {
  fleetExtraContributors.set(contributor.key, contributor)
}

export function registerOnboardingSignalContributor(
  contributor: OnboardingSignalContributor,
): void {
  onboardingSignalContributors.set(contributor.key, contributor)
}

export function registerPurgeContributor(contributor: PurgeContributor): void {
  purgeContributors.set(contributor.key, contributor)
}

export function registerDeletionGuard(guard: DeletionGuard): void {
  deletionGuards.set(guard.key, guard)
}

export function registerDeletionResolver(resolver: DeletionResolver): void {
  deletionResolvers.set(resolver.key, resolver)
}

export function registerAdminViewAsContributor<K extends keyof AdminViewAsSections>(
  contributor: AdminViewAsContributor<K>,
): void {
  adminViewAsContributors.set(contributor.key, contributor as unknown as AdminViewAsContributor)
}

export function registerFunnelStageContributor(contributor: FunnelStageContributor): void {
  funnelStageContributors.set(contributor.key, contributor)
}

/**
 * Add a step to the lifecycle email run, after the template's own and before
 * the app's (lifecycle-app-steps.ts). Keyed by step id, so registering twice
 * replaces. Never rename an id: a renamed step re-sends to everyone.
 */
export function registerLifecycleStep(step: LifecycleStep): void {
  lifecycleSteps.set(step.id, step)
}

export function getDeletionGuards(): DeletionGuard[] {
  return [...deletionGuards.values()]
}

export function getDeletionResolvers(): DeletionResolver[] {
  return [...deletionResolvers.values()]
}

export function getAdminViewAsContributors(): AdminViewAsContributor[] {
  return [...adminViewAsContributors.values()]
}

export function getFunnelStageContributor(key: FunnelStageContributor['key']) {
  return funnelStageContributors.get(key)
}

export function getRegisteredLifecycleSteps(): LifecycleStep[] {
  return [...lifecycleSteps.values()]
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

export function getFleetExtraContributors(): FleetExtraContributor[] {
  return [...fleetExtraContributors.values()]
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
  fleetExtraContributors.clear()
  onboardingSignalContributors.clear()
  purgeContributors.clear()
  deletionGuards.clear()
  deletionResolvers.clear()
  adminViewAsContributors.clear()
  funnelStageContributors.clear()
  lifecycleSteps.clear()
  clearAccessGateForTest()
  clearBillingOutcomeHandlersForTest()
  clearEarnedAccessForTest()
  clearEntitlementViewFieldsForTest()
  clearSignupContributorsForTest()
}
