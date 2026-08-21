// The single SEO/AEO entry point for a page. Every page in app/pages calls it
// exactly once — `scripts/check-seo.ts` fails the build if one doesn't.
//
// Why a wrapper rather than calling Nuxt's `useSeoMeta` directly: four things
// have to happen together on every page, and three of them are easy to forget.
//
//   1. <link rel="canonical">. `useSeoMeta` does not emit one. On Workers the
//      same app answers on *.workers.dev *and* your custom domain, so without a
//      canonical you publish two spellings of every page and split the ranking
//      between them. This is the single highest-value tag here.
//   2. Open Graph + Twitter, with an absolute image. Relative og:image URLs are
//      dropped by most unfurlers, so a share renders as bare text.
//   3. JSON-LD. Answer engines read the graph, not the prose — see
//      shared/utils/schema.ts.
//   4. noindex, applied both per-page and globally on preview deploys.
//
// Preview builds (NUXT_PUBLIC_INDEXABLE=false) force noindex on every page and
// drop the canonical and the graph — the same decision robots.txt makes, made
// again in the document, because a crawler that ignored robots.txt still reads
// the head.

import type { JsonLdNode, SiteContext } from '#shared/utils/schema'

export interface SeoInput {
  /** Page title, without the site name — see `titleMode`. */
  title: string
  description: string
  /**
   * 'suffix' (default) renders `Pricing · My App`. 'exact' uses the title
   * verbatim, for the landing page where the brand should lead.
   */
  titleMode?: 'suffix' | 'exact'
  ogType?: 'website' | 'article'
  /** Root-relative or absolute. Defaults to the site-wide /og.png. */
  image?: string
  /** Private or duplicate page: noindex, no canonical, no structured data. */
  noindex?: boolean
  /** Page-specific JSON-LD nodes, merged into the site graph. */
  schema?: (JsonLdNode | null)[]
  /** Breadcrumb trail below Home, which is prepended for you. */
  breadcrumb?: { name: string; path: string }[]
}

/** Runtime config, narrowed to the SEO fields, as a plain testable object. */
export function useSiteContext(): SiteContext {
  const config = useRuntimeConfig()
  return {
    appName: config.public.appName,
    appUrl: normalizeOrigin(config.public.appUrl),
    supportEmail: config.public.supportEmail,
    legalEntity: config.public.legalEntity,
  }
}

export function useSeo(input: SeoInput): void {
  const config = useRuntimeConfig()
  const route = useRoute()
  const site = useSiteContext()

  const siteIndexable = config.public.indexable !== false && Boolean(site.appUrl)
  const indexable = siteIndexable && !input.noindex

  const title = input.titleMode === 'exact' ? input.title : `${input.title} · ${site.appName}`
  const canonical = absoluteUrl(site.appUrl, route.path)
  const image = toAbsoluteAsset(site.appUrl, input.image ?? '/og.png')

  useSeoMeta({
    title,
    description: input.description,
    // Explicit on every page, not just the private ones: a page that silently
    // loses its canonical is much easier to spot when the directive is always
    // written out.
    robots: indexable ? 'index, follow, max-image-preview:large' : 'noindex, nofollow',

    ogType: input.ogType ?? 'website',
    ogSiteName: site.appName,
    ogTitle: title,
    ogDescription: input.description,
    ogUrl: canonical || undefined,
    ogLocale: 'en_US',
    ogImage: image || undefined,
    ogImageWidth: image ? 1200 : undefined,
    ogImageHeight: image ? 630 : undefined,
    ogImageAlt: image ? site.appName : undefined,

    twitterCard: 'summary_large_image',
    twitterTitle: title,
    twitterDescription: input.description,
    twitterImage: image || undefined,
  })

  if (!indexable) return

  const trail = [{ name: 'Home', path: '/' }, ...(input.breadcrumb ?? [])]

  useHead({
    link: [{ rel: 'canonical', href: canonical }],
    script: [
      {
        type: 'application/ld+json',
        // `innerHTML` rather than a child node: unhead serialises this verbatim,
        // and jsonLdGraph() has already escaped `<` so it cannot close the tag.
        innerHTML: jsonLdGraph([
          organizationSchema(site),
          websiteSchema(site),
          webPageSchema(site, {
            url: canonical,
            title,
            description: input.description,
          }),
          // A Home-only breadcrumb is noise; emit one only for a real trail.
          trail.length > 1 ? breadcrumbSchema(site, trail) : null,
          ...(input.schema ?? []),
        ]),
      },
    ],
  })
}

/** Leaves absolute URLs alone; resolves root-relative ones against the origin. */
function toAbsoluteAsset(origin: string, asset: string): string {
  if (/^https?:\/\//i.test(asset)) return asset
  if (!origin) return ''
  return `${origin}${asset.startsWith('/') ? asset : `/${asset}`}`
}
