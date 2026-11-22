// This product's glossary — the app owns this file (app-owned.json).
//
// One row is one page at /glossary/<slug>, built by ./glossary.ts. Every word
// a reader sees on that page, apart from the section headings, is a field
// here, so write each as you would the page: true of the product today,
// specific, and long enough to stand alone (the gate refuses a page under
// THIN_PAGE_MIN_WORDS words of row text). `summary` is the search snippet,
// 50 to 160 characters. `updated` is the page's lastmod: change it when you
// change the row, and IndexNow resubmits the page.
//
// The template ships three terms that are true of the template. A fork
// replaces them with its own, or removes the glossary (TEARDOWN.md).

export type GlossaryTerm = {
  slug: string
  term: string
  summary: string
  definition: string
  detail: string
  area: string
  updated: string
}

export const GLOSSARY_TERMS: readonly GlossaryTerm[] = [
  {
    slug: 'magic-link',
    term: 'Magic link',
    summary:
      'A sign-in link sent by email in place of a password. It works once, for the address it was sent to, and only inside its time limit.',
    definition:
      'A magic link is a sign-in link sent to your email address. Opening it proves you can read mail at that address, which is what a password was standing in for, so there is no password to choose, remember or leak.',
    detail:
      'Opening the link only checks that it is still usable; signing in takes a deliberate click on the page it opens. That matters because mail security scanners open every link in a message before you do, and a link that signed in on first open would be spent by the scanner.\n\nThe secret part of the link sits after the # in the address, which browsers never send to a server, so it stays out of server logs and out of the Referer header. Each mailbox can request at most 5 links in 15 minutes.',
    area: 'Sign-in',
    updated: '2026-11-22',
  },
  {
    slug: 'single-user-account',
    term: 'Single-user account',
    summary:
      'Every account here belongs to one person. There are no teams, organisations or seats, and access is granted to that person alone.',
    definition:
      'A single-user account belongs to one person and holds only that person’s data. There is no organisation above it, no membership table beside it, and no seat count attached to it.',
    detail:
      'Access is decided by ownership: a record is yours because your account created it, not because you belong to a group that may read it. Billing follows the same rule and is attached to a person rather than to a group.\n\nThis is a deliberate choice. Adding teams to a product touches every query it has already written, because each read gains a tenant check and each write an authorisation check against membership rather than ownership. Shipping one person per account keeps every query simple until a product proves it needs more.',
    area: 'Accounts',
    updated: '2026-11-22',
  },
  {
    slug: 'data-export',
    term: 'Data export',
    summary:
      'A copy of everything the product holds about your account, downloaded as one JSON file from your account page whenever you want it.',
    definition:
      'The data export is the copy of your data the privacy policy promises. It is one JSON document holding your account and the records attached to it, and you download it yourself from the account page, without writing to anyone.',
    detail:
      'The file is named after the product and ends in -export.json. It includes the privileged actions taken on your account, such as an administrator viewing it, but leaves out which administrator did so, because that is a fact about them rather than about you.\n\nIt also leaves out another person’s referral code, even when that code is what brought you here. An account can request at most 10 exports in 10 minutes.',
    area: 'Your data',
    updated: '2026-11-22',
  },
]
