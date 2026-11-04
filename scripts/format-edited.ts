// Claude Code PostToolUse hook (`.claude/settings.json`): runs oxfmt on the file an Edit or
// Write just touched, so `format:check` stops being the gate agents fail most often.
// Paths that `.oxfmtrc.json` ignores are skipped by oxfmt itself. Never blocks the agent:
// every failure here exits 0.

import { relative, resolve } from 'node:path'

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()

try {
  const input = JSON.parse(await Bun.stdin.text()) as { tool_input?: { file_path?: string } }
  const file = input.tool_input?.file_path
  const rel = file ? relative(root, resolve(root, file)) : ''
  if (rel && !rel.startsWith('..') && /\.(c|m)?(t|j)sx?$|\.vue$|\.css$/.test(rel)) {
    Bun.spawnSync(['bunx', 'oxfmt', rel], { cwd: root, stdout: 'ignore', stderr: 'ignore' })
  }
} catch {
  // A malformed payload or a missing oxfmt must not interrupt the edit.
}
