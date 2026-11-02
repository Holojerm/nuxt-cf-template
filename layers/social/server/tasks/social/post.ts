// Cron task: send due social posts (server/utils/social.ts).
//
// Not scheduled by the layer — the app lists `social:post` in SCHEDULED_TASKS
// next to whatever enqueues. With no Buffer key this returns before touching
// the database, so an app that never configures it pays nothing.
//
// Imports are explicit for the reason server/tasks/ops/alert.ts spells out.

import { db } from '@nuxthub/db'

import { recordOpsEvent } from '#server/utils/ops'

import { createBufferPublisher } from '../../utils/buffer'
import { drainSocialPosts, readSocialConfig } from '../../utils/social'

export default defineTask({
  meta: {
    name: 'social:post',
    description: 'Send due posts from the social outbox through Buffer',
  },
  async run() {
    const config = readSocialConfig(useRuntimeConfig().social)
    if (!config) return { result: { skipped: 'unconfigured' } }

    const outcome = await drainSocialPosts(db, {
      config,
      publisher: createBufferPublisher(config.apiKey),
    })
    // A failed or maybe-sent post needs a person, so it goes to the ops digest.
    for (const problem of outcome.problems) {
      await recordOpsEvent(db, {
        kind: `social_${problem.status}`,
        detail: `${problem.service} ${problem.kind}/${problem.ref} (row ${problem.id}): ${problem.error}`,
      })
    }
    if (outcome.sent || outcome.dryRun || outcome.problems.length) {
      console.warn(JSON.stringify({ kind: 'social_post_run', ...outcome }))
    }
    return { result: outcome }
  },
})
