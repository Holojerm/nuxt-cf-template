// Start, ramp and end a growth experiment's PostHog flag from the command line — what the
// growth routines use instead of the PostHog dashboard (agent-operators-plan.md, row 3).
//
//   bun run scripts/flags.ts list                      # growth-* flags only
//   bun run scripts/flags.ts create growth-<name>      # active at 0% rollout
//   bun run scripts/flags.ts rollout growth-<name> 10  # whole percent, 0 to 100
//   bun run scripts/flags.ts retire growth-<name>      # rollout 0, then disable + archive
//
// Output is JSON on stdout (one object, or an array for `list`); errors are one line on
// stderr with exit 1. Read the flag in the app with `useFlag('growth-<name>')`.
//
// Credentials come only from the environment, and are never printed:
//   POSTHOG_PERSONAL_API_KEY   a personal API key scoped to feature_flag:read + feature_flag:write
//   POSTHOG_PROJECT_ID         numeric project id (the product's own PostHog project)
//   NUXT_PUBLIC_POSTHOG_HOST   the host the app already uses (default https://us.i.posthog.com);
//                              the ingestion host is mapped to the app host that serves the API
//
// Every write refuses a key that does not start with `growth-`. There is deliberately no verb
// for targeting, variants or hard delete: a routine cannot misuse a capability this script does
// not have. Logic and its tests: scripts/lib/flags.ts, test/flags.test.ts.

import {
  FlagError,
  assertGrowthKey,
  createFlag,
  depsFromEnv,
  listFlags,
  retireFlag,
  setRollout,
} from './lib/flags'

const USAGE = 'usage: list | create <key> | rollout <key> <percent> | retire <key>'

function fail(message: string): never {
  console.error(`flags: ${message}`)
  process.exit(1)
}

async function main(argv: string[]): Promise<unknown> {
  const [command, key, percent] = argv
  // Refuse a bad key before reading credentials, so the guard needs no network or env.
  if (command === 'create' || command === 'rollout' || command === 'retire') assertGrowthKey(key)
  const deps = () => depsFromEnv(process.env)
  switch (command) {
    case 'list':
      return listFlags(deps())
    case 'create':
      return createFlag(deps(), key!)
    case 'rollout':
      if (percent === undefined) throw new FlagError(USAGE)
      return setRollout(deps(), key!, Number(percent === '' ? NaN : percent))
    case 'retire':
      return retireFlag(deps(), key!)
    default:
      throw new FlagError(USAGE)
  }
}

try {
  console.info(JSON.stringify(await main(process.argv.slice(2)), null, 2))
} catch (error) {
  fail(error instanceof FlagError ? error.message : `unexpected error: ${(error as Error).message}`)
}
