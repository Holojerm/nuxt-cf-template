// The Workers Build the MCP worker should have, as data.
//
// Separate from scripts/mcp-build-setup.ts, which owns the network, so the
// shape sent to Cloudflare can be tested (test/mcp-build.test.ts).
//
// The worker gets a build of its own because one Workers Build can deploy only
// its own Worker (.claude/docs/gotchas.md). It copies the app's repository
// connection and build token, so nothing about GitHub or tokens is typed twice.

/** The fields of a set of build settings this script reads back. */
interface StoredSettings {
  build_command?: string
  deploy_command?: string
  build_token_uuid?: string
  root_directory?: string
  [key: string]: unknown
}

/** A Worker's build configuration, as Cloudflare returns it. */
export interface BuildConfig {
  git_repository: Record<string, unknown>
  production_settings: StoredSettings
  previews_enabled?: boolean
  /** What a build of any other branch runs. Present even when Previews are off. */
  previews_base_config?: StoredSettings
  [key: string]: unknown
}

/**
 * One set of build settings, complete. Cloudflare refuses a partial set the
 * first time a section is written ("all settings must be provided").
 */
export interface BuildSettings {
  build_command: string
  deploy_command: string
  build_token_uuid: string
  root_directory: string
  build_caching_enabled: true
  path_includes: string[]
  path_excludes: string[]
  environment_variables: Record<string, never>
}

export interface DesiredBuild {
  script_tag: string
  git_repository: Record<string, unknown>
  production_settings: BuildSettings
  previews_enabled: false
  previews_base_config: BuildSettings
}

/** Where the worker lives in the repository. */
export const MCP_ROOT = 'mcp'
// Both commands are scripts in mcp/package.json, so what the build does is in
// the repository and a fork changes it there, not in a dashboard.
export const MCP_BUILD_COMMAND = 'bun run build:ci'
export const MCP_DEPLOY_COMMAND = 'bun run deploy:ci'
/**
 * What a build of a non-production branch "deploys": nothing. Left unset,
 * Cloudflare uploads a preview version of the worker from every pull request,
 * bound to the production database and the production OAuth store.
 */
export const MCP_BRANCH_DEPLOY_COMMAND =
  'echo "Preview uploads disabled: a branch build would run with production bindings"'

/**
 * The build configuration for the MCP worker, taken from the app's.
 *
 * It watches every path: the worker rebuilds on every push to the production
 * branch. A worker left behind an app deploy reads a schema that has moved,
 * and a rebuild that changes nothing costs seconds.
 */
export function desiredBuild(input: { mcpTag: string; app: BuildConfig }): DesiredBuild {
  const token = input.app.production_settings?.build_token_uuid
  if (!input.app.git_repository || !token) {
    throw new Error(
      'the app Worker has no Workers Build to copy: connect it to the repository first',
    )
  }
  const settings = {
    build_command: MCP_BUILD_COMMAND,
    build_token_uuid: token,
    root_directory: MCP_ROOT,
    build_caching_enabled: true as const,
    path_includes: ['*'],
    path_excludes: [],
    // Cloudflare merges this map into what is stored, so an empty one leaves
    // alone any build variable a fork set by hand.
    environment_variables: {},
  }
  return {
    script_tag: input.mcpTag,
    git_repository: input.app.git_repository,
    production_settings: { ...settings, deploy_command: MCP_DEPLOY_COMMAND },
    previews_enabled: false,
    // A pull request still gets the build command, as a check on the PR.
    previews_base_config: { ...settings, deploy_command: MCP_BRANCH_DEPLOY_COMMAND },
  }
}

/** Cloudflare returns the root as `/mcp`. */
const sameRoot = (have: string | undefined, want: string) =>
  (have ?? '/').replace(/^\/|\/$/g, '') === want

function sameSettings(have: StoredSettings | undefined, want: BuildSettings): boolean {
  return (
    have?.build_command === want.build_command &&
    have?.deploy_command === want.deploy_command &&
    have?.build_token_uuid === want.build_token_uuid &&
    sameRoot(have?.root_directory, want.root_directory)
  )
}

/** Whether an existing configuration already is the desired one. */
export function isCurrent(existing: BuildConfig | null, want: DesiredBuild): boolean {
  if (!existing) return false
  // Compared field by field: Cloudflare adds fields of its own to what it returns.
  const repository = existing.git_repository ?? {}
  return (
    Object.entries(want.git_repository).every(([key, value]) => repository[key] === value) &&
    existing.previews_enabled === false &&
    sameSettings(existing.production_settings, want.production_settings) &&
    sameSettings(existing.previews_base_config, want.previews_base_config)
  )
}

