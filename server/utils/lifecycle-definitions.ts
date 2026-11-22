// Turns the data in lifecycle-sequence.ts into steps the runner can run.
//
// A definition says who (a clock, a delay, a window, an optional condition) and
// what (copy for the `note` email). This file owns the query and the rendering,
// so a step's wording or timing changes without anyone touching either.

import { and, exists, gt, lte, notExists, sql, type SQL } from 'drizzle-orm'

import { findUrgency } from '#shared/utils/announcements'
import {
  isOptionalNotificationEventType,
  type OptionalNotificationEventType,
} from '#shared/utils/notifications'
import * as tables from '../db/schema'
import type { LifecycleDb, LifecycleRecipient, LifecycleStep } from '../types/extension-types'
import { noteEmail } from './email-notes'
import type { Branding, EmailContent } from './email-templates'

export interface LifecycleStepDefinition {
  /** Stored in `lifecycle_sends`. Never rename one. */
  id: string
  notification: OptionalNotificationEventType
  since: 'signup' | 'last_sign_in'
  afterDays: number
  forDays: number
  when?: 'activated' | 'not_activated'
  enabled?: boolean
  subject: string
  heading: string
  paragraphs: readonly string[]
  button?: { label: string; path: string }
  footnote: string
}

const DAY_MS = 24 * 60 * 60 * 1000
const TOKEN = /\{\{\s*(\w+)\s*\}\}/g
const TOKENS = ['appName', 'name']

/** Fills {{appName}} and {{name}}. The result is data: the email template escapes it. */
export function fillCopy(text: string, values: { appName: string; name: string }): string {
  return text.replace(TOKEN, (tag, key: string) =>
    key === 'appName' ? values.appName : key === 'name' ? values.name : tag,
  )
}

/** A link from an email, tagged so a click is attributable to the step that sent it. */
export function emailLink(appUrl: string, path: string, medium: string, campaign: string): string {
  const params = new URLSearchParams({
    utm_source: 'email',
    utm_medium: medium,
    utm_campaign: campaign,
  })
  return `${appUrl}${path}${path.includes('?') ? '&' : '?'}${params.toString()}`
}

export function renderDefinition(
  definition: LifecycleStepDefinition,
  brand: Branding,
  recipient: Pick<LifecycleRecipient, 'name'>,
): EmailContent {
  const fill = (text: string) => fillCopy(text, { appName: brand.appName, name: recipient.name })
  return noteEmail(brand, {
    subject: fill(definition.subject),
    heading: fill(definition.heading),
    paragraphs: definition.paragraphs.map(fill),
    button: definition.button && {
      label: fill(definition.button.label),
      url: emailLink(brand.appUrl, definition.button.path, 'lifecycle', definition.id),
    },
    footnote: fill(definition.footnote),
  })
}

const activated = sql`(select 1 from ${tables.auditLog} where ${tables.auditLog.action} = 'onboarding.activated' and ${tables.auditLog.actorUserId} = ${tables.users.id})`

function condition(when: LifecycleStepDefinition['when']): SQL | undefined {
  if (when === 'activated') return exists(activated)
  if (when === 'not_activated') return notExists(activated)
  return undefined
}

export function defineLifecycleStep(definition: LifecycleStepDefinition): LifecycleStep {
  const clock = definition.since === 'signup' ? tables.users.createdAt : tables.users.lastLoginAt
  return {
    id: definition.id,
    notification: definition.notification,
    async due(db: LifecycleDb, now: Date, limit: number): Promise<LifecycleRecipient[]> {
      const newest = now.getTime() - definition.afterDays * DAY_MS
      const rows = await db
        .select({ userId: tables.users.id, email: tables.users.email, name: tables.users.name })
        .from(tables.users)
        .where(
          and(
            gt(clock, new Date(newest - definition.forDays * DAY_MS)),
            lte(clock, new Date(newest)),
            condition(definition.when),
            notExists(
              sql`(select 1 from ${tables.lifecycleSends} where ${tables.lifecycleSends.stepId} = ${definition.id} and ${tables.lifecycleSends.userId} = ${tables.users.id})`,
            ),
          ),
        )
        .limit(limit)
      return rows.map((row) => ({ ...row, subjectKey: '' }))
    },
    render: (brand, recipient) => renderDefinition(definition, brand, recipient),
  }
}

/** Sent the moment an account is created, without waiting for the daily run. */
export const isImmediate = (definition: LifecycleStepDefinition): boolean =>
  definition.since === 'signup' && definition.afterDays === 0

/** Everything wrong with one definition, as sentences. Empty means it is sound. */
export function definitionProblems(definition: LifecycleStepDefinition): string[] {
  const problems: string[] = []
  const copy = [
    definition.subject,
    definition.heading,
    ...definition.paragraphs,
    definition.button?.label ?? '',
    definition.footnote,
  ]
  // The same 40 characters /api/fleet keeps of a step id (server/utils/fleet-email.ts).
  if (!/^[a-z0-9][a-z0-9_]{0,39}$/.test(definition.id)) problems.push('id must be snake_case')
  if (!isOptionalNotificationEventType(definition.notification)) {
    problems.push('notification must be a preference the reader can switch off')
  }
  if (!Number.isInteger(definition.afterDays) || definition.afterDays < 0) {
    problems.push('afterDays must be a whole number, 0 or more')
  }
  if (!Number.isInteger(definition.forDays) || definition.forDays < 1) {
    problems.push('forDays must be a whole number, 1 or more: every window is bounded')
  }
  if (!definition.paragraphs.length || copy.some((text, i) => i !== 3 && !text.trim())) {
    problems.push('subject, heading, paragraphs and footnote must all have text')
  }
  if (definition.button && !/^\/(?!\/)/.test(definition.button.path)) {
    problems.push('button.path must be a path on this app, starting with one /')
  }
  for (const text of copy) {
    for (const [, key] of text.matchAll(TOKEN)) {
      if (!TOKENS.includes(key!)) problems.push(`unknown tag {{${key}}}`)
    }
    const urgency = findUrgency(text)
    if (urgency) problems.push(`urgency wording: "${urgency}"`)
  }
  return problems
}
