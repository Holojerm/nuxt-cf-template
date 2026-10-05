---
schedule: "0 22 * * *"
model: claude-sonnet-5
connectors: [gmail, github]
enabled: false
---

# Daily Digest

## Purpose

The one autonomous outbound action in the system: a single email to the owner, every day,
summarizing what the routines (and the repo) did that day and what needs a human decision.

## Instructions

1. Gather today's activity (UTC day):
   - `journal/YYYY-MM-DD.md` on the `ops-journal` branch — what each routine did.
   - Repo activity: commits to `main`, PRs opened/merged, issues opened/closed today.
   - Open escalations: issues labeled `needs-owner`, plus any `escalations:` journal lines.
2. Compose ONE email to the owner email in `routines.config.md`:
   - Subject: `[<product name>] Daily ops digest — YYYY-MM-DD`. When something needs the owner,
     append ` · N need you` so the inbox line says it before the email is opened.
   - **Needs your attention** first (escalations, PRs awaiting merge, support drafts awaiting
     send — with direct links). If nothing, say "Nothing needs you today."
   - **Done today** — grouped by function (bugs, support, analytics, marketing), one line each
     with links. Routines that didn't run or were skipped: one line at the bottom, not a
     section.
   - Keep the whole email under ~30 lines. Quiet day → short email ("Quiet day: no issues, no
     support mail, CI green."). Always send, so a missing digest itself becomes a signal.
   - No customer PII beyond masked identifiers (`_shared.md` rule 4).
   - **Format** — send HTML in `htmlBody` and the same content as plain text in `body` (spam
     filters and text-only clients read it). Match the ops alert emails
     (`emails/templates/ops-digest.vue`): Gmail strips `<style>` blocks, so inline styles only, one
     centered table, hex colors, no web fonts. Use this skeleton and fill the two
     sections; nothing else goes in:

     ```html
     <body style="margin:0;padding:0;background:#fafaf9;">
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;padding:24px 12px;"><tr><td align="center">
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e7e5e4;border-radius:8px;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
     <tr><td style="font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#78716c;">PRODUCT · Daily ops digest</td></tr>
     <tr><td style="padding:0 0 20px 0;font-size:20px;font-weight:600;color:#1c1917;">ONE-LINE HEADLINE (e.g. "2 things need you" or "Quiet day")</td></tr>
     <!-- Section: border colour #b91c1c for Needs your attention, #15803d for Done today -->
     <tr><td style="padding:0 0 20px 0;"><div style="border-left:3px solid #b91c1c;padding-left:12px;">
       <div style="font-size:15px;font-weight:600;color:#1c1917;padding-bottom:6px;">Needs your attention</div>
       <div style="font-size:14px;line-height:1.5;color:#292524;padding:6px 0;border-top:1px solid #f5f5f4;"><a href="LINK" style="color:#1c1917;font-weight:600;">Item title</a> — one-sentence why and what to do.</div>
     </div></td></tr>
     <tr><td style="padding:16px 0 0 0;border-top:1px solid #e7e5e4;font-size:12px;color:#78716c;">Skipped or didn't run: …  ·  Sent by the daily-digest routine.</td></tr>
     </table></td></tr></table></body>
     ```

     Every item is a link to the issue, PR, run or draft it names; never paste a bare URL.
     Escape `<`, `>` and `&` in anything quoted from issues or mail.
3. Send it via the Gmail connector (`htmlBody` + `body`). This routine is the explicit exception to the no-send rule
   in `_shared.md`, for exactly this one email to exactly this one recipient. If the connector
   is unavailable or the owner email is a placeholder, journal the failure loudly instead.
4. Journal your own run per `_shared.md` (recipient, sections included, or the failure).
