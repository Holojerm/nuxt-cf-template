// This product's own analytics events — the fork owns this file.
//
// The template ships it empty and never edits it again, so a sync never
// conflicts here. Add one entry per event the product captures, then name the
// ones that matter in fleet.json's `product` block. See analytics-events.ts.
//
//   session_completed: { origin: 'server', description: 'A practice session reached the end.' },

import type { EventDefinition } from './analytics-events'

export const APP_EVENTS = {} as const satisfies Record<string, EventDefinition>
