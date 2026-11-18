# The MCP worker: tool contract, discovery, directory listings

How the optional `mcp/` worker describes itself to MCP clients and to the three directories people find servers in, and what keeps those descriptions true.

> **Load this when:** adding or changing a tool in `mcp/src/`, editing `mcp/listing.json`, touching the discovery routes or `NUXT_PUBLIC_MCP_URL`, or listing the server in a directory.
> Canonical index: [AGENTS.md](../../AGENTS.md). Auth, the connect code and entitlement gating are in [billing.md](billing.md) and the README's MCP section; removing the worker is in the repo's TEARDOWN checklist.

---

## The pieces

| Piece | What it does |
| --- | --- |
| `mcp/listing.json` | The listing: copy, registry name, test prompts. Holds only what exists nowhere else in the repo |
| `mcp/src/discovery.ts` | Public routes on the worker: the Server Card, an AI Catalog, ChatGPT's domain challenge |
| `server/routes/.well-known/ai-catalog.json.get.ts` | The app's AI Catalog, pointing at the worker's Server Card |
| `scripts/lib/mcp-tools.ts` | Reads `registerTool()` calls out of the worker's source |
| `scripts/lib/mcp-listing.ts` | The listing's schema, and the builders for `server.json`, ChatGPT's `plugin.json` and the Claude form |
| `bun run mcp:check` | The gate, in `bun run ci` |
| `bun run mcp:pack` | Writes the submission pack to `mcp/.publish/` and prints what each directory still needs |
| `bun run mcp:publish` | Publishes to the official MCP Registry; CI runs it from `.github/workflows/mcp-publish.yml` |
| `/mcp-publish` | The slash command that walks a first listing end to end |

## The tool contract

Every `registerTool()` call in `mcp/src/` declares a `title`, a `description`, and all three hints, inline and as literals:

```ts
server.registerTool(
  'search_notes',
  {
    title: 'Search notes',
    description: 'Find notes by text',
    inputSchema: { query: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ query }) => { /* … */ },
)
```

- `readOnlyHint`: the tool changes nothing anywhere.
- `destructiveHint`: it can delete or overwrite. False for a pure create, and always false on a read-only tool.
- `openWorldHint`: it reaches beyond this app's own data (the web, a third-party API).

Claude's directory requires a title and a read-only or destructive hint on every tool. ChatGPT's wants all three hints set explicitly. Both read them from the live server, so a tool missing one is found at review. `mcp:check` reads the calls from source and fails the build first.

It reads source because the root install does not install `mcp/`'s dependencies, so nothing in `bun run ci` can start the server. That is why the declarations must be literals: a config held in a variable, or a hint computed at runtime, is reported as unreadable instead of being skipped.

## `mcp/listing.json`

| Field | Used for |
| --- | --- |
| `publish` | `true` makes CI publish to the official registry. `false` (the template default) keeps a fork out of it |
| `url` | The worker's public origin, no path. `/mcp` is appended |
| `registry.name` | `<namespace>/<server>`, the registry identity. Also the Server Card's `name` |
| `registry.auth` | How CI proves the namespace: `github-oidc`, `dns` or `http` |
| `tagline` | 30 characters. ChatGPT's subtitle |
| `summary` | 100 characters. The registry and Server Card `description`; Claude's one-liner |
| `description` | 2,000 characters, Claude's limit (ChatGPT allows 4,000) |
| `categories`, `keywords`, `useCases`, `prerequisites` | Listing fields both portals ask for |
| `commerce` | Why and how the server takes payments. Empty means it takes none |
| `links.docs`, `links.support` | Required by the directories. No default: write the pages |
| `links.website`, `links.privacy`, `links.terms` | Optional overrides. Default to `fleet.json › urls.prod`, its `/privacy` and its `/terms` |
| `prompts` | Starter prompts |
| `testCases` | What a reviewer runs. ChatGPT requires five positive and three negative |
| `demoRecordingUrl`, `releaseNotes` | ChatGPT's review and listing |

