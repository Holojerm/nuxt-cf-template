// GET /indexnow-key.txt — the IndexNow ownership proof. The search engine
// fetches this file and checks it holds the key a submission named, which is
// how it knows the submitter controls the host. The key is public by design;
// it authorises nothing beyond "these URLs changed". See server/utils/indexnow.ts.

import { indexNowSkipReason } from '../utils/indexnow'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig()
  setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  const skip = indexNowSkipReason({
    appUrl: config.public.appUrl,
    indexable: config.public.indexable !== false,
    key: config.indexnowKey,
  })
  if (skip) {
    setResponseStatus(event, 404)
    return 'Not found\n'
  }
  setResponseHeader(event, 'Cache-Control', 'public, max-age=3600')
  return config.indexnowKey
})
