// Pure helpers shared by the account-export route (server/api/account/export.get.ts,
// which sets the download's Content-Disposition header) and the /account page
// (app/pages/account.vue, which names the file it hands the browser) — both
// need the same filename, or a downloaded file's name would silently disagree
// with what the server told the browser to call it.

/** `<slugified-app-name>-export.json` — the self-serve data export's filename. */
export function exportFilename(appName: string): string {
  const slug = appName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'account'}-export.json`
}