Derived, never typed twice: the title from `fleet.json › name`, the version from `mcp/package.json`, the publisher from `NUXT_PUBLIC_LEGAL_ENTITY` and `NUXT_PUBLIC_SUPPORT_EMAIL` in `wrangler.toml`, the icons from the brand mark's `public/icon-192.png` and `public/icon-512.png`, the tool list from the worker's source.

The schema enforces the length limits whether or not the listing is published, so the template's copy avoids the app's name in the short fields: `bun run rename` must not be able to push `tagline` past 30.

## Discovery

Three ways a client finds the server without being handed its URL.

**The official MCP Registry.** `bun run mcp:publish` builds a remote-only `server.json` and publishes it. Marketplaces and aggregators pull from the registry, so this is the one that reaches places nobody submitted to.

**A Server Card**, at `GET <worker>/mcp/server-card`. The static description a client reads before connecting: name, version, description, and where the Streamable HTTP endpoint is. It lists no tools; the extension leaves those to the live `tools/list`. The card's `remotes` come from the request's own origin, so a preview deploy describes itself.

**An AI Catalog**, at `/.well-known/ai-catalog.json` on both the app and the worker. This is the domain-level step: a client that knows only `example.com` fetches the catalog and follows its one entry to the card. The app's copy is what matters, because the app's domain is the one people know.

The card and the worker's catalog 404 while `registry.name` still carries the template's `YOUR_GITHUB_OWNER`. The app's catalog 404s until `NUXT_PUBLIC_MCP_URL` is set, and on preview deploys.

`NUXT_PUBLIC_MCP_URL` (`wrangler.toml [vars]`) is the app's side of this. It is the worker's origin; the endpoint, the same URL ending in `/mcp`, is read as the same server, so either spelling works. Setting it also puts the server address on `/account` beside the connect code, and adds an "MCP server" section to `llms.txt`.

Server Cards are SEP-2127, accepted in 2026 as an extension. Its repository still labels the `v1` schema pre-release, and the registry calls itself a preview. If the card's shape or path moves, `serverCard()` in `mcp/src/discovery.ts` is the one place to change.

## What `mcp:check` holds together

1. Every tool is readable from source and fully declared; no name is registered twice.
2. `mcp/package.json` has a `version`. The server, the card and the registry entry all report that one field.
3. `mcp/listing.json` matches `McpListingSchema`.
4. Every tool a test case names exists.
5. `NUXT_PUBLIC_MCP_URL`, when set, equals the listing's `url`, and `registry.name` is real by then (otherwise the app's catalog points at a card that 404s).
6. With `publish: true`: no placeholder name or host, an auth method that fits the namespace, a plain semver version, and `NUXT_PUBLIC_MCP_URL` set.

What a directory needs beyond that (a docs page, five test cases, a recording) is a checklist printed by `mcp:pack`, not a build failure. A fork may list in one directory and not another.

`test/mcp-listing.test.ts` holds the worker's Server Card and the registry's `server.json` to the same identity fields. They are built in two packages, and the worker cannot import the scripts.

## The three directories

| | How it is submitted | How it stays current |
| --- | --- | --- |
| Official MCP Registry | CI, on push to main | Bump `mcp/package.json › version`; CI publishes the new version |
| Claude Connectors Directory | By hand, once, at `claude.ai/directory/manage`. The pack's Claude sheet (`bun run mcp:pack`) has every field | Tools sync from the live server. Listing copy is edited in the portal |
| ChatGPT directory | By hand, once, at `platform.openai.com/plugins`. Upload the pack's plugin ZIP | The server is rescanned daily. A copy or asset change is a new ZIP |

Neither portal has an API. `mcp:pack` automates everything up to the upload.

### Registry versions are immutable

A published version cannot be edited. `mcp:publish` asks the registry whether the current version exists: unchanged, it does nothing; changed, it fails and says which fields differ. So editing `summary` without bumping the version turns the workflow red on main, which is the point: the alternative is an edit that silently reaches nobody.

