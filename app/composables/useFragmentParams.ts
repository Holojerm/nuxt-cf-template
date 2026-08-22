// Read parameters out of the URL fragment, correctly, in one place.
//
// ── Why anything reads the fragment at all ───────────────────────────────────
// Two flows here hand someone a credential in a link — the sign-in link and the
// unsubscribe link — and a fragment is the one part of a URL the browser never
// transmits. It reaches no access log, no `Referer`, and no reverse proxy. That
// is the whole reason /auth/verify and /unsubscribe are addressed with `#` and
// not `?`; see app/utils/analytics-privacy.ts for the layers behind it.
//
// ── The three things that are easy to get wrong ──────────────────────────────
// Both pages got all three wrong before this existed, in the same ways:
//
//   1. The fragment does not exist during SSR. Reading it in `setup()` returns
//      nothing on the server and something on the client, which is a hydration
//      mismatch at best and a page that renders its own error state at worst.
//      So the read happens in `onMounted`, and `resolved` says whether it has.
//   2. A hash-only navigation does NOT remount the component. Open a second
//      link in the same tab and the page keeps acting on the first link's
//      parameters unless something watches `route.hash`.
//   3. Before the first read there is nothing true to render. A page that
//      treats "no parameters yet" as "bad link" flashes a failure at every
//      valid link on the way in.

export interface FragmentParams {
  /** The parsed fragment, or null before the first read and when it is empty. */
  params: Readonly<Ref<URLSearchParams | null>>
  /** False until the browser has had a chance to read the URL. False through SSR. */
  resolved: Readonly<Ref<boolean>>
}

/**
 * Parse `#a=b&c=d` reactively.
 *
 * `onChange` fires after every read — mount and each subsequent hash change —
 * so a caller can kick off whatever the parameters imply without duplicating
 * the mount/watch pair. It is called with the freshly parsed params.
 */
export function useFragmentParams(onChange?: (params: URLSearchParams) => void): FragmentParams {
  const route = useRoute()
  const params = ref<URLSearchParams | null>(null)
  const resolved = ref(false)

  function read() {
    const parsed = new URLSearchParams(route.hash.replace(/^#/, ''))
    // An empty fragment and no fragment are the same thing to every caller.
    params.value = [...parsed.keys()].length > 0 ? parsed : null
    resolved.value = true
    if (params.value) onChange?.(params.value)
  }

  onMounted(read)
  watch(() => route.hash, read)

  return { params, resolved }
}
