<script setup lang="ts">
// The one email chrome: logo, optional kicker, heading, body, footnote, and the
// link under the card. Everything a template adds is content, so a rebrand is a
// change to DESIGN.md and `bun run brand:generate`, never to a template.
//
// `heading` and `kicker` are props rather than slots so the heading can also be
// the <title> without being written twice. Both may carry Mustache tags; they
// are emitted verbatim and filled in at runtime by renderEmail().
//
// The logo and the footer link sit behind {{#appUrl}}: a logo is an absolute URL
// (clients cannot resolve a relative one), so an app with no origin configured
// gets no logo rather than a broken image.
//
// Write Raw as <Raw :content="x"></Raw>, never self-closed: Maizzle's
// raw-extract pass matches `<Raw ...>` up to the next `</Raw>`, so a
// self-closing one swallows every slot-style <Raw>...</Raw> after it and leaves
// them for Vue to evaluate.
const props = defineProps<{
  heading: string
  /** The <title>, when it should differ from the heading. */
  title?: string
  /** Small caps line above the heading — the ops digest uses it. */
  kicker?: string
  /** Widens the card from 560px to 600px, for emails that carry tables of rows. */
  wide?: boolean
}>()
</script>

<template>
  <Html>
    <Head>
      <title>{{ props.title ?? props.heading }}</title>
    </Head>
    <Tailwind>
      <template #config>
        @import "../theme.generated.css";
      </template>
      <Body class="bg-page font-sans">
        <table role="presentation" class="w-full bg-page">
          <tr>
            <td align="center" class="px-3 py-6">
              <table
                role="presentation"
                :class="[
                  'w-full rounded border border-solid border-rule bg-card',
                  wide ? 'max-w-[600px]' : 'max-w-[560px]',
                ]"
              >
                <tr>
                  <td class="p-8">
                    <Raw>{{#appUrl}}</Raw>
                    <img
                      src="{{appUrl}}/email-logo.png"
                      alt="{{appName}}"
                      width="32"
                      height="32"
                      class="mb-5 block"
                    />
                    <Raw>{{/appUrl}}</Raw>
                    <p v-if="kicker" class="m-0 mb-1 text-xs uppercase tracking-wider text-muted">
                      <Raw :content="kicker"></Raw>
                    </p>
                    <h1 class="m-0 mb-5 text-2xl font-normal leading-tight text-ink">
                      <Raw :content="heading"></Raw>
                    </h1>
                    <slot />
                    <div
                      v-if="$slots.footnote"
                      class="mt-6 border-0 border-t border-solid border-rule pt-6 text-[13px] leading-normal text-muted"
                    >
                      <slot name="footnote" />
                    </div>
                  </td>
                </tr>
              </table>
              <table role="presentation" class="w-full max-w-[560px]">
                <tr>
                  <td class="px-2 py-4 text-xs">
                    <Raw>{{#appUrl}}</Raw>
                    <a href="{{appUrl}}" class="text-muted"><Raw>{{appName}}</Raw></a>
                    <Raw>{{/appUrl}}</Raw>
                    <Raw>{{^appUrl}}</Raw><span class="text-muted"><Raw>{{appName}}</Raw></span><Raw>{{/appUrl}}</Raw>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </Body>
    </Tailwind>
  </Html>
</template>
