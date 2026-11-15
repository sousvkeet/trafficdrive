# TrafficDrive

Desktop app (Electron + Playwright) that drives real browsers to visit pages: direct, organic-search, social-referral and Google Maps campaigns, proxies, privacy protections, schedules and record-and-replay.

AI assistants (Claude Code, Claude Desktop, Cursor, VS Code, Antigravity, Cline, Roo Code, Gemini CLI, Codex, Zed, Continue, LM Studio, Kiro) can run everything the app does through its built-in **MCP server**. The **AI Assistant** page in the app shows the exact setup for each assistant, and offers an optional **skill** that teaches an assistant to use TrafficDrive well (`skills/trafficdrive`).

Only run campaigns against sites you own or have permission to test.

## Install (Windows)

Download the installer from the [Releases](../../releases) page:

- `TrafficDrive-Setup-<version>.exe` — per-user installer
- `TrafficDrive-<version>-x64.msi` — per-machine installer

The installers are not code-signed, so Windows SmartScreen may warn on first run. TrafficDrive uses Chrome or Edge already on the PC.

## Run from source

```bash
npm ci
npx playwright install chromium   # optional: a bundled Chromium (otherwise Chrome/Edge is used)
npm start                          # the desktop app
npm run mcp                        # the MCP server on its own (stdio)
```

## Build and release

Releases are built by GitHub Actions on a Windows runner (`.github/workflows/build-release.yml`):

1. Bump `version` in `package.json` and commit.
2. Tag it and push: `git tag v<version> && git push origin v<version>`.

The workflow builds the `.exe` and `.msi`, smoke-tests the packaged app (`scripts/smoke-packaged.js`) and publishes the Release. **Actions → Build and release → Run workflow** builds without releasing.

To build locally on Windows: `npm ci && npm run dist` (output in `dist/`).
