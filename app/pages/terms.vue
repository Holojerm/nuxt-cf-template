<script setup lang="ts">
// ── A STARTING POINT, NOT LEGAL ADVICE ───────────────────────────────────────
// This is a plain-language terms template for a solo/small SaaS selling through
// Paddle as merchant of record. It is written to be readable and to describe
// what this codebase actually does (refunds revoke access, cancellation is
// self-serve, Paddle holds the payment relationship) — which is the part
// generators get wrong.
//
// It is NOT reviewed by a lawyer and is not tailored to your jurisdiction,
// your entity, or what you actually sell. Have someone qualified read it before
// you take real money. The banner at the top of the page says the same thing to
// you, in the browser, until you remove it.

definePageMeta({
  publicPage: {
    changefreq: 'yearly',
    priority: '0.3',
    title: 'Terms of Service',
    summary:
      'The contract: what you may do with the service, how billing and cancellation work, and the full refund policy.',
  },
})

const config = useRuntimeConfig()

// Bump when you change the terms. Users are entitled to know when the deal changed.
const LAST_UPDATED = '2026-08-21'

const app = computed(() => config.public.appName)
const entity = computed(() => config.public.legalEntity)
const support = computed(() => config.public.supportEmail)

useSeo({
  title: 'Terms of Service',
  description: `The terms that govern your use of ${config.public.appName} — billing, cancellation, refunds, and acceptable use.`,
  breadcrumb: [{ name: 'Terms of Service', path: '/terms' }],
})
</script>

<template>
  <article class="mx-auto flex max-w-2xl flex-col gap-8 py-12">
    <UAlert
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="Template — replace before launch"
      description="These terms are an unreviewed starting point. Have a lawyer adapt them to your entity and jurisdiction, then delete this notice."
    />

    <header class="flex flex-col gap-2">
      <h1 class="text-4xl text-highlighted">Terms of Service</h1>
      <p class="text-sm text-muted">Last updated {{ LAST_UPDATED }}</p>
    </header>

    <div class="flex flex-col gap-6 text-default">
      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">1. Who we are</h2>
        <p>
          {{ app }} is operated by {{ entity }} ("we", "us"). By creating an account or using the
          service you agree to these terms. If you don't agree, don't use the service.
        </p>
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">2. Your account</h2>
        <p>
          You sign in through a third-party provider, and your verified email address identifies
          your account. You're responsible for what happens under it, including keeping access to
          that email and that provider account.
        </p>
        <p>
          You must be old enough to enter a contract where you live, and you may not use
          {{ app }} for anything unlawful, or in a way that degrades it for other people.
        </p>
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">3. Payment</h2>
        <p>
          Payments are processed by Paddle.com Market Ltd, which acts as the merchant of record for
          every purchase. Paddle handles billing, tax, and invoicing, and their
          <ULink
            to="https://www.paddle.com/legal/checkout-buyer-terms"
            target="_blank"
            class="text-primary"
          >
            buyer terms
          </ULink>
          apply to the transaction itself.
        </p>
        <p>
          Subscriptions renew automatically at the interval you chose until you cancel. One-time
          passes do not renew; buying another while one is running extends your access from the
          existing expiry rather than replacing it. Prices may change, but never for a period you've
          already paid for — we'll tell you before a renewal at a new price.
        </p>
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">4. Cancellation and refunds</h2>
        <p>
          You can cancel a subscription yourself, at any time, from your account page. Access
          continues until the end of the period you've already paid for; we don't pro-rate a partial
          month.
        </p>
        <p>
          If a payment is refunded, access to what it paid for ends immediately — including partial
          refunds, since what we sell isn't divisible. A chargeback suspends access while it's
          resolved. Statutory rights to withdraw from a purchase, where they apply to you, are
          unaffected by any of this.
        </p>
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">5. Your content</h2>
        <p>
          Anything you put into {{ app }} stays yours. You grant us only the permission needed to
          operate the service — storing it, backing it up, and displaying it back to you. We don't
          sell it, and we don't use it to train models.
        </p>
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">6. Availability</h2>
        <p>
          We work to keep {{ app }} running, but we don't promise uninterrupted service. We may
          change or remove features; if a change materially reduces what you're paying for, you can
          cancel and we'll refund the unused portion of the current period.
        </p>
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">7. Suspension and termination</h2>
        <p>
          We may suspend or close an account that breaks these terms, abuses the service, or is used
          for fraud. Except in cases of abuse or legal obligation, we'll tell you why and refund any
          unused prepaid time. You can stop using {{ app }} whenever you like.
        </p>
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">8. Liability</h2>
        <p>
          {{ app }} is provided as-is. To the extent the law allows, our total liability to you is
          limited to what you paid us in the twelve months before the claim, and we aren't liable
          for indirect or consequential losses. Nothing here limits liability that can't legally be
          limited.
        </p>
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">9. Changes to these terms</h2>
        <p>
          We'll post material changes here and update the date above before they take effect.
          Continuing to use {{ app }} after that means you accept them.
        </p>
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">10. Contact</h2>
        <p>
          Questions about these terms:
          <ULink :to="`mailto:${support}`" class="text-primary">{{ support }}</ULink
          >.
        </p>
      </section>
    </div>
  </article>
</template>
