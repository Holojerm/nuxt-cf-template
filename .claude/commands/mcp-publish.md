# MCP Publish

List this app's MCP server (`mcp/`) where people look for one: the official MCP Registry, Claude's Connectors Directory, and ChatGPT's directory.

The registry is published by CI. The other two are portal forms that only the owner can submit, signed in as themselves. This command gets everything ready for them and says exactly what to paste where. It never submits anything.

## Usage

- `/mcp-publish` — the whole first listing, in order
- `/mcp-publish check` — only report what is missing (steps 1 and 4)
- `/mcp-publish registry | claude | chatgpt` — one destination

## What already exists

Do not rebuild any of this. [`.claude/docs/mcp.md`](../docs/mcp.md) explains each piece.

| Piece | What it does |
| --- | --- |
| `mcp/listing.json` | The one file to fill in |
| `bun run mcp:check` | Fails on an undeclared tool or a listing that contradicts the repo |
| `bun run mcp:pack` | Writes `mcp/.publish/` and prints a readiness checklist per directory |
| `bun run mcp:publish --dry-run` | Says what CI would publish to the registry |
| `.github/workflows/mcp-publish.yml` | Publishes to the registry on push to main |

## Instructions

### 1. Confirm there is a server to list

The worker must be deployed and reachable; a listing for a server nobody can connect to is rejected by both portals. Ask for its URL if `mcp/listing.json › url` still ends in `example.workers.dev`. If it has not been deployed, stop and point at README › MCP server, "Deploying it for real".

Then run `bun run mcp:check`. Fix every tool it reports before going further: a tool without a `title` and all three annotation hints is refused by both directories.

### 2. Fill in `mcp/listing.json`

Read `mcp/src/server.ts` for what the tools do, and the app's landing page and `NUXT_PUBLIC_APP_DESCRIPTION` for how the product describes itself. Then write:

- `tagline` (30 characters), `summary` (100) and `description` (2,000). Say what a person can do with the server, in the product's voice. Describe only what the tools do today; reviewers test the claims.
- `categories`, `keywords`, `useCases`, `prerequisites`.
- `prompts`: three or four things a user would actually ask.
- `testCases`: five positive, each naming the tool or tools it should trigger and the expected result, and three negative (requests the server should not act on). Cover every tool at least once.
- `commerce`: leave empty unless the server itself takes payment.

Ask the owner for what only they know. Do not invent any of it:

- **The registry name.** Either `io.github.<owner>/<name>` with `"auth": "github-oidc"` (nothing to set up; `<owner>` is the GitHub owner of this repository), or `<reversed-domain>/<name>` with `"auth": "dns"` for a domain they control (one TXT record and one repository secret; the commands are in `.claude/docs/mcp.md` › Registry auth).
- **`links.docs`**: a public page explaining how to connect and what the tools do. If none exists, offer to write it as a post in `content/blog/` (see `.claude/docs/seo.md`), which gives it a URL on the app's own domain.
- **`links.support`**: an https page. ChatGPT does not accept an email address here.
- **`demoRecordingUrl`**: a screen recording of the server in use. ChatGPT's review requires one. Only the owner can record it.

### 3. Point the app at the server

Set `NUXT_PUBLIC_MCP_URL` in `wrangler.toml [vars]` to the same origin as `mcp/listing.json › url`. That puts the address on `/account`, in `llms.txt`, and in `/.well-known/ai-catalog.json`.

### 4. Build the pack and read the checklist

```bash
bun run mcp:pack
```

It writes `mcp/.publish/` and prints three checklists. Report them as they are. Fix what is fixable in the repo; list what needs the owner.

### 5. The official MCP Registry

1. Set `"publish": true` in `mcp/listing.json` and run `bun run mcp:check`.
2. For `"auth": "dns"`, confirm the TXT record resolves and the `MCP_REGISTRY_PRIVATE_KEY` secret exists before merging. Without them the first workflow run fails at login.
3. Open the PR. After it merges, the **Publish MCP listing** workflow publishes the entry.
4. Verify, with the name URL-encoded (`/` is `%2F`):

   ```bash
   curl -s https://registry.modelcontextprotocol.io/v0.1/servers/<name>/versions/latest
   ```

Later listing edits need a bump of `mcp/package.json › version`. A published version cannot be changed, and the workflow fails on an edit without a bump.

### 6. Claude's Connectors Directory

Needs a paid Claude plan. Hand the owner `mcp/.publish/claude-connector.md`; its sections are the portal's ten steps in order.

1. First, in Claude, add the server as a custom connector and call every tool. The portal asks them to confirm they did.
2. `claude.ai/directory/manage` → Submit new → MCP connector.
3. Paste each step from the sheet. The icon is `public/icon-512.png`.
4. The compliance step is seven acknowledgments only they can make.

Submissions are scanned automatically and listed as a Community connector by default. Status and reviewer feedback appear in the same portal.

### 7. ChatGPT's directory

Needs a verified OpenAI organization, and the owner or the Apps Management Write role.

1. `platform.openai.com/plugins` → Upload new or existing plugin → `mcp/.publish/chatgpt-plugin.zip`. Resolve any automated findings by fixing `mcp/listing.json` and rebuilding the pack, not by editing the ZIP.
2. **Domain verification.** The portal shows a token and the URL it will fetch. Put the token in `mcp/wrangler.jsonc › vars.OPENAI_APPS_CHALLENGE`, run `bun run mcp:deploy`, and confirm before they click verify:

   ```bash
   curl -s https://<mcp-host>/.well-known/openai-apps-challenge
   ```

   The body must be the token and nothing else.
3. Reviewer access: they enter test credentials in the portal, never in the ZIP. This server signs in with a connect code from `/account`, so the reviewer needs an account they can sign in to.
4. Submit for review. Feedback comes by email. After approval, they choose when to publish.

### 8. Say what happens next

Close by telling the owner how each listing stays current, because the three differ:

- **Tools changed** (added, renamed, re-annotated): deploy the worker. Claude syncs from the live server; ChatGPT rescans daily. Update `testCases` for a renamed tool, which `mcp:check` enforces.
- **Listing copy changed**: bump `mcp/package.json › version` for the registry. Edit Claude's listing in its portal. Upload a new ZIP to ChatGPT.
- **The worker's URL changed**: update `url` and `NUXT_PUBLIC_MCP_URL` together. ChatGPT requires contacting support to change a listed server's URL, so avoid it.

## Notes

- Never put credentials, tokens or the DNS private key in `mcp/listing.json`, the pack, or a commit. The pack is public material by design.
- `mcp/.publish/` is gitignored and rebuilt from scratch on every run. Do not edit files in it.
- If a portal's fields no longer match the pack, the portal is right. Update `scripts/lib/mcp-listing.ts` so the next fork gets the fix.
