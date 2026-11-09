// Draws one 1200x630 card with satori (layout -> SVG) and resvg (SVG -> PNG).
// Both are devDependencies and run in the build, never in the Worker.
// Fonts are read from @fontsource packages in node_modules, so a build needs no
// network. satori reads woff/ttf/otf, not woff2, which is what @fontsource ships
// alongside.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Resvg } from '@resvg/resvg-js'
import satori from 'satori'

import { BRAND_OG_COLORS } from '../../shared/utils/brand-colors.generated'
import { collectBrandInputs, ROOT } from '../brand-inputs'
import { clip, titleSize, type OgCard } from './og-source'

const WIDTH = 1200
const HEIGHT = 630

type Font = { name: string; data: Buffer; weight: 400; style: 'normal' }
type Node = { type: string; props: Record<string, unknown> }

const h = (type: string, style: Record<string, unknown>, children?: unknown, extra = {}): Node => ({
  type,
  props: { style, children, ...extra },
})

function loadFont(family: string): Font {
  const pkg = family.toLowerCase().replace(/\s+/g, '-')
  const file = join(ROOT, 'node_modules/@fontsource', pkg, 'files', `${pkg}-latin-400-normal.woff`)
  if (!existsSync(file)) {
    throw new Error(
      `og-images: no local font for "${family}". Add it as a devDependency: bun add -d @fontsource/${pkg}`,
    )
  }
  return { name: family, data: readFileSync(file), weight: 400, style: 'normal' }
}

export interface OgRenderer {
  render(card: OgCard): Promise<Uint8Array>
}

export function createOgRenderer(): OgRenderer {
  const inputs = collectBrandInputs()
  const colors = BRAND_OG_COLORS
  const fonts = [...new Set([inputs.fonts.display, inputs.fonts.sans, inputs.fonts.mono])].map(
    loadFont,
  )
  const markUri = `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${inputs.mark.viewBox}" fill="${colors.mark}">${inputs.mark.inner}</svg>`,
  ).toString('base64')}`

  const tree = (card: OgCard): Node => {
    const size = titleSize(card.title)
    return h(
      'div',
      {
        width: WIDTH,
        height: HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: colors.ground,
        padding: 72,
        boxSizing: 'border-box',
      },
      [
        h('div', { display: 'flex', alignItems: 'center' }, [
          h('img', { width: 56, height: 56 }, undefined, { src: markUri, width: 56, height: 56 }),
          h(
            'div',
            {
              marginLeft: 20,
              fontFamily: inputs.fonts.sans,
              fontSize: 32,
              color: colors.muted,
            },
            inputs.appName,
          ),
        ]),
        h('div', { display: 'flex', flexDirection: 'column' }, [
          h(
            'div',
            {
              fontFamily: inputs.fonts.display,
              fontSize: size,
              lineHeight: 1.08,
              letterSpacing: '-0.02em',
              color: colors.ink,
              lineClamp: 3,
            },
            card.title,
          ),
          card.summary
            ? h(
                'div',
                {
                  marginTop: 28,
                  fontFamily: inputs.fonts.sans,
                  fontSize: 32,
                  lineHeight: 1.45,
                  color: colors.muted,
                  maxWidth: 960,
                  lineClamp: 2,
                },
                clip(card.summary, 125),
              )
            : null,
        ]),
        h(
          'div',
          {
            display: 'flex',
            fontFamily: inputs.fonts.mono,
            fontSize: 26,
            color: colors.muted,
            borderTop: `1px solid ${colors.muted}55`,
            paddingTop: 28,
          },
          card.host ?? (inputs.appHost || inputs.appName),
        ),
      ],
    )
  }

  return {
    async render(card) {
      const svg = await satori(tree(card) as never, { width: WIDTH, height: HEIGHT, fonts })
      return new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng()
    },
  }
}
