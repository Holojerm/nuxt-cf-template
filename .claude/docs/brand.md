# The brand mark

How the logo is drawn once and every icon file is generated from it.

> **Load this when:** redesigning the logo, running `/logo-sync`, or debugging a `bun run brand:check` failure.
> Canonical index: [AGENTS.md](../../AGENTS.md).

---

The logo is drawn **once**, in [`app/components/Brand/Logo.vue`](../../app/components/Brand/Logo.vue),
and every standalone file is cut from it by `bun run brand:generate` — `public/favicon.svg`,
`public/apple-touch-icon.png`, `public/og.png`, and `public/email-logo.png` for email. The header
renders that same `<svg data-brand-mark>` element, so the tab icon cannot fall a redesign behind
the app.

- The geometry must stay **static** and paint with **`currentColor`** — a `.png` can't evaluate
  a Vue binding, and a hex in there fails `design:check`. The generator refuses both.
- Colours for the raster files come from the roles table in [DESIGN.md › Brand mark](../../DESIGN.md),
  which names concrete `--color-*` tokens: a PNG has no color mode, so `--ui-*` aliases (which
  flip) are not valid there.
- The same run writes `emails/theme.generated.css` — the `email-*` roles as hex plus the font
  stacks, because email has no CSS variables. After a rebrand, `bun run email:build` too: the
  committed `server/emails/generated.ts` bakes those colors in, and `bun run email:check` fails
  until it is rebuilt. See [email.md](email.md).
- Never hand-edit anything in `public/` that the pipeline generates. `bun run brand:check`
  (part of `bun run ci`) fails the build when those files stop matching the mark.
- Redesigning it is `/logo-sync`. Editing the component by hand is fine too — just run
  `bun run brand:generate` after and commit what it writes.

