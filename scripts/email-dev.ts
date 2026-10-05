// Preview every email in a browser — `bun run email:dev` (Maizzle's dev server).
//
// The compiled templates still hold {{tags}}, so the dev server fills them from
// emails/samples.ts after Maizzle's transformers run. It previews the template
// as you edit it; `bun run email:preview` previews what is actually sent.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { serve } from '@maizzle/framework'
import Mustache from 'mustache'

import config from '../emails/maizzle.config'
import { SAMPLES } from '../emails/samples'

const ROOT = resolve(import.meta.dir, '..')

// The sample origin does not exist; inline the logo so the preview shows it.
const logo = `data:image/png;base64,${readFileSync(join(ROOT, 'public/email-logo.png')).toString('base64')}`

await serve({
  config: {
    ...config,
    root: join(ROOT, 'emails'),
    // Readable markup while editing; the build minifies.
    html: { minify: false },
    afterTransform({ html, template }) {
      const data = SAMPLES[template.path.name]
      if (!data) return html
      return Mustache.render(html, data).replace(/src="[^"]*email-logo\.png"/, `src="${logo}"`)
    },
  },
})
