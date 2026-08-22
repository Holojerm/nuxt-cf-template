// Date display, for the two places this app shows a calendar date to a reader:
// the changelog and the blog.
//
// One formatter rather than one per feature, because the interesting part is
// not the format — it is the `T00:00:00Z` and the `timeZone: 'UTC'`. Both
// sources store a bare `YYYY-MM-DD`, and `new Date('2026-06-18')` is parsed as
// UTC midnight while `toLocaleDateString` then renders it in the *reader's*
// zone. West of Greenwich that shows the previous day. Getting it right twice
// by accident is not a plan.

/** `2026-06-18` → `18 June 2026`. Returns the input unchanged if unparseable. */
export function formatLongDate(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
