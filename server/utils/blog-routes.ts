import type { PublicApiRoute } from './public-routes'
import { registerPublicApiRoutes } from './public-routes'

/** The blog is public content; crawlers cannot sign in. */
export const BLOG_PUBLIC_API_ROUTES: readonly PublicApiRoute[] = [
  { path: '/api/blog', methods: ['GET'] },
  { path: '/api/blog/', match: 'prefix', methods: ['GET'] },
]

export function registerBlogPublicRoutes(): void {
  registerPublicApiRoutes(BLOG_PUBLIC_API_ROUTES)
}
