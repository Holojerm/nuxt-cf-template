// The files layer: R2 uploads (/files, FileUpload, /api/files), image
// transforms on download, and its contributions to core
// (server/plugins/files.ts). Expects the app to provide the `blob` (R2) and
// `images` bindings, core server utils (extensions, purge, rate limiting), the
// auth session, and `requireSubscription(event)` — from billing, or a one-line
// stand-in in a fork without it (see TEARDOWN.md). Auto-registered because it
// lives under layers/.
export default defineNuxtConfig({
  $meta: { name: 'files' },
})
