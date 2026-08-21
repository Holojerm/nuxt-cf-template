// The pricing FAQ — one array, rendered on /pricing *and* emitted as FAQPage
// JSON-LD from the same source.
//
// That sharing is the whole point. Google issues manual actions for FAQ markup
// describing content a visitor can't see, and an answer engine that quotes an
// answer which isn't on the page sends people to a page that contradicts it.
// One array means the visible copy and the structured data cannot disagree.
//
// Answers are plain text on purpose: FAQPage `text` is not a place for markup,
// and these strings are what a machine will read aloud as your answer. Write
// them as complete sentences that stand alone, without "see above".

import type { FaqItem } from '#shared/utils/schema'

export const PRICING_FAQ: FaqItem[] = [
  {
    question: 'Who charges my card?',
    answer:
      'Paddle. They are the merchant of record for every plan, so your receipt and any invoice come from Paddle rather than from us, and they handle sales tax and VAT in your country.',
  },
  {
    question: 'Can I cancel a subscription myself?',
    answer:
      'Yes. Cancel from your account page at any time, without emailing anyone. Access continues to the end of the period you have already paid for, and nothing is charged after that.',
  },
  {
    question: 'What happens if I get a refund?',
    answer:
      'A refund ends access immediately rather than at the end of the period. Chargebacks work the same way.',
  },
  {
    question: 'Does the 30-day pass renew?',
    answer:
      'No. The pass is a single charge that never auto-renews. If you buy another pass while one is still running, the days stack on top of the time you have left instead of replacing it.',
  },
  {
    question: 'Is there a free trial?',
    answer:
      'There is no time-limited trial. The 30-day pass is the low-commitment option: it costs less than a subscription, includes everything, and stops on its own.',
  },
]
