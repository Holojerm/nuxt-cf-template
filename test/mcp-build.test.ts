// The Workers Build the MCP worker is given, as the data sent to Cloudflare.
// scripts/mcp-build-setup.ts owns the network; this holds the shape.

import { describe, expect, it } from 'vitest'

import mcpPackage from '../mcp/package.json'
import {
  MCP_BRANCH_DEPLOY_COMMAND,
  MCP_BUILD_COMMAND,
  MCP_DEPLOY_COMMAND,
  MCP_ROOT,
  desiredBuild,
  isCurrent,
  type BuildConfig,
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
    expect(desiredBuild({ mcpTag: 'tag-mcp', app: APP })).toEqual({
      script_tag: 'tag-mcp',
      git_repository: REPO,
      production_settings: {
        build_command: MCP_BUILD_COMMAND,
        deploy_command: MCP_DEPLOY_COMMAND,
        build_token_uuid: 'token-1',
        root_directory: MCP_ROOT,
      },
      previews_enabled: false,
      previews_base_config: {
        build_command: MCP_BUILD_COMMAND,
        deploy_command: MCP_BRANCH_DEPLOY_COMMAND,
        build_token_uuid: 'token-1',
        root_directory: MCP_ROOT,
      },
    })
  })

  it('never uploads from a branch build', () => {
    // A pull request's build would otherwise publish a preview of the worker
    // bound to the production database.
    const { previews_base_config: branch, previews_enabled } = desiredBuild({
      mcpTag: 't',
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
      production_settings: {
        ...want.production_settings,
        root_directory: '/mcp',
        path_includes: ['*'],
      },
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
})
