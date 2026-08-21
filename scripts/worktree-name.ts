// The portless hostname for this checkout.
//
// ── Why the template computes this instead of letting portless infer it ──────
// portless already prepends a worktree prefix, derived from the branch name
// (`portless run` › "In git worktrees, the branch name is prepended"). That
// covers the common case and leaves three holes, because **a branch is not a
// unique key for a worktree**:
//
//   1. A worktree checked out on `main` or `master` gets no prefix at all —
//      portless treats those as default branches — so it collides with the
//      main checkout.
//   2. A detached-HEAD worktree reports its branch as `HEAD`, also skipped.
//      Claude Code creates detached worktrees, so this is the common case here,
//      not an edge case.
//   3. The prefix is only the branch's last path segment, so `feat/magic-link`
//      and `claude/magic-link` both become `magic-link`. Agent branches are
//      generated as `claude/<slug>`, which makes a clash with a human's
//      `feat/<slug>` quite likely.
//
// The worktree *directory* has none of those problems: git refuses to create
// two worktrees at the same path, so the directory name is unique by
// construction, stable across branch switches, and — because Claude Code names
// worktrees after the task — still readable, which is the point of portless.
//
// The main checkout keeps the bare configured name, so `bun dev` there is
// exactly what it was and the `.mcp.json` URL that `bun run rename` maintains
// stays correct.

/**
 * One DNS label: lowercase, digits, interior hyphens, 63 chars max.
 * Anything else is collapsed to a hyphen rather than dropped, so two
 * directories that differ only in punctuation don't sanitize to the same label.
 */
export function sanitizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '')
}

/**
 * The base name to hand portless as `--name`.
 *
 * `worktreeDir` is the basename of a linked worktree's directory, or null in
 * the main checkout. portless may still prepend its own branch prefix on top of
 * this — that only ever adds a label, so the result stays unique either way.
 */
export function devAppName(baseName: string, worktreeDir: string | null): string {
  if (!worktreeDir) return baseName
  const label = sanitizeLabel(worktreeDir)
  // An unsanitizable directory name (all punctuation) would otherwise produce a
  // leading dot and an invalid hostname.
  return label ? `${label}.${baseName}` : baseName
}