### Registry auth

- **`github-oidc`** with a name under `io.github.<owner>/`. GitHub Actions mints the token; there is no secret. The owner is whoever owns the repository the workflow runs in.
- **`dns`** with a name under a reversed domain (`com.example/notes`). Generate an Ed25519 key, publish the public half as a TXT record at the domain's apex, and add the private half as the `MCP_REGISTRY_PRIVATE_KEY` repository secret:

  ```bash
  openssl genpkey -algorithm Ed25519 -out key.pem
  echo "TXT: v=MCPv1; k=ed25519; p=$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
  # the secret's value:
  openssl pkey -in key.pem -noout -text | sed -n '/priv:/,/pub:/p' | sed '1d;$d' | tr -d ' :\n'
  ```

- **`http`** is the same key, with the public half served at `https://<domain>/.well-known/mcp-registry-auth` instead of in DNS. Nothing in the template serves that file.

The registry verifies the namespace, not the URL. A domain namespace is what lets a reader see that the name and the endpoint share an owner.

### ChatGPT's domain challenge

During submission the portal issues a token and fetches it from `https://<mcp-host>/.well-known/openai-apps-challenge`. Put it in `mcp/wrangler.jsonc › vars.OPENAI_APPS_CHALLENGE` and run `bun run mcp:deploy`. The route returns the token alone, and 404s while the var is empty. It is not a secret: the route publishes it.

## Deploying the worker

The worker has a Workers Build of its own, separate from the app's, because one build can deploy
only its own Worker ([gotchas.md](gotchas.md)). On every push to the production branch Cloudflare
builds it from `mcp/`: `bun run build:ci` (the typecheck), then `bun run deploy:ci`, which:

1. refuses if the build belongs to another Worker (`mcp/scripts/guard-deploy.ts`);
2. waits, up to ten minutes, until the app's migrations are applied to the shared D1
   (`mcp/scripts/wait-for-migrations.ts`). The app's build is the one that migrates, and both builds
   start on the same push;
3. runs `wrangler deploy`.

Setting it up, once per fork:

1. `bun run mcp:deploy` from a machine, so the Worker exists.
2. `bun run mcp:build:setup`. It copies the app's repository connection and build token to a
   build for this Worker with `mcp/` as its root, and is safe to run again: it changes nothing
   when the configuration is already right, and `--dry-run` prints what it would send.

`mcp:build:setup` needs `CLOUDFLARE_ACCOUNT_ID` and, in `CLOUDFLARE_API_TOKEN`, a **user** API
token with "Workers Builds Configuration: Edit" and "Workers Scripts: Read". The Builds API
refuses account-scoped tokens, and the token `wrangler login` holds does not carry the first
permission.

A pull request's branch gets the build command only, as a check named `Workers Builds: <worker>`,
from a second trigger ("Check non-production branches (no upload)") that skips the branches the
app's own branch trigger skips. Its deploy command is an `echo`: a preview version of this worker
would run with the production database and the production OAuth store. Previews stay off, and
with them off Cloudflare builds no other branch unless such a trigger exists.

Two things the Builds API does that its reference does not say, both handled by the script:
creating a build stores the production settings and drops the branch settings sent with them, and
the first write of the branch settings must be complete. Build variables are merged, not replaced,
so the script never removes one a fork set by hand.

The build has no watch paths on purpose: a worker left behind an app deploy reads a schema that
has moved, and a rebuild that changes nothing costs seconds.

## Adding a tool

1. Register it in `mcp/src/server.ts` with the full declaration above. Start the handler with `loadAuthorizedUser(env)`, as the two shipped tools do.
2. Add a positive test case for it to `mcp/listing.json`.
3. `bun run mcp:check`, then `bun run mcp:typecheck` (needs `bun install` inside `mcp/`).
4. Deploy. Claude's directory picks the tool up from the live server and ChatGPT's on its daily rescan. The registry entry lists no tools, so it needs no new version for this.
