// The rule behind `bun run deploy:secrets`: parse wrangler's secret listing and
// name what fleet.json requires that the Worker lacks. Pure strings.

import { describe, expect, it } from 'vitest'

import { missingSecrets, parseSecretList } from '../scripts/lib/deploy-secrets'

describe('parseSecretList', () => {
  it('reads names from the JSON wrangler prints, around its warnings', () => {
    const stdout = [
      '▲ [WARNING] Proxy environment variables detected.',
      '[',
      '  { "name": "NUXT_APP_SECRET", "type": "secret_text" },',
      '  { "name": "NUXT_SESSION_PASSWORD", "type": "secret_text" }',
      ']',
      '',
    ].join('\n')
    expect(parseSecretList(stdout)).toEqual(['NUXT_APP_SECRET', 'NUXT_SESSION_PASSWORD'])
  })

  it('is not fooled by the brackets in a coloured warning or a trailing note', () => {
    const stdout = [
      '\u001b[33m▲ \u001b[43;33m[\u001b[43;30mWARNING\u001b[43;33m]\u001b[0m Proxy detected.',
      '[{ "name": "NUXT_APP_SECRET", "type": "secret_text" }]',
    ].join('\n')
    expect(parseSecretList(stdout)).toEqual(['NUXT_APP_SECRET'])
  })

  it('reads an empty listing as no secrets, not as a failure', () => {
    expect(parseSecretList('[]')).toEqual([])
  })

  it('refuses output it cannot trust', () => {
    expect(parseSecretList('')).toBeNull()
    expect(parseSecretList('✘ [ERROR] This Worker does not exist on your account.')).toBeNull()
    expect(parseSecretList('[{ "type": "secret_text" }]')).toBeNull()
    expect(parseSecretList('[ not json ]')).toBeNull()
  })
})

describe('missingSecrets', () => {
  it('names what is required and absent, in the manifest order', () => {
    expect(
      missingSecrets(['NUXT_APP_SECRET', 'NUXT_SESSION_PASSWORD'], ['NUXT_SESSION_PASSWORD']),
    ).toEqual(['NUXT_APP_SECRET'])
  })

  it('ignores extra secrets the Worker has', () => {
    expect(missingSecrets(['NUXT_APP_SECRET'], ['NUXT_APP_SECRET', 'NUXT_RESEND_API_KEY'])).toEqual(
      [],
    )
  })
})
