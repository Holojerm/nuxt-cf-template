// Public-page membership, declared on the page it describes.
//
// The alternative — hardcoded path lists inside server/routes/sitemap.xml.get.ts
// and server/routes/llms.txt.get.ts — is two more places to remember. They get
// forgotten: someone adds /changelog, ships it, and it is simply never in
// either file, with nothing failing.
//
// `definePageMeta` is statically analysed at build time, so `pages:extend` in
// nuxt.config.ts can collect these into runtime config and both routes can
// render whatever the route table actually contains. A page without this key
// is in neither — the right default, since most pages added to an app are
// private.
//
// `scripts/check-seo.ts` enforces the other half: a page that is indexable must
// declare it, and a `noindex` page must not.

declare module '#app' {
  interface PageMeta {
    /**
     * Present = this page is public and belongs in sitemap.xml and llms.txt.
     * Absent = it does not. Two files, one declaration, on the page itself.
     */
    publicPage?: {
      /** Crawl-frequency hint. Advisory — engines largely infer this now. */
      changefreq: 'daily' | 'weekly' | 'monthly' | 'yearly'
      /** Relative importance within this site only, '0.0'–'1.0'. */
      priority: string
      /** Human title, used as the link text in llms.txt. */
      title: string
      /**
       * One sentence describing what a model will find here. This is the line
       * an answer engine reads when deciding whether to fetch the page, so
       * write it as a claim about the content, not marketing copy.
       */
      summary: string
    }
  }
}

export {}
