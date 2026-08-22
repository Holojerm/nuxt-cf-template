// The account-deletion confirmation email.
//
// Kept in its own file rather than added to server/utils/email-templates.ts:
// that file is being edited by another wave this same cycle, and two agents
// changing one file is how a merge quietly drops somebody's work. This mirrors
// its house style — inline styles, hex colors, a plain-text alternative, no
// CSS variables — rather than importing it, because the `layout()` helper
// there is module-private and this is the one email in the app sent about an
// account that, by the time anyone reads this file's output, is anonymized.

// Not exported: server/utils/email-templates.ts already exports a type of
// this exact name, and Nitro's auto-import registers exported names globally
// — two same-named exports from server/utils/*.ts collide there even though
// each file's own imports are perfectly fine to TypeScript. This file is the
// only caller of its own return shape, so nothing needs it to be public.
interface EmailContent {
  subject: string
  html: string
  text: string
}

interface Branding {
  appName: string
  appUrl: string
}

/** Escape for interpolation into HTML — names come from OAuth providers. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Sent by the caller (DELETE /api/account) BEFORE the `users` row is
 * anonymized — it's the last message that can reach the real address, because
 * server/utils/account.ts rewrites it to a synthetic tombstone the moment
 * deletion succeeds. Confirms exactly what /privacy promises: the account and
 * its contents are gone, and billing records are the one thing kept, for tax
 * law.
 */
export function accountDeletedEmail(brand: Branding, opts: { name: string }): EmailContent {
  const heading = 'Your account has been deleted'
  const paragraphs = [
    `Hi ${opts.name} — this confirms your ${brand.appName} account and everything in it has been deleted, as you asked.`,
    `Billing records are kept for as long as tax law requires — that's the only thing this doesn't touch, and it's described in our privacy policy.`,
    `If you didn't request this, reply to this email right away.`,
  ]

  const paragraphHtml = paragraphs
    .map(
      (p) =>
        `<tr><td style="padding:0 0 16px 0;font-size:16px;line-height:1.65;color:#292524;">${escapeHtml(p)}</td></tr>`,
    )
    .join('')

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#fafaf9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;padding:32px 16px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e7e5e4;border-radius:4px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <tr><td style="padding:0 0 8px 0;font-size:13px;letter-spacing:0.04em;text-transform:uppercase;color:#78716c;">${escapeHtml(brand.appName)}</td></tr>
    <tr><td style="padding:0 0 20px 0;font-size:24px;line-height:1.3;color:#1c1917;">${escapeHtml(heading)}</td></tr>
    ${paragraphHtml}
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;padding:16px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <tr><td style="font-size:12px;color:#a8a29e;"><a href="${brand.appUrl}" style="color:#a8a29e;">${escapeHtml(brand.appName)}</a></td></tr>
  </table>
</td></tr></table>
</body></html>`

  const text = [heading, '', ...paragraphs, '', brand.appUrl].join('\n')

  return { subject: `Your ${brand.appName} account has been deleted`, html, text }
}
