// The offline page, as one self-contained document. The service worker caches
// it at install and serves it when a navigation fails, so it can load nothing:
// no stylesheet, no script, no font, no image. A Nuxt page would need its
// hashed assets cached alongside it and would hydrate into plugins that fetch.
//
// No Nitro auto-imports, so the test can import it (see server/utils/manifest.ts).

export interface OfflinePageConfig {
  appName: string
  title: string
  body: string
  retry: string
  /** Hex colours. Like the manifest, this page has no colour mode to ask. */
  colors: { ground: string; ink: string; muted: string; mark: string }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => ESCAPES[char]!)

export function buildOfflinePage(config: OfflinePageConfig): string {
  const { colors } = config
  const [appName, title, body, retry] = [
    config.appName,
    config.title,
    config.body,
    config.retry,
  ].map(escapeHtml)

  // The link's empty href is the address the person asked for: the worker
  // answered that navigation with this page, so the address bar still holds it.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · ${appName}</title>
<style>
  html { height: 100%; }
  body {
    min-height: 100%; margin: 0; display: grid; place-items: center;
    background: ${colors.ground}; color: ${colors.ink};
    font: 1rem/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 24rem; padding: 2rem 1.5rem; text-align: center; }
  .app { margin: 0 0 1.5rem; color: ${colors.muted}; font-size: 0.875rem; }
  h1 { margin: 0 0 0.5rem; font-size: 1.5rem; line-height: 1.25; }
  .body { margin: 0 0 1.5rem; }
  a {
    display: inline-block; padding: 0.625rem 1.25rem; border: 1px solid ${colors.ink};
    border-radius: 0.5rem; color: ${colors.ink}; font-weight: 600; text-decoration: none;
  }
  a:focus-visible { outline: 3px solid ${colors.mark}; outline-offset: 2px; }
</style>
</head>
<body>
<main>
<p class="app">${appName}</p>
<h1>${title}</h1>
<p class="body">${body}</p>
<a href="">${retry}</a>
</main>
</body>
</html>
`
}
