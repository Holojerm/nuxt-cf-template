// The Workers Build the MCP worker is given, as the data sent to Cloudflare.
// scripts/mcp-build-setup.ts owns the network; this holds the shape.

import { describe, expect, it } from 'vitest'

import mcpPackage from '../mcp/package.json'
import {
  MCP_BRANCH_DEPLOY_COMMAND,
  MCP_BRANCH_TRIGGER,
  MCP_BUILD_COMMAND,
  MCP_DEPLOY_COMMAND,
  MCP_ROOT,
  desiredBranchTrigger,
  desiredBuild,
  desiredProductionTrigger,
  isCurrent,
  triggerState,
  type BuildConfig,
  type Trigger,
} from '../scripts/lib/mcp-build'

const REPO = { provider_type: 'github', repo_id: '42', repo_name: 'my-app', branch: 'main' }
const APP: BuildConfig = {
  git_repository: REPO,
  production_settings: {
    build_command: 'bun run typecheck && bun run build',
    deploy_command: 'bun run deploy:ci',
    build_token_uuid: 'token-1',
    root_directory: '/',
  },
}

describe('the MCP worker’s own Workers Build', () => {
  it('copies the app’s repository and token, and builds from mcp/', () => {
    // Complete on both halves: Cloudflare refuses a partial set of settings.
    const shared = {
      build_command: MCP_BUILD_COMMAND,
      build_token_uuid: 'token-1',
      root_directory: MCP_ROOT,
      build_caching_enabled: true,
      path_includes: ['*'],
      path_excludes: [],
      environment_variables: {},
    }
    expect(desiredBuild({ mcpTag: 'tag-mcp', app: APP })).toEqual({
      script_tag: 'tag-mcp',
      git_repository: REPO,
      production_settings: { ...shared, deploy_command: MCP_DEPLOY_COMMAND },
      previews_enabled: false,
      previews_base_config: { ...shared, deploy_command: MCP_BRANCH_DEPLOY_COMMAND },
    })
  })

  it('never uploads from a branch build', () => {
    // A pull request's build would otherwise publish a preview of the worker
    // bound to the production database.
    const { previews_base_config: branch, previews_enabled } = desiredBuild({
      mcpTag: 'tag-mcp',
      app: APP,
    })
    expect(previews_enabled).toBe(false)
    expect(branch.deploy_command).toMatch(/^echo /)
    expect(branch.deploy_command).not.toMatch(/wrangler|deploy:ci/)
  })

  it('runs commands the worker’s package actually has', () => {
    const scripts = mcpPackage.scripts as Record<string, string>
    for (const command of [MCP_BUILD_COMMAND, MCP_DEPLOY_COMMAND]) {
      expect(scripts[command.replace('bun run ', '')], command).toBeTruthy()
    }
    // The deploy guards the Worker's name and waits for the schema before it uploads.
    expect(scripts['deploy:ci']).toMatch(/guard-deploy.*wait-for-migrations.*wrangler deploy/)
  })

  it('refuses when the app has no build to copy', () => {
    const unconnected = { git_repository: REPO, production_settings: {} } as BuildConfig
    expect(() => desiredBuild({ mcpTag: 'tag-mcp', app: unconnected })).toThrow(/connect it/)
  })

  it('knows when nothing needs changing, however Cloudflare spells it back', () => {
    const want = desiredBuild({ mcpTag: 'tag-mcp', app: APP })
    // What a GET returns: extra fields, and the root as `/mcp`.
    const stored: BuildConfig = {
      git_repository: { ...REPO, grant_id: null },
      production_settings: { ...want.production_settings, root_directory: '/mcp' },
      auto_build_enabled: true,
      previews_enabled: false,
      previews_base_config: { ...want.previews_base_config, root_directory: '/mcp' },
    }
    expect(isCurrent(stored, want)).toBe(true)
    expect(isCurrent(null, want)).toBe(false)
    expect(
      isCurrent(
        { ...stored, production_settings: { ...stored.production_settings, deploy_command: 'x' } },
        want,
      ),
    ).toBe(false)
    // What a create call leaves behind: no branch settings at all.
    expect(isCurrent({ ...stored, previews_base_config: undefined }, want)).toBe(false)
    // A branch build that uploads is drift, and the one worth catching.
    expect(
      isCurrent(
        {
          ...stored,
          previews_base_config: {
            ...stored.previews_base_config,
            deploy_command: 'bun run deploy',
          },
        },
        want,
      ),
    ).toBe(false)
    expect(isCurrent({ ...stored, previews_enabled: true }, want)).toBe(false)
  })

  // With previews off nothing builds a pull request, so the worker has a
  // trigger of its own for that, as the app does.
  describe('the check on other branches', () => {
    const connection = { repo_connection_uuid: 'conn-1' }
    const APP_TRIGGERS: Trigger[] = [
      {
        trigger_uuid: 't-branches',
        trigger_name: 'Check non-production branches (no upload)',
        branch_includes: ['*'],
        branch_excludes: ['main', 'ops-journal'],
        repo_connection: connection,
      },
      {
        trigger_uuid: 't-main',
        trigger_name: 'tag-app',
        branch_includes: ['main'],
        branch_excludes: [],
        repo_connection: connection,
      },
    ]
    const build = desiredBuild({ mcpTag: 'tag-mcp', app: APP })
    const want = desiredBranchTrigger({ mcpTag: 'tag-mcp', build, appTriggers: APP_TRIGGERS })

    it('builds every branch the app builds, from mcp/, and uploads nothing', () => {
      expect(want).toEqual({
        external_script_id: 'tag-mcp',
        repo_connection_uuid: 'conn-1',
        build_token_uuid: 'token-1',
        trigger_name: MCP_BRANCH_TRIGGER,
        build_command: MCP_BUILD_COMMAND,
        deploy_command: MCP_BRANCH_DEPLOY_COMMAND,
        root_directory: MCP_ROOT,
        branch_includes: ['*'],
        branch_excludes: ['main', 'ops-journal'],
        path_includes: ['*'],
        path_excludes: [],
      })
    })

    it('skips the production branch even when the app has no branch trigger', () => {
      const onlyMain = APP_TRIGGERS.slice(1)
      const trigger = desiredBranchTrigger({ mcpTag: 'tag-mcp', build, appTriggers: onlyMain })
      expect(trigger.branch_excludes).toEqual(['main'])
      expect(() => desiredBranchTrigger({ mcpTag: 'tag-mcp', build, appTriggers: [] })).toThrow(
        /no build trigger/,
      )
    })

    it('knows a missing trigger from a drifted one', () => {
      const stored: Trigger = { ...want, trigger_uuid: 't-1', root_directory: '/mcp' }
      expect(triggerState([], want)).toEqual({ current: false })
      expect(triggerState([stored], want)).toEqual({ current: true, uuid: 't-1' })
      expect(triggerState([{ ...stored, deploy_command: 'bun run deploy' }], want)).toEqual({
        current: false,
        uuid: 't-1',
      })
      expect(triggerState([{ ...stored, branch_excludes: [] }], want)).toEqual({
        current: false,
        uuid: 't-1',
      })
    })

    // The API has no call that creates a build configuration (POST /builds/workers
    // is refused with 12002): a trigger on the production branch is what makes one.
    describe('the production trigger', () => {
      const production = desiredProductionTrigger({
        mcpName: 'my-app-mcp',
        mcpTag: 'tag-mcp',
        build,
        appTriggers: APP_TRIGGERS,
      })

      it('deploys the production branch from mcp/, with the app’s repository and token', () => {
        expect(production).toEqual({
          external_script_id: 'tag-mcp',
          repo_connection_uuid: 'conn-1',
          build_token_uuid: 'token-1',
          trigger_name: 'my-app-mcp-main',
          build_command: MCP_BUILD_COMMAND,
          deploy_command: MCP_DEPLOY_COMMAND,
          root_directory: MCP_ROOT,
          branch_includes: ['main'],
          branch_excludes: [],
          path_includes: ['*'],
          path_excludes: [],
          build_caching_enabled: true,
        })
      })

      it('finds one made by hand under another name, and leaves the branch trigger alone', () => {
        const byHand: Trigger = {
          ...production,
          trigger_uuid: 't-prod',
          trigger_name: 'tag-mcp',
          root_directory: '/mcp',
        }
        const branch: Trigger = { ...want, trigger_uuid: 't-1' }
        expect(triggerState([branch, byHand], production)).toEqual({
          current: true,
          uuid: 't-prod',
        })
        expect(triggerState([branch], production)).toEqual({ current: false })
        expect(triggerState([branch, byHand], want)).toEqual({ current: true, uuid: 't-1' })
      })
    })
  })
})
