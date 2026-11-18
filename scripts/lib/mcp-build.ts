// The Workers Build the MCP worker should have, as data.
//
// Separate from scripts/mcp-build-setup.ts, which owns the network, so the
// shape sent to Cloudflare can be tested (test/mcp-build.test.ts).
//
// The worker gets a build of its own because one Workers Build can deploy only
// its own Worker (.claude/docs/gotchas.md). It copies the app's repository
// connection and build token, so nothing about GitHub or tokens is typed twice.

/** The fields of a Worker's build configuration this script reads and writes. */
export interface BuildConfig {
  git_repository: Record<string, unknown>
  production_settings: {
    build_command?: string
    deploy_command?: string
    build_token_uuid?: string
    root_directory?: string
    [key: string]: unknown
  }
  /** What a build of any other branch runs. Present even when Previews are off. */
  previews_base_config?: {
    build_command?: string
    deploy_command?: string
    build_token_uuid?: string
    root_directory?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

interface BuildSettings {
  build_command: string
  deploy_command: string
  build_token_uuid: string
  root_directory: string
}

export interface DesiredBuild {
  script_tag: string
  git_repository: Record<string, unknown>
  production_settings: BuildSettings
  previews_enabled: false
  previews_base_config: BuildSettings
}

/** Where the worker lives in the repository, and what its build runs. */
export const MCP_ROOT = 'mcp'
export const MCP_BUILD_COMMAND = 'bun run typecheck'
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
 * No watch paths: the worker rebuilds on every push to the production branch.
 * A worker left behind an app deploy reads a schema that has moved, and a
 * rebuild that changes nothing costs seconds.
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
  }
  return {
    script_tag: input.mcpTag,
    git_repository: input.app.git_repository,
    production_settings: { ...settings, deploy_command: MCP_DEPLOY_COMMAND },
    previews_enabled: false,
    // A pull request still gets the typecheck, as a check on the PR.
    previews_base_config: { ...settings, deploy_command: MCP_BRANCH_DEPLOY_COMMAND },
  }
}

const sameRoot = (a: string | undefined, b: string) => (a ?? '/').replace(/^\/|\/$/g, '') === b

function sameSettings(have: BuildConfig['production_settings'] | undefined, want: BuildSettings) {
  return (
    have?.build_command === want.build_command &&
    have?.deploy_command === want.deploy_command &&
    have?.build_token_uuid === want.build_token_uuid &&
    sameRoot(have?.root_directory, want.root_directory)
  )
}

/** Whether an existing configuration already is the desired one. Cloudflare spells the root `/mcp`. */
export function isCurrent(existing: BuildConfig | null, want: DesiredBuild): boolean {
  if (!existing) return false
  // Compared field by field: Cloudflare adds its own (`grant_id`, timestamps).
  const repository = existing.git_repository ?? {}
  return (
    Object.entries(want.git_repository).every(([key, value]) => repository[key] === value) &&
    existing.previews_enabled === false &&
    sameSettings(existing.production_settings, want.production_settings) &&
    sameSettings(existing.previews_base_config, want.previews_base_config)
  )
}
