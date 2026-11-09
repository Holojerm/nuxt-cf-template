// Where a page's share card lives. Cards are PNGs drawn at build time by
// `scripts/og-images.ts` into `public/og/`, so the Worker serves them as static
// assets and the render path adds nothing to the bundle. Only this path rule is
// shared: the build writes the file, `useSeo()` links to it.

/** The route `/pricing` maps to og/pricing.png under public/. The home page is the site card, public/og.png. */
export function ogCardPath(routePath: string): string {
  const clean = routePath.split(/[?#]/)[0]!.replace(/^\/+|\/+$/g, '')
  return clean === '' ? '/og.png' : `/og/${clean}.png`
}
