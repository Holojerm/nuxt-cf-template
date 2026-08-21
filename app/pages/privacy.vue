<script setup lang="ts">
// ── A STARTING POINT, NOT LEGAL ADVICE ───────────────────────────────────────
// Same caveat as /terms. What makes this one worth keeping rather than pasting
// from a generator is that it's accurate about THIS codebase: it names the three
// processors the template actually ships with (Cloudflare, Paddle, PostHog),
// and it describes the data those pieces really collect — the OAuth profile
// fields in server/utils/users.ts, the session cookie, the entitlement rows.
//
// If you remove PostHog or swap Paddle, fix the table below. A privacy policy
// that lists a processor you don't use is as wrong as one that omits one.

definePageMeta({
  publicPage: {
    changefreq: 'yearly',
    priority: '0.3',
    title: 'Privacy Policy',
    summary:
      'What personal data is collected, why, which third-party processors receive it, and how to request access or deletion.',
  },
})

const config = useRuntimeConfig()

const LAST_UPDATED = '2026-08-21'

const app = computed(() => config.public.appName)
const entity = computed(() => config.public.legalEntity)
const support = computed(() => config.public.supportEmail)

const processors = [
  {
    name: 'Cloudflare',
    purpose: 'Hosting, database, file storage, and CDN',
    data: 'Everything the app stores, plus request logs',
  },
  {
    name: 'Paddle',
    purpose: 'Payments, tax, and invoicing as merchant of record',
    data: 'Your email, billing address, and payment details',
  },
  {
    name: 'PostHog',
    purpose: 'Product analytics and error reporting',
    data: 'Pages visited, actions taken, and error traces',
  },
  {
    name: 'Resend',
    purpose: 'Transactional email delivery',
    data: 'Your email address and the message content',
  },
]

useSeo({
  title: 'Privacy Policy',
  description: `What ${config.public.appName} collects, why, which processors it is shared with, and what you can ask us to do about it.`,
  breadcrumb: [{ name: 'Privacy Policy', path: '/privacy' }],
})
</script>

<template>
  <article class="mx-auto flex max-w-2xl flex-col gap-8 py-12">
    <UAlert
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="Template — check it matches what you actually run"
      description="This policy describes the services this template ships with. If you add, remove, or swap a processor, update the table below before launch — then delete this notice."
    />

    <header class="flex flex-col gap-2">
      <h1 class="text-4xl text-highlighted">Privacy Policy</h1>
      <p class="text-sm text-muted">Last updated {{ LAST_UPDATED }}</p>
    </header>

    <div class="flex flex-col gap-6 text-default">
      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">The short version</h2>
        <p>
          {{ entity }} collects the minimum needed to run {{ app }}: who you are, what you've paid
          for, and how the app is being used. We don't sell your data, we don't run ad trackers, and
          you can have the whole account deleted by asking.
        </p>
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">What we collect</h2>
        <p>
          <strong class="text-highlighted">Account data.</strong> When you sign in with GitHub or
          Google, we receive and store your verified email address, display name, and avatar URL. We
          never receive your password for that provider.
        </p>
        <p>
          <strong class="text-highlighted">Billing data.</strong> Paddle holds your payment details;
          we never see a card number. We store a customer reference, which plan you have, its
          status, and when the period ends.
        </p>
        <p>
          <strong class="text-highlighted">Usage data.</strong> Pages visited, features used, and
          errors encountered, tied to your account ID so we can debug a problem you report.
        </p>
        <p><strong class="text-highlighted">Content.</strong> Whatever you create in the app.</p>
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">Why we're allowed to</h2>
        <p>
          We process account and billing data to perform the contract you entered when you signed
          up. We process usage data on the basis of legitimate interest in keeping the product
          working and understanding how it's used — a balance we've weighed against your privacy,
          which is why analytics are pseudonymous and never shared with advertisers.
        </p>
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">Who else touches it</h2>
        <p>
          These are the only third parties involved, and each is bound to use the data solely to
          provide their service to us:
        </p>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-default text-left text-muted">
                <th class="py-2 pr-4 font-medium">Service</th>
                <th class="py-2 pr-4 font-medium">Purpose</th>
                <th class="py-2 font-medium">What they see</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="processor in processors"
                :key="processor.name"
                class="border-b border-default"
              >
                <td class="py-2 pr-4 text-highlighted">{{ processor.name }}</td>
                <td class="py-2 pr-4 text-muted">{{ processor.purpose }}</td>
                <td class="py-2 text-muted">{{ processor.data }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">Cookies</h2>
        <p>
          One cookie holds your sealed, encrypted session — it's what keeps you signed in, and the
          app doesn't work without it. A short-lived cookie also remembers which page you were
          heading to when you signed in. Analytics use first-party storage served from our own
          domain. We don't set advertising or cross-site tracking cookies.
        </p>
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">How long we keep it</h2>
        <p>
          Account and content data lives until you delete your account. Billing records are kept for
          as long as tax law requires — usually seven years — because we don't get to delete those
          on request. Analytics events age out on the provider's retention schedule.
        </p>
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">Your rights</h2>
        <p>
          You can ask for a copy of your data, correction of anything wrong, or deletion of your
          account and its contents. Email
          <ULink :to="`mailto:${support}`" class="text-primary">{{ support }}</ULink>
          and we'll action it within 30 days. If you're in the UK, EU, or a similar jurisdiction,
          you also have the right to complain to your data protection authority.
        </p>
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">Security and breaches</h2>
        <p>
          Data is encrypted in transit and at rest, sessions are sealed cookies, and access to
          production is limited to people who need it. If a breach affects your data, we'll tell you
          and the relevant regulator as the law requires.
        </p>
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="text-2xl text-highlighted">Contact</h2>
        <p>
          {{ entity }} —
          <ULink :to="`mailto:${support}`" class="text-primary">{{ support }}</ULink>
        </p>
      </section>
    </div>
  </article>
</template>
