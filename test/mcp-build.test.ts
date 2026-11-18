// The Workers Build the MCP worker is given, as the data sent to Cloudflare.
// scripts/mcp-build-setup.ts owns the network; this holds the shape.

import { describe, expect, it } from 'vitest'

import mcpPackage from '../mcp/package.json'
import {
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
    })
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

  it('knows when nothing needs changing, however the root is spelled', () => {
    const want = desiredBuild({ mcpTag: 'tag-mcp', app: APP })
    const same = { git_repository: REPO, production_settings: { ...want.production_settings } }
    expect(isCurrent(same, want)).toBe(true)
    expect(
      isCurrent(
        { ...same, production_settings: { ...same.production_settings, root_directory: '/mcp/' } },
        want,
      ),
    ).toBe(true)
    expect(isCurrent(null, want)).toBe(false)
    expect(
      isCurrent(
        { ...same, production_settings: { ...same.production_settings, deploy_command: 'x' } },
        want,
      ),
    ).toBe(false)
  })
})
