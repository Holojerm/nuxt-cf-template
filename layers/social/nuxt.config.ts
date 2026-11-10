// The social layer: an outbox of posts for the app's own social accounts,
// sent through Buffer (https://developers.buffer.com) by the `social:post`
// task. The app decides what to post — it calls enqueueSocialPost() — and when
// the drain runs, by listing `social:post` in SCHEDULED_TASKS. Expects the app
// to provide core's ops spool (server/utils/ops.ts). Auto-registered because it
// lives under layers/.
//
// Every value is a secret or env override, so a fork configures it without
// editing this vendored layer:
//   NUXT_SOCIAL_BUFFER_API_KEY     Buffer → Settings → API → Personal Access
//   NUXT_SOCIAL_CHANNEL_X          Buffer channel id; unset skips the service
//   NUXT_SOCIAL_CHANNEL_BLUESKY
//
// A key and a channel send. To stop posting, delete the key.
export default defineNuxtConfig({
  $meta: { name: 'social' },
  runtimeConfig: {
    social: {
      bufferApiKey: '',
      channelX: '',
      channelBluesky: '',
    },
  },
})
