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
  [key: string]: unknown
}

export interface DesiredBuild {
  script_tag: string
  git_repository: Record<string, unknown>
  production_settings: {
    build_command: string
    deploy_command: string
    build_token_uuid: string
    root_directory: string
  }
  previews_enabled: false
}

/** Where the worker lives in the repository, and what its build runs. */
export const MCP_ROOT = 'mcp'
export const MCP_BUILD_COMMAND = 'bun run typecheck'
export const MCP_DEPLOY_COMMAND = 'bun run deploy:ci'

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
  return {
    script_tag: input.mcpTag,
    git_repository: input.app.git_repository,
    production_settings: {
      build_command: MCP_BUILD_COMMAND,
      deploy_command: MCP_DEPLOY_COMMAND,
      build_token_uuid: token,
      root_directory: MCP_ROOT,
    },
    previews_enabled: false,
  }
}

/** Whether an existing configuration already is the desired one. */
export function isCurrent(existing: BuildConfig | null, want: DesiredBuild): boolean {
  if (!existing) return false
  const have = existing.production_settings ?? {}
  const settings = want.production_settings
  return (
    JSON.stringify(existing.git_repository) === JSON.stringify(want.git_repository) &&
    have.build_command === settings.build_command &&
    have.deploy_command === settings.deploy_command &&
    have.build_token_uuid === settings.build_token_uuid &&
    (have.root_directory ?? '/').replace(/^\/|\/$/g, '') === settings.root_directory
  )
}
