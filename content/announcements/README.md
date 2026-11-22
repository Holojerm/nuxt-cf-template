# Announcements

One markdown file here is one announcement email. Merging the file is what sends it: the daily
task sends each announcement once, to everyone who allows product mail, inside the weekly cap.
The filename is its id (`exports-2026-11.md` → `exports-2026-11`): lowercase letters, digits and
hyphens, 27 characters at most. Never rename one that has been sent.

```
---
subject: Exports are here
date: 2026-11-25
audience: everyone
button_label: See what changed
button_path: /changelog
---

Plain paragraphs, separated by blank lines. No markdown, no {{tags}}.
```

`subject` and `date` are required. `date` is the first day the send may start; a file found more
than 14 days after it is never sent. `audience` is `everyone` (the default), `users`, `activated`
or `subscribers`. The button is optional.

`bun run email:build` checks every file here and fails on a mistake or on urgency wording. The
rules and the send itself are described in `.claude/docs/email.md` › Announcements.
