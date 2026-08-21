// JSON-LD (schema.org) builders — the AEO half of this template's SEO layer.
//
// Classic SEO is about being *findable*. Answer engines — AI Overviews,
// ChatGPT Search, Perplexity, Claude — are about being *quotable*: they need to
// extract, without guessing, what this product is, who runs it, what it costs,
// and what the common questions are. Prose can be paraphrased wrongly. A typed
// graph can't.
//
// Everything here is a pure function of an explicit SiteContext, so the shapes
// are unit-testable (test/seo.test.ts) without booting Nuxt. `useSeo()` is what
// actually injects them into the document.
//
// Two rules worth keeping:
//   1. Nodes are linked by `@id`, not duplicated. One Organization node, one
//      WebSite node, and everything else points at them — that's what lets a
//      consumer resolve "this page" and "this company" to a single entity
//      instead of four unrelated blobs.
//   2. Never describe something in JSON-LD that isn't visible on the page.
//      FAQ markup without the FAQ rendered is a manual-action risk with Google
//      and, more practically, a lie an answer engine will repeat.

import { absoluteUrl } from './site'

/** A JSON-LD node. Deliberately loose — schema.org is open-world. */
export type JsonLdNode = Record<string, unknown>

export interface SiteContext {
  appName: string
  /** Canonical origin, no trailing slash. Empty disables every builder. */
  appUrl: string
  supportEmail: string
  /** The legal entity behind the app — the company, not the product. */
  legalEntity: string
}

/** Stable @id anchors so nodes across pages resolve to the same entities. */
export const SCHEMA_IDS = {
  organization: '#organization',
  website: '#website',
  application: '#application',
} as const

export function organizationSchema(site: SiteContext): JsonLdNode | null {
  if (!site.appUrl) return null
  return {
    '@type': 'Organization',
    '@id': `${site.appUrl}/${SCHEMA_IDS.organization}`,
    name: site.legalEntity,
    url: site.appUrl,
    logo: `${site.appUrl}/og.png`,
    contactPoint: {
      '@type': 'ContactPoint',
      contactType: 'customer support',
      email: site.supportEmail,
      url: `${site.appUrl}/`,
    },
  }
}

export function websiteSchema(site: SiteContext): JsonLdNode | null {
  if (!site.appUrl) return null
  return {
    '@type': 'WebSite',
    '@id': `${site.appUrl}/${SCHEMA_IDS.website}`,
    name: site.appName,
    url: site.appUrl,
    publisher: { '@id': `${site.appUrl}/${SCHEMA_IDS.organization}` },
    inLanguage: 'en',
  }
}

/**
 * The page itself. Emitted on every indexable page so each URL has a node an
 * answer engine can attribute a quote to, rather than only the site root.
 */
export function webPageSchema(
  site: SiteContext,
  page: { url: string; title: string; description: string },
): JsonLdNode | null {
  if (!site.appUrl || !page.url) return null
  return {
    '@type': 'WebPage',
    '@id': page.url,
    url: page.url,
    name: page.title,
    description: page.description,
    isPartOf: { '@id': `${site.appUrl}/${SCHEMA_IDS.website}` },
    inLanguage: 'en',
  }
}

/** What a plan costs, in the machine-readable form Offer wants. */
export interface OfferInput {
  name: string
  description: string
  /** Numeric amount — never the display string, which carries a currency glyph. */
  amount: number
  currency: string
  /** How much access the amount buys, as a schema.org unit code. */
  unit: { value: number; code: 'MON' | 'ANN' | 'DAY' }
  recurring: boolean
}

export function offerSchema(site: SiteContext, offer: OfferInput): JsonLdNode {
  return {
    '@type': 'Offer',
    name: offer.name,
    description: offer.description,
    price: String(offer.amount),
    priceCurrency: offer.currency,
    url: `${site.appUrl}/pricing`,
    availability: 'https://schema.org/InStock',
    priceSpecification: {
      '@type': 'UnitPriceSpecification',
      price: String(offer.amount),
      priceCurrency: offer.currency,
      // A recurring price and a one-time price for the same number are very
      // different products. referenceQuantity is what says which this is.
      referenceQuantity: {
        '@type': 'QuantitativeValue',
        value: offer.unit.value,
        unitCode: offer.unit.code,
      },
      ...(offer.recurring ? { billingDuration: offer.unit.value } : {}),
    },
  }
}

export function softwareApplicationSchema(
  site: SiteContext,
  input: { description: string; offers: OfferInput[] },
): JsonLdNode | null {
  if (!site.appUrl) return null
  const offers = input.offers.map((offer) => offerSchema(site, offer))
  const amounts = input.offers.map((offer) => offer.amount)
  return {
    '@type': 'SoftwareApplication',
    '@id': `${site.appUrl}/${SCHEMA_IDS.application}`,
    name: site.appName,
    url: site.appUrl,
    description: input.description,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web browser',
    publisher: { '@id': `${site.appUrl}/${SCHEMA_IDS.organization}` },
    ...(offers.length > 0
      ? {
          offers: {
            '@type': 'AggregateOffer',
            priceCurrency: input.offers[0]?.currency ?? 'USD',
            lowPrice: String(Math.min(...amounts)),
            highPrice: String(Math.max(...amounts)),
            offerCount: offers.length,
            offers,
          },
        }
      : {}),
  }
}

export interface FaqItem {
  question: string
  /** Plain text. Rendered on the page too — see rule 2 at the top of this file. */
  answer: string
}

export function faqSchema(items: FaqItem[]): JsonLdNode | null {
  if (items.length === 0) return null
  return {
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  }
}

export function breadcrumbSchema(
  site: SiteContext,
  trail: { name: string; path: string }[],
): JsonLdNode | null {
  if (!site.appUrl || trail.length === 0) return null
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: absoluteUrl(site.appUrl, crumb.path),
    })),
  }
}

/**
 * Fold nodes into a single `@graph` document. One <script> per page rather than
 * one per node: consumers parse the whole graph at once, and `@id` references
 * between nodes only resolve reliably inside a shared graph.
 */
export function jsonLdGraph(nodes: (JsonLdNode | null | undefined)[]): string {
  const graph = nodes.filter((node): node is JsonLdNode => Boolean(node))
  // Escape `<` so a value containing `</script>` can't close the tag this JSON
  // is about to be embedded in. \u003c is still a plain `<` to any JSON parser.
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(
    /</g,
    '\\u003c',
  )
}
