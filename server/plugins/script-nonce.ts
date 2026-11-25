// Every rendered page gets its own script nonce and a policy naming it, in place of
// 'unsafe-inline' (shared/script-nonce.ts says why).

import { newNonce, nonceFrameworkScripts, noncedPolicy } from '~~/shared/script-nonce'
import { contentSecurityPolicy } from '~~/shared/security-headers'

export default defineNitroPlugin((nitroApp) => {
  const policy = contentSecurityPolicy(import.meta.dev)
  nitroApp.hooks.hook('render:html', (html, { event }) => {
    const nonce = newNonce()
    nonceFrameworkScripts(html, nonce)
    setResponseHeader(event, 'Content-Security-Policy', noncedPolicy(policy, nonce))
  })
})