// ── Triggers ────────────────────────────────────────────────────────────────
// A Worker's build configuration exists once it has a trigger: the API has no
// call that creates one (`POST /builds/workers` is refused with 12002), and
// `GET /builds/workers/<tag>` reads its production settings from the trigger
// on the production branch. So the worker gets two triggers, the way the app
// has them: one that deploys the production branch, and one that runs the
// build command on every other branch and uploads nothing (with previews off,
// nothing else builds a pull request).

/** A build trigger, as Cloudflare returns it. */
export interface Trigger {
  trigger_uuid: string
  trigger_name: string
  build_command?: string
  deploy_command?: string
  root_directory?: string
  build_token_uuid?: string
  branch_includes?: string[]
  branch_excludes?: string[]
  repo_connection?: { repo_connection_uuid?: string }
  [key: string]: unknown
}

export interface DesiredTrigger {
  external_script_id: string
  repo_connection_uuid: string
  build_token_uuid: string
  trigger_name: string
  build_command: string
  deploy_command: string
  root_directory: string
  branch_includes: string[]
  branch_excludes: string[]
  path_includes: string[]
  path_excludes: string[]
  build_caching_enabled?: true
}

export const MCP_BRANCH_TRIGGER = 'Check non-production branches (no upload)'

const watchesEveryBranch = (trigger: Trigger) => (trigger.branch_includes ?? []).includes('*')

const productionBranch = (build: DesiredBuild) => String(build.git_repository.branch ?? 'main')

/** The app's repository connection, which both of the worker's triggers reuse. */
function appConnection(appTriggers: Trigger[]): string {
  const connection = appTriggers.find((trigger) => trigger.repo_connection?.repo_connection_uuid)
    ?.repo_connection?.repo_connection_uuid
  if (!connection) throw new Error('the app Worker has no build trigger to copy a repository from')
  return connection
}

/**
 * The worker's trigger for the production branch. Named the way Cloudflare
 * names the app's (`<worker>-main`).
 */
export function desiredProductionTrigger(input: {
  mcpName: string
  mcpTag: string
  build: DesiredBuild
  appTriggers: Trigger[]
}): DesiredTrigger {
  const production = productionBranch(input.build)
  const settings = input.build.production_settings
  return {
    external_script_id: input.mcpTag,
    repo_connection_uuid: appConnection(input.appTriggers),
    build_token_uuid: settings.build_token_uuid,
    trigger_name: `${input.mcpName}-${production}`,
    build_command: settings.build_command,
    deploy_command: settings.deploy_command,
    root_directory: settings.root_directory,
    branch_includes: [production],
    branch_excludes: [],
    path_includes: settings.path_includes,
    path_excludes: settings.path_excludes,
    build_caching_enabled: true,
  }
}

/**
 * The worker's trigger for every branch but production, from the app's.
 *
 * It skips the branches the app's own branch trigger skips (a fork may keep a
 * branch that is never built), and always the production branch.
 */
export function desiredBranchTrigger(input: {
  mcpTag: string
  build: DesiredBuild
  appTriggers: Trigger[]
}): DesiredTrigger {
  const connection = appConnection(input.appTriggers)
  const production = productionBranch(input.build)
  const skipped = input.appTriggers.find(watchesEveryBranch)?.branch_excludes ?? []
  const branch = input.build.previews_base_config
  return {
    external_script_id: input.mcpTag,
    repo_connection_uuid: connection,
    build_token_uuid: branch.build_token_uuid,
    trigger_name: MCP_BRANCH_TRIGGER,
    build_command: branch.build_command,
    deploy_command: branch.deploy_command,
    root_directory: branch.root_directory,
    branch_includes: ['*'],
    branch_excludes: [...new Set([production, ...skipped])],
    path_includes: ['*'],
    path_excludes: [],
  }
}

const sameList = (have: string[] | undefined, want: string[]) =>
  [...(have ?? [])].sort().join('\n') === [...want].sort().join('\n')

/**
 * The worker's existing trigger for what `want` builds, and whether it already
 * is the desired one. Found by name, else by the same branches: a production
 * trigger made by hand or in the dashboard is updated, not doubled.
 */
export function triggerState(
  existing: Trigger[],
  want: DesiredTrigger,
): { current: boolean; uuid?: string } {
  const have =
    existing.find((trigger) => trigger.trigger_name === want.trigger_name) ??
    existing.find((trigger) => sameList(trigger.branch_includes, want.branch_includes))
  if (!have) return { current: false }
  const current =
    have.build_command === want.build_command &&
    have.deploy_command === want.deploy_command &&
    have.build_token_uuid === want.build_token_uuid &&
    sameRoot(have.root_directory, want.root_directory) &&
    sameList(have.branch_includes, want.branch_includes) &&
    sameList(have.branch_excludes, want.branch_excludes)
  return { current, uuid: have.trigger_uuid }
}
