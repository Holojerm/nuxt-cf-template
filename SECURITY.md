# Security Policy

## Reporting a Vulnerability

**Report vulnerabilities privately via [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/reporting-a-security-vulnerability) on this repository.** Never open a public issue for a security concern.

You can expect an acknowledgment within 72 hours of reporting.

## Scope

**In scope:**
- The app (`app/`, `server/`, `shared/`)
- The MCP worker (`mcp/`)
- CI and agent scaffolding (`scripts/`, `.claude/`)

**Out of scope:**
- Vulnerabilities in upstream dependencies — report those to the maintainers of the affected package
- Issues that require a compromised Cloudflare account or GitHub account

## For forks

This file ships with the template. **Before launching your fork as a public product, replace the reporting channel above with your own contact method or responsible disclosure program.** A forked repo with no security contact is a liability.

## Leaked secrets

If you find a leaked secret (API key, token, credential) in the repository history, report it privately the same way — via GitHub's private vulnerability reporting.
