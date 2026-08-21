// Per-checkout dev-server port for the Playwright suites.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Agents work in parallel git worktrees under `.claude/worktrees/<name>`, and
// each one runs `bun run test:a11y`. That suite starts its own dev server with
// `reuseExistingServer: false` (playwright.config.ts explains why it must), so
// on a fixed port the second worktree does not quietly share the first one's
// server — it fails to boot. That is the correct behaviour and a fatal one the
// moment two agents work at once, which is the whole point of worktrees.
//
// Hashing the checkout path gives every worktree its own port with no
// coordination, no lockfile, and no scan for a free socket — a scan races
// between finding the port and binding it, and the loser fails 300 seconds
// later with a timeout that looks like a broken app.
//
// Deterministic on purpose: the same checkout gets the same port on every run,
// so a failure is reproducible and you can open the URL by hand while a run is
// in flight. `A11Y_PORT` overrides it when you need a known value.

/**
 * FNV-1a, 32-bit. Small and dependency-free, but the reason it's hand-rolled
 * rather than `node:crypto` is portability: this module is imported by both the
 * Playwright config (Bun) and a Vitest spec (workerd), and the value it returns
 * becomes a port number — it must not vary between runtimes.
 */
function hash(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    // Math.imul keeps the multiply in 32-bit space; a plain `*` overflows into
    // float territory and silently stops being FNV after a few characters.
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Ports 3100–3899. Deliberately clear of 3000, which `bun run dev:app` uses —
 * a developer running the app by hand must not collide with a suite run, and
 * before this the two shared a port and did.
 */
export const PORT_BASE = 3100
export const PORT_RANGE = 800

/** The port a checkout at `checkoutPath` gets. Pure — same input, same port. */
export function derivePort(checkoutPath: string): number {
  return PORT_BASE + (hash(checkoutPath) % PORT_RANGE)
}

/**
 * The port this checkout's Playwright suites should use.
 *
 * `A11Y_PORT` wins when set to a positive integer, for pinning a value while
 * debugging or for a CI runner that publishes a fixed port. Otherwise the port
 * is derived from the working directory, which is the checkout root when
 * Playwright loads its config.
 */
export function playwrightPort(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): number {
  const override = Number(env.A11Y_PORT)
  if (Number.isInteger(override) && override > 0 && override < 65536) return override
  return derivePort(cwd)
}
