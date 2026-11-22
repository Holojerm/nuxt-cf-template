// Registers the app's page collections (server/utils/page-collections-app.ts)
// once per isolate. A collection whose definition fails its checks throws here,
// which `bun run seo:check` reports first with the same messages.

import { APP_PAGE_COLLECTIONS } from '../utils/page-collections-app'
import { registerPageCollection } from '../utils/page-collections'

export default defineNitroPlugin(() => {
  for (const collection of APP_PAGE_COLLECTIONS) registerPageCollection(collection)
})
