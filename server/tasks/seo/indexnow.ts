// Daily IndexNow ping: every sitemap URL whose lastmod is on or after the last
// accepted submission. Runs on the 04:00 cron (nuxt.config.ts › SCHEDULED_TASKS),
// so wiring it needs no new wrangler trigger. Unset NUXT_INDEXNOW_KEY = it logs
// once and does nothing. Logic and its tests: server/utils/indexnow.ts.
//
// `kv` is imported explicitly for the reason purge-expired-tokens.ts gives: the
// auto-import typechecks but is not always injected at runtime.

import { kv } from '@nuxthub/kv'

import {
  indexNowPayloads,
  indexNowSkipReason,
  parseSitemapUrls,
  urlsChangedSince,
  INDEXNOW_ENDPOINT,
  INDEXNOW_STATE_KEY,
} from '../../utils/indexnow'
import { logEvent } from '../../utils/log'

export default defineTask({
  meta: {
    name: 'seo:indexnow',
    description: 'Submit sitemap URLs changed since the last run to IndexNow (Bing, Yandex, …)',
  },
  async run() {
    const config = useRuntimeConfig()
    const appUrl = config.public.appUrl
    const skip = indexNowSkipReason({
      appUrl,
      indexable: config.public.indexable !== false,
      key: config.indexnowKey,
    })
    if (skip) {
      logEvent('info', 'indexnow_skipped', { reason: skip })
      return { result: { skipped: skip } }
    }

    // Never throw: a failed ping costs one day of freshness, and the next run
    // resubmits from the same `since` because the state only advances on success.
    try {
      const today = new Date().toISOString().slice(0, 10)
      const since = (await kv.get<string>(INDEXNOW_STATE_KEY)) ?? null
      // An internal fetch: Nitro routes it to the handler without a network hop.
      const xml = await $fetch<string>('/sitemap.xml', { responseType: 'text' })
      const urls = urlsChangedSince(parseSitemapUrls(xml), since)
      const payloads = indexNowPayloads(appUrl, config.indexnowKey, urls)

      const statuses: number[] = []
      for (const payload of payloads) {
        const res = await fetch(INDEXNOW_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(payload),
        })
        statuses.push(res.status)
        if (!res.ok) break
      }

      const ok = statuses.every((s) => s === 200 || s === 202)
      if (ok) await kv.set(INDEXNOW_STATE_KEY, today)
      logEvent(ok ? 'info' : 'warn', ok ? 'indexnow_submitted' : 'indexnow_rejected', {
        since,
        urls: urls.length,
        statuses,
      })
      return { result: { submitted: ok ? urls.length : 0, statuses } }
    } catch (error) {
      logEvent('warn', 'indexnow_failed', { error: String(error) })
      return { result: { error: String(error) } }
    }
  },
})
