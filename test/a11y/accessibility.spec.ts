// Automated half of DESIGN.md › Accessibility.
//
// `bun run design:check` catches what a regex can see in source (a missing alt,
// a suppressed outline, an icon-only button under the touch floor). It cannot
// see a rendered page, so it cannot check the thing DESIGN.md is most explicit
// about: contrast ratios, in both color modes. That is what this suite is for.
//
// Every public route is scanned in light and dark, because the two resolve to
// different colors through the token layer — a ratio that passes in one can
// fail in the other, and that failure mode is exactly why numbered Tailwind
// scales are a build error.

import AxeBuilder from '@axe-core/playwright'
import type { Result } from 'axe-core'
import { expect, test } from '@playwright/test'

// Public routes only. /dashboard and /account redirect to /login when signed
// out, so scanning them here would just scan /login a second time; they need a
// session fixture to be worth anything.
//
// /design-system is deliberately excluded: it is a token gallery, so it renders
// `text-dimmed` swatches on their own. Dimmed is the placeholder/disabled token
// and is legitimately below 4.5:1 — scanning that page would report the design
// system documenting itself as a violation.
const ROUTES = ['/', '/pricing', '/login', '/terms', '/privacy']

const COLOR_MODES = ['light', 'dark'] as const

const WCAG_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
  // Not WCAG, but it carries `region` (all content inside a landmark) and
  // `heading-order` — both rules DESIGN.md states as requirements.
  'best-practice',
]

/** axe's raw output is deeply nested; a failed assertion has to be readable in
 *  CI logs without opening the HTML report. Contrast failures additionally carry
 *  the measured ratio and the two colors — without those numbers the message
 *  says a token is wrong but not by how much, which is the difference between a
 *  one-shade fix and a rethink. */
function format(violations: Result[]): string[] {
  return violations.flatMap((v) =>
    v.nodes.map((node) => {
      const where = node.target.join(' ')
      const contrast = node.any.find((check) => check.id === 'color-contrast')?.data as
        | {
            contrastRatio?: number
            expectedContrastRatio?: string
            fgColor?: string
            bgColor?: string
          }
        | undefined

      const detail = contrast?.contrastRatio
        ? ` (${contrast.contrastRatio}:1, needs ${contrast.expectedContrastRatio}; ${contrast.fgColor} on ${contrast.bgColor})`
        : ''

      return `[${v.impact ?? 'unknown'}] ${v.id}: ${v.help}${detail} → ${where}`
    }),
  )
}

for (const route of ROUTES) {
  for (const mode of COLOR_MODES) {
    test(`${route} passes axe in ${mode} mode`, async ({ page }) => {
      // NuxtUI's color mode defaults to `system`, so emulating the media query
      // is enough — no cookie or class juggling.
      await page.emulateMedia({ colorScheme: mode })
      await page.goto(route)

      // Contrast is measured against rendered pixels, so the webfonts have to
      // have landed before axe runs or it can sample a fallback face.
      await page.waitForLoadState('networkidle')
      await page.evaluate(() => document.fonts.ready)

      const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()

      expect(format(violations)).toEqual([])
    })
  }
}

// The keyboard path can only be checked in a real browser — `:focus` needs a
// focused document, which jsdom and a background tab both lack. These two are
// the guarantees DESIGN.md makes that nothing else verifies.
test.describe('keyboard', () => {
  test('the skip link is the first tab stop and moves focus to main', async ({ page }) => {
    await page.goto('/')

    await page.keyboard.press('Tab')
    const skip = page.locator('a[href="#main"]')

    // sr-only until focused: it must become genuinely visible, not just present.
    await expect(skip).toBeFocused()
    await expect(skip).toBeVisible()
    const box = await skip.boundingBox()
    expect(box, 'skip link should have a real box once focused').not.toBeNull()
    expect(box!.height, 'skip link is still visually hidden while focused').toBeGreaterThan(10)

    await page.keyboard.press('Enter')
    await expect(page.locator('#main')).toBeFocused()
  })

  test('every focusable control in the header shows a focus ring', async ({ page }) => {
    await page.goto('/')

    const outlines = await page.evaluate(() => {
      const results: { label: string; outlineWidth: string; boxShadow: string }[] = []
      const controls = document.querySelectorAll<HTMLElement>('header a, header button')
      for (const el of controls) {
        el.focus()
        const cs = getComputedStyle(el)
        results.push({
          label: (el.textContent || '').trim().slice(0, 20) || el.getAttribute('aria-label') || '?',
          outlineWidth: cs.outlineWidth,
          boxShadow: cs.boxShadow,
        })
      }
      return results
    })

    expect(outlines.length).toBeGreaterThan(0)
    for (const control of outlines) {
      const hasRing = control.outlineWidth !== '0px' || control.boxShadow !== 'none'
      expect(hasRing, `no focus indicator on "${control.label}"`).toBe(true)
    }
  })
})
