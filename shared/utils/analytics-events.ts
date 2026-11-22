// Every analytics event this app records, in one list.
//
// ── Why a registry ──────────────────────────────────────────────────────────
// Event names are the join keys of every funnel. A typo'd name produces no
// error at all: PostHog accepts `user_activted` as a brand-new event and the
// funnel that counts `user_activated` quietly flatlines. `captureServerEvent`
// takes an `AnalyticsEvent` rather than a string so the compiler catches that,
// and fleet.json's `product` block may only name events from here
// (scripts/check-fleet.ts), so the dashboard never charts an event nobody fires.
//
// ── Why two files ───────────────────────────────────────────────────────────
// This file is the template's and arrives with every sync. A fork's own events
// live in `app-events.ts`, which the template ships empty and never touches
// again, so syncing never conflicts with a product's taxonomy.
//
// ── Renaming ────────────────────────────────────────────────────────────────
// Don't. PostHog history is keyed on the string; a rename splits every chart
// at the day it shipped. Add a new name and retire the old one instead.

import { APP_EVENTS } from './app-events'

/** Where an event is captured. Client events can be dropped by ad blockers. */
export type EventOrigin = 'server' | 'client'

export interface EventDefinition {
  origin: EventOrigin
  /** What happened, in one line — the growth routine reads these. */
  description: string
}

// The webhook records every `subscription.*` notification as
// `billing_subscription_<suffix>`. The billing layer's own three event types
// (layers/billing/server/utils/stripe-events.ts), so the names are registered
// rather than built from whatever string arrives.
const BILLING_SUBSCRIPTION_SUFFIXES = ['canceled', 'created', 'updated'] as const

type BillingSubscriptionEvent =
  `billing_subscription_${(typeof BILLING_SUBSCRIPTION_SUFFIXES)[number]}`

const BILLING_SUBSCRIPTION_EVENTS = Object.fromEntries(
  BILLING_SUBSCRIPTION_SUFFIXES.map((suffix) => [
    `billing_subscription_${suffix}`,
    { origin: 'server', description: `The billing webhook applied subscription.${suffix}.` },
  ]),
) as Record<BillingSubscriptionEvent, EventDefinition>

/**
 * The event name for a `subscription.*` billing event. An event type
 * added later is recorded as `billing_subscription_updated` (the webhook
 * logs the raw type) instead of minting an unregistered name.
 */
export function billingSubscriptionEvent(eventType: string): BillingSubscriptionEvent {
  const suffix = eventType.replace(/^subscription\./, '')
  return (BILLING_SUBSCRIPTION_SUFFIXES as readonly string[]).includes(suffix)
    ? (`billing_subscription_${suffix}` as BillingSubscriptionEvent)
    : 'billing_subscription_updated'
}

export const TEMPLATE_EVENTS = {
  ...BILLING_SUBSCRIPTION_EVENTS,
  $pageview: { origin: 'client', description: 'A page was viewed (SPA navigations included).' },
  $exception: { origin: 'server', description: 'An unhandled server error.' },

  user_signed_up: {
    origin: 'server',
    description: 'An account was created. Carries signup_source/medium/campaign.',
  },
  user_signed_in: { origin: 'server', description: 'An existing account signed in.' },
  user_signed_out: { origin: 'server', description: 'A user signed out.' },
  user_activated: {
    origin: 'server',
    description: 'The user finished onboarding — the template’s activation moment.',
  },

  checkout_started: { origin: 'client', description: 'A checkout was opened.' },
  checkout_unavailable: {
    origin: 'client',
    description: 'A checkout was requested and could not be started.',
  },
  checkout_completed: {
    origin: 'client',
    description: 'The buyer returned from a paid checkout. A UX signal: the webhook decides money.',
  },
  checkout_abandoned: {
    origin: 'client',
    description: 'The buyer came back from checkout without paying.',
  },

  billing_transaction_completed: {
    origin: 'server',
    description: 'A one-time payment was confirmed and access was granted.',
  },
  billing_access_revoked: {
    origin: 'server',
    description: 'Access was withdrawn (refund, chargeback, or cancellation taking effect).',
  },

  feedback_submitted: {
    origin: 'server',
    description: 'In-app feedback arrived. `kind: churn` marks a cancellation reason.',
  },
  feedback_replied: { origin: 'server', description: 'The owner replied to a feedback item.' },

  lifecycle_email_sent: {
    origin: 'server',
    description:
      'A lifecycle email went out. `step` names which (activation_nudge, pass_expiring, …).',
  },
} as const satisfies Record<string, EventDefinition>

export const ANALYTICS_EVENTS = { ...TEMPLATE_EVENTS, ...APP_EVENTS } as const

export type AnalyticsEvent = keyof typeof ANALYTICS_EVENTS

/** PostHog's own `$`-prefixed names, or snake_case. */
export const EVENT_NAME_PATTERN = /^\$?[a-z][a-z0-9_]*$/

export function isAnalyticsEvent(name: string): name is AnalyticsEvent {
  return Object.hasOwn(ANALYTICS_EVENTS, name)
}
