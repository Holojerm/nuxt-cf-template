// The files layer: R2 uploads (/files, FileUpload, /api/files), image
// transforms on download, and its contributions to core
// (server/plugins/files.ts). Expects the app to provide the `blob` (R2) and
// `images` bindings, core server utils (extensions, purge, rate limiting), the
// auth session and core's paywall gate, `requireAccess(event)`
// (server/utils/access-gate.ts): the billing layer registers the real check,
// and without it any signed-in user passes (see TEARDOWN.md). The page's
// client middleware `subscription` also comes from billing. Auto-registered
// because it lives under layers/.
export default defineNuxtConfig({
  $meta: { name: 'files' },
})
