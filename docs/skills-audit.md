# Skills pack audit — keep or cut

Scope: the 83 skills under `.agents/skills/` plus `.claude/skills/nuxt-ui`. Measured 2026-11-24 at `093fabb`.

## How it was measured

- **What loads.** Claude Code lists only `.claude/skills/` in a session: 16 symlinks into `.agents/skills/` plus `nuxt-ui`, 17 entries. The other 67 directories under `.agents/skills/` never reach a session. Checked against the skill listing recorded in fork session transcripts.
- **Uses.** Every session transcript on the agent host, 424 files covering 2026-11-07 to 2026-11-24 (main sessions and subagents, all template forks): `Skill` tool calls by name, plus any tool call that read a file under a skill directory. Older sessions and other machines were not available.
- **References.** Tracked files in the template and every fork (`AGENTS.md`, docs, `.claude/commands`, `.claude/routines`, scripts), excluding the skill directories and `skills-lock.json`.

## Result

- **No skill in the pack was used.** Zero `Skill` invocations of any pack skill. The only reads of skill files were template-sync and symlink checks, not uses. In the same window sessions invoked other skills 54 times (user-level plugins and this repo's slash commands), so the tool was in use; the pack was not.
- **Nothing references the pack** except `agent-setup.md` (the NuxtUI skill) and one line in `README.md`.
- **Cost.** 17 listed entries put about 2,550 characters (about 640 tokens) into every session's skill listing. The whole pack is 479 tracked files and about 10.2 MB in every checkout and worktree of every fork; `canvas-design` alone is 5.6 MB of fonts.

Keeping three skills cuts the listing to about 880 characters (about 220 tokens) per session, and the pack to 12 files and about 80 KB.

## Table

Uses counts `Skill` invocations and skill-file reads together. Size is the skill directory's bytes on disk.

| Skill | Source | Listed in sessions | Uses | Last used | References | Size (bytes) | Description chars | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | ---: | ---: | --- | --- |
| `a-b-test-design` | Owl-Listener/designer-skills | no | 0 | never | — | 1,781 | 91 | **cut** | Generic design-process prompt; never listed in a session |
| `accessibility-audit` | Owl-Listener/designer-skills | no | 0 | never | — | 1,223 | 112 | **cut** | Generic design-process prompt; never listed in a session |
| `accessibility-test-plan` | Owl-Listener/designer-skills | no | 0 | never | — | 1,753 | 85 | **cut** | Generic design-process prompt; never listed in a session |
| `affinity-diagram` | Owl-Listener/designer-skills | no | 0 | never | — | 1,332 | 205 | **cut** | Generic design-process prompt; never listed in a session |
| `algorithmic-art` | anthropics/skills | no | 0 | never | — | 59,796 | 324 | **cut** | p5.js generative art; no product use |
| `animation-principles` | Owl-Listener/designer-skills | no | 0 | never | — | 1,774 | 78 | **cut** | Generic design-process prompt; never listed in a session |
| `brand-guidelines` | anthropics/skills | no | 0 | never | — | 13,592 | 236 | **cut** | Applies Anthropic's own brand, not a fork's |
| `canvas-design` | anthropics/skills | no | 0 | never | — | 5,554,015 | 289 | **cut** | Poster/art generator; 5.6 MB of bundled fonts; no product use |
| `card-sort-analysis` | Owl-Listener/designer-skills | no | 0 | never | — | 1,082 | 144 | **cut** | Generic design-process prompt; never listed in a session |
| `case-study` | Owl-Listener/designer-skills | no | 0 | never | — | 1,970 | 75 | **cut** | Generic design-process prompt; never listed in a session |
| `claude-api` | anthropics/skills | no | 0 | never | — | 241,277 | 293 | **cut** | Claude Code ships its own claude-api skill |
| `click-test-plan` | Owl-Listener/designer-skills | no | 0 | never | — | 1,611 | 82 | **cut** | Generic design-process prompt; never listed in a session |
| `color-system` | Owl-Listener/designer-skills | yes | 0 | never | — | 1,480 | 107 | **cut** | Generic design prompt; listed every session, never invoked; DESIGN.md owns this |
| `competitive-analysis` | Owl-Listener/designer-skills | no | 0 | never | — | 1,375 | 117 | **cut** | Generic design-process prompt; never listed in a session |
| `component-spec` | Owl-Listener/designer-skills | yes | 0 | never | — | 1,234 | 125 | **cut** | Generic design prompt; listed every session, never invoked; DESIGN.md owns this |
| `dark-mode-design` | Owl-Listener/designer-skills | yes | 0 | never | — | 1,590 | 92 | **cut** | Generic design prompt; listed every session, never invoked; DESIGN.md owns this |
| `data-visualization` | Owl-Listener/designer-skills | yes | 0 | never | — | 1,906 | 90 | **cut** | Generic design prompt; listed every session, never invoked; DESIGN.md owns this |
| `design-brief` | Owl-Listener/designer-skills | no | 0 | never | — | 1,112 | 111 | **cut** | Generic design-process prompt; never listed in a session |
| `design-critique` | Owl-Listener/designer-skills | no | 0 | never | — | 1,937 | 94 | **cut** | Generic design-process prompt; never listed in a session |
| `design-principles` | Owl-Listener/designer-skills | no | 0 | never | — | 1,121 | 95 | **cut** | Generic design-process prompt; never listed in a session |
| `design-qa-checklist` | Owl-Listener/designer-skills | no | 0 | never | — | 2,049 | 66 | **cut** | Generic design-process prompt; never listed in a session |
| `design-rationale` | Owl-Listener/designer-skills | no | 0 | never | — | 1,772 | 96 | **cut** | Generic design-process prompt; never listed in a session |
| `design-review-process` | Owl-Listener/designer-skills | no | 0 | never | — | 1,728 | 80 | **cut** | Generic design-process prompt; never listed in a session |
| `design-sprint-plan` | Owl-Listener/designer-skills | no | 0 | never | — | 1,796 | 84 | **cut** | Generic design-process prompt; never listed in a session |
| `design-system-adoption` | Owl-Listener/designer-skills | no | 0 | never | — | 2,054 | 83 | **cut** | Generic design-process prompt; never listed in a session |
| `design-token` | Owl-Listener/designer-skills | no | 0 | never | — | 1,417 | 117 | **cut** | Generic design-process prompt; never listed in a session |
| `design-token-audit` | Owl-Listener/designer-skills | no | 0 | never | — | 1,797 | 71 | **cut** | Generic design-process prompt; never listed in a session |
| `diary-study-plan` | Owl-Listener/designer-skills | no | 0 | never | — | 1,231 | 172 | **cut** | Generic design-process prompt; never listed in a session |
| `doc-coauthoring` | anthropics/skills | no | 0 | never | — | 15,815 | 428 | **cut** | Generic doc workflow; not tied to this stack |
| `documentation-template` | Owl-Listener/designer-skills | no | 0 | never | — | 1,076 | 107 | **cut** | Generic design-process prompt; never listed in a session |
| `docx` | anthropics/skills | no | 0 | never | — | 1,121,303 | 785 | **cut** | Duplicates the user-level Anthropic docx skill |
| `empathy-map` | Owl-Listener/designer-skills | no | 0 | never | — | 1,922 | 195 | **cut** | Generic design-process prompt; never listed in a session |
| `error-handling-ux` | Owl-Listener/designer-skills | yes | 0 | never | — | 1,802 | 61 | **cut** | Generic design prompt; listed every session, never invoked; DESIGN.md owns this |
| `experience-map` | Owl-Listener/designer-skills | no | 0 | never | — | 1,267 | 109 | **cut** | Generic design-process prompt; never listed in a session |
| `feedback-patterns` | Owl-Listener/designer-skills | yes | 0 | never | — | 1,989 | 99 | **cut** | Generic design prompt; listed every session, never invoked; DESIGN.md owns this |
| `frontend-design` | anthropics/skills | yes | 0 | never | README.md (generic mention) | 14,614 | 399 | **keep** | Only general UI-build skill; worth having on hand for page work alongside DESIGN.md |
| `gesture-patterns` | Owl-Listener/designer-skills | no | 0 | never | — | 1,849 | 64 | **cut** | Generic design-process prompt; never listed in a session |
| `handoff-spec` | Owl-Listener/designer-skills | no | 0 | never | — | 1,812 | 93 | **cut** | Generic design-process prompt; never listed in a session |
| `heuristic-evaluation` | Owl-Listener/designer-skills | no | 0 | never | — | 1,846 | 93 | **cut** | Generic design-process prompt; never listed in a session |
| `icon-system` | Owl-Listener/designer-skills | no | 0 | never | — | 1,042 | 107 | **cut** | Generic design-process prompt; never listed in a session |
| `illustration-style` | Owl-Listener/designer-skills | no | 0 | never | — | 1,773 | 92 | **cut** | Generic design-process prompt; never listed in a session |
| `internal-comms` | anthropics/skills | no | 0 | never | — | 22,405 | 329 | **cut** | Company internal comms; consumer apps, no team |
| `interview-script` | Owl-Listener/designer-skills | no | 0 | never | — | 1,899 | 191 | **cut** | Generic design-process prompt; never listed in a session |
| `jobs-to-be-done` | Owl-Listener/designer-skills | no | 0 | never | — | 1,610 | 184 | **cut** | Generic design-process prompt; never listed in a session |
| `journey-map` | Owl-Listener/designer-skills | no | 0 | never | — | 1,988 | 187 | **cut** | Generic design-process prompt; never listed in a session |
| `layout-grid` | Owl-Listener/designer-skills | no | 0 | never | — | 1,477 | 94 | **cut** | Generic design-process prompt; never listed in a session |
| `loading-states` | Owl-Listener/designer-skills | yes | 0 | never | — | 1,745 | 66 | **cut** | Generic design prompt; listed every session, never invoked; DESIGN.md owns this |
| `mcp-builder` | anthropics/skills | no | 0 | never | — | 121,768 | 277 | **cut** | The mcp/ Worker is already built; generic guide |
| `metrics-definition` | Owl-Listener/designer-skills | no | 0 | never | — | 1,142 | 98 | **cut** | Generic design-process prompt; never listed in a session |
| `micro-interaction-spec` | Owl-Listener/designer-skills | no | 0 | never | — | 1,710 | 84 | **cut** | Generic design-process prompt; never listed in a session |
| `naming-convention` | Owl-Listener/designer-skills | no | 0 | never | — | 1,148 | 111 | **cut** | Generic design-process prompt; never listed in a session |
| `north-star-vision` | Owl-Listener/designer-skills | no | 0 | never | — | 1,157 | 108 | **cut** | Generic design-process prompt; never listed in a session |
| `nuxt-ui` | nuxt/ui | yes | 0 | never | agent-setup.md | 62,812 | 240 | **keep** | Stack-specific; documented in agent-setup.md; complements the nuxt-ui MCP server |
| `opportunity-framework` | Owl-Listener/designer-skills | no | 0 | never | — | 1,059 | 110 | **cut** | Generic design-process prompt; never listed in a session |
| `pattern-library` | Owl-Listener/designer-skills | no | 0 | never | — | 1,227 | 111 | **cut** | Generic design-process prompt; never listed in a session |
| `pdf` | anthropics/skills | no | 0 | never | — | 58,692 | 437 | **cut** | Duplicates the user-level Anthropic pdf skill |
| `playwright-ui-testing` | az9713/playwright-ui-testing | yes | 0 | never | — | 120,296 | 87 | **cut** | Index of /test-* commands that do not exist in this repo |
| `pptx` | anthropics/skills | no | 0 | never | — | 1,129,944 | 694 | **cut** | Duplicates the user-level Anthropic pptx skill |
| `presentation-deck` | Owl-Listener/designer-skills | no | 0 | never | — | 2,085 | 83 | **cut** | Generic design-process prompt; never listed in a session |
| `prototype-strategy` | Owl-Listener/designer-skills | no | 0 | never | — | 1,756 | 73 | **cut** | Generic design-process prompt; never listed in a session |
| `responsive-design` | Owl-Listener/designer-skills | yes | 0 | never | — | 1,594 | 93 | **cut** | Generic design prompt; listed every session, never invoked; DESIGN.md owns this |
| `skill-creator` | anthropics/skills | no | 0 | never | — | 225,004 | 319 | **cut** | Duplicates the user-level Anthropic skill-creator skill |
| `slack-gif-creator` | anthropics/skills | no | 0 | never | — | 43,709 | 226 | **cut** | Slack GIFs; no product use |
| `spacing-system` | Owl-Listener/designer-skills | no | 0 | never | — | 1,329 | 90 | **cut** | Generic design-process prompt; never listed in a session |
| `stakeholder-alignment` | Owl-Listener/designer-skills | no | 0 | never | — | 1,179 | 119 | **cut** | Generic design-process prompt; never listed in a session |
| `state-machine` | Owl-Listener/designer-skills | yes | 0 | never | — | 1,815 | 88 | **cut** | Generic design prompt; listed every session, never invoked; DESIGN.md owns this |
| `summarize-interview` | Owl-Listener/designer-skills | no | 0 | never | — | 1,417 | 185 | **cut** | Generic design-process prompt; never listed in a session |
| `team-workflow` | Owl-Listener/designer-skills | no | 0 | never | — | 2,105 | 83 | **cut** | Generic design-process prompt; never listed in a session |
| `template-skill` | anthropics/skills | no | 0 | never | — | 140 | 68 | **cut** | Empty placeholder |
| `test-scenario` | Owl-Listener/designer-skills | no | 0 | never | — | 1,608 | 84 | **cut** | Generic design-process prompt; never listed in a session |
| `theme-factory` | anthropics/skills | no | 0 | never | — | 144,106 | 262 | **cut** | Themes for slides/docs artifacts, not app UI |
| `theming-system` | Owl-Listener/designer-skills | yes | 0 | never | — | 1,267 | 114 | **cut** | Generic design prompt; listed every session, never invoked; DESIGN.md owns this |
| `typography-scale` | Owl-Listener/designer-skills | yes | 0 | never | — | 1,374 | 83 | **cut** | Generic design prompt; listed every session, never invoked; DESIGN.md owns this |
| `usability-test-plan` | Owl-Listener/designer-skills | no | 0 | never | — | 1,578 | 174 | **cut** | Generic design-process prompt; never listed in a session |
| `user-flow-diagram` | Owl-Listener/designer-skills | no | 0 | never | — | 1,680 | 69 | **cut** | Generic design-process prompt; never listed in a session |
| `user-persona` | Owl-Listener/designer-skills | no | 0 | never | — | 2,373 | 203 | **cut** | Generic design-process prompt; never listed in a session |
| `ux-writing` | Owl-Listener/designer-skills | no | 0 | never | — | 1,933 | 84 | **cut** | Generic design-process prompt; never listed in a session |
| `version-control-strategy` | Owl-Listener/designer-skills | no | 0 | never | — | 1,723 | 78 | **cut** | Generic design-process prompt; never listed in a session |
| `visual-hierarchy` | Owl-Listener/designer-skills | yes | 0 | never | — | 1,740 | 87 | **cut** | Generic design prompt; listed every session, never invoked; DESIGN.md owns this |
| `web-artifacts-builder` | anthropics/skills | no | 0 | never | — | 45,852 | 288 | **cut** | Builds claude.ai artifacts, not Nuxt pages |
| `web-design-guidelines` | vercel-labs/agent-skills | yes | 0 | never | — | 1,231 | 184 | **keep** | Small; a review pass for UI/a11y that fetches the current guideline list |
| `webapp-testing` | anthropics/skills | yes | 0 | never | — | 22,406 | 204 | **cut** | Repo has its own Playwright suites and test:a11y |
| `wireframe-spec` | Owl-Listener/designer-skills | no | 0 | never | — | 1,628 | 85 | **cut** | Generic design-process prompt; never listed in a session |
| `xlsx` | anthropics/skills | no | 0 | never | — | 1,093,063 | 943 | **cut** | Duplicates the user-level Anthropic xlsx skill |
