// Makes the VAPID key pair Web Push needs. Run once per app; changing the keys
// later ends every existing subscription.
//
// The private key is only ever written to a pipe or a file, never to the
// terminal, so it stays out of scrollback and session transcripts:
//
//   bun layers/pwa/scripts/vapid-keys.ts | bunx wrangler secret put NUXT_PWA_VAPID_PRIVATE_KEY
//     The private key goes down the pipe. The public key is printed with the
//     command that stores it.
//
//   bun layers/pwa/scripts/vapid-keys.ts --env >> .env
//     Both, as the two lines local dev reads.

import { generateVapidKeys } from '../server/utils/push-crypto'

const PRIVATE = 'NUXT_PWA_VAPID_PRIVATE_KEY'
const PUBLIC = 'NUXT_PUBLIC_PWA_VAPID_PUBLIC_KEY'

if (process.stdout.isTTY) {
  process.stderr.write(
    `This would print a private key. Pipe it instead:\n\n` +
      `  bun layers/pwa/scripts/vapid-keys.ts | bunx wrangler secret put ${PRIVATE}\n` +
      `  bun layers/pwa/scripts/vapid-keys.ts --env >> .env\n`,
  )
  process.exit(1)
}

const keys = await generateVapidKeys()

if (process.argv.includes('--env')) {
  process.stdout.write(`${PRIVATE}=${keys.privateKey}\n${PUBLIC}=${keys.publicKey}\n`)
  process.stderr.write(`Wrote ${PRIVATE} and ${PUBLIC}.\n`)
} else {
  process.stdout.write(keys.privateKey)
  process.stderr.write(
    `Public key (not a secret), to store next:\n\n` +
      `  printf %s '${keys.publicKey}' | bunx wrangler secret put ${PUBLIC}\n`,
  )
}
