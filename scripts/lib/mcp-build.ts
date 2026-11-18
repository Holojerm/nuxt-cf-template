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
