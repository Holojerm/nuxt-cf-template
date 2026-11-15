// The Turnstile widget on the layer's public forms. A token is good for one
// request, so every submit ends by resetting the widget.
export function useCredentialsChallenge() {
  const required = Boolean(useRuntimeConfig().public.turnstile.siteKey)
  const token = ref('')
  const widget = ref<{ reset: () => void } | null>(null)

  function reset() {
    token.value = ''
    widget.value?.reset()
  }

  /** True while the form must wait for the challenge. */
  const blocked = computed(() => required && !token.value)

  return { required, token, widget, blocked, reset }
}
