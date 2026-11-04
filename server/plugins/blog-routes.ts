// Registered by the blog rather than listed in core, so a fork that deletes the
// blog (TEARDOWN.md › Blog) does not keep public rules for routes it no longer has.

import { registerBlogPublicRoutes } from '../utils/blog-routes'

export default defineNitroPlugin(() => {
  registerBlogPublicRoutes()
})
