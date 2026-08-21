<script setup lang="ts">
// The landing page. Structured the way a SaaS landing page is structured —
// hero, proof, features, pricing pointer, closing CTA — so replacing the words
// gets you a real marketing page instead of a rewrite.
//
// Public and indexable — the `sitemap` page meta below is what puts it in
// sitemap.xml, and it carries the SoftwareApplication node that tells an answer
// engine what this product is and what it costs.

definePageMeta({
  publicPage: {
    changefreq: 'weekly',
    priority: '1.0',
    title: 'Overview',
    summary:
      'What the product is, who it is for, and the capabilities that ship with it — auth, billing, email, analytics, and the edge stack underneath.',
  },
})

const config = useRuntimeConfig()
const { loggedIn } = useUserSession()
const site = useSiteContext()
const plans = usePlans()

const features = [
  {
    icon: 'i-lucide-shield-check',
    title: 'Auth that already works',
    description:
      'GitHub and Google sign-in, sessions in sealed cookies, users provisioned on first login. A dev-only email shortcut so a fresh clone is signed in within seconds.',
  },
  {
    icon: 'i-lucide-credit-card',
    title: 'Billing you can trust',
    description:
      'Paddle as merchant of record. Refunds and chargebacks revoke access, one-time passes stack, redeliveries are idempotent — and all of it is covered by tests.',
  },
  {
    icon: 'i-lucide-gauge',
    title: 'Edge-native by default',
    description:
      'Cloudflare Workers, D1, KV, and R2 bound and auto-imported. No connection pooling, no cold-start theatre, no server to keep alive.',
  },
  {
    icon: 'i-lucide-mail',
    title: 'Transactional email',
    description:
      'Welcome, purchase, payment-failed, and access-ended emails, sent on state transitions rather than on every webhook, so people keep reading them.',
  },
  {
    icon: 'i-lucide-palette',
    title: 'A design system with teeth',
    description:
      'DESIGN.md compiles to the token layer, and CI fails on any code that bypasses it. Your app still looks like your app at feature forty.',
  },
  {
    icon: 'i-lucide-bot',
    title: 'Built for agents',
    description:
      'CLAUDE.md, slash commands, MCP servers, and cloud routines that triage issues and draft support replies while you sleep.',
  },
]

// One source for the product's one-sentence claim — also used by /llms.txt and
// the SoftwareApplication node, so all three agree.
const description = config.public.appDescription

useSeo({
  // 'exact' because the brand should lead on the landing page — everywhere else
  // useSeo appends `· AppName` for you.
  titleMode: 'exact',
  title: `${config.public.appName} — ship the product, not the plumbing`,
  description,
  schema: [
    softwareApplicationSchema(site, {
      description,
      offers: plans.value.map((plan) => ({
        name: plan.name,
        description: plan.description,
        amount: plan.amount,
        currency: plan.currency,
        unit: plan.unit,
        recurring: plan.recurring,
      })),
    }),
  ],
})
</script>

<template>
  <div class="flex flex-col gap-24 py-16">
    <!-- Hero -->
    <section class="mx-auto flex max-w-3xl flex-col items-center gap-6 text-center">
      <UBadge color="neutral" variant="subtle" size="lg">
        Nuxt 4 · Cloudflare Workers · D1 · Paddle
      </UBadge>
      <h1 class="text-4xl text-highlighted sm:text-5xl">Ship the product, not the plumbing</h1>
      <p class="max-w-2xl text-lg text-muted">
        {{ config.public.appName }} starts where most templates stop: a working sign-in, a checkout
        that maps to an account, and a refund that actually takes access away.
      </p>
      <div class="flex flex-wrap items-center justify-center gap-4">
        <UButton :to="loggedIn ? '/dashboard' : '/login'" size="lg">
          {{ loggedIn ? 'Open the app' : 'Get started' }}
        </UButton>
        <UButton to="/pricing" size="lg" color="neutral" variant="outline">See pricing</UButton>
      </div>
      <p class="text-sm text-muted">No credit card to look around.</p>
    </section>

    <!-- Features -->
    <section class="flex flex-col gap-10">
      <div class="mx-auto max-w-2xl text-center">
        <h2 class="text-3xl text-highlighted">What's already done</h2>
        <p class="mt-3 text-muted">The parts every SaaS needs and nobody enjoys building twice.</p>
      </div>

      <div class="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <UCard v-for="feature in features" :key="feature.title">
          <div class="flex flex-col gap-3">
            <UIcon :name="feature.icon" class="size-6 text-primary" />
            <h3 class="text-lg text-highlighted">{{ feature.title }}</h3>
            <p class="text-sm text-muted">{{ feature.description }}</p>
          </div>
        </UCard>
      </div>
    </section>

    <!-- Closing CTA -->
    <section class="mx-auto flex max-w-2xl flex-col items-center gap-6 text-center">
      <h2 class="text-3xl text-highlighted">Start building</h2>
      <p class="text-muted">
        Sign in, pick a plan, and the gated part of the app opens up. That's the whole loop — the
        rest is your product.
      </p>
      <UButton :to="loggedIn ? '/dashboard' : '/login'" size="lg">
        {{ loggedIn ? 'Open the app' : 'Get started' }}
      </UButton>
    </section>
  </div>
</template>
