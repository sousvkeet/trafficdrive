#!/usr/bin/env node
'use strict';
// TrafficDrive MCP server (stdio).
//
// Lets an MCP client (Claude Code, Claude Desktop, …) run everything the app
// does: start/monitor/stop campaigns, manage proxies and browsers, choose and
// verify privacy protections, schedule campaigns and record/replay browser
// sessions.
//
//   Claude Code:     claude mcp add trafficdrive -- node /path/to/src/mcp-server.js
//   Claude Desktop:  { "mcpServers": { "trafficdrive": { "command": "node", "args": ["/path/to/src/mcp-server.js"] } } }
//
// Run with --help for options.

// stdout is the protocol channel: anything else printed there corrupts the
// stream. The traffic modules log with console.log, so send ALL console output
// to stderr — before anything is loaded.
console.log = console.info = console.debug = (...args) => console.error(...args);

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { connectBackend } = require('./mcp/backend.js');
const { registerTools } = require('./mcp/tools.js');
const { registerResources } = require('./mcp/resources.js');
const { registerPrompts } = require('./mcp/prompts.js');

const VERSION = (() => { try { return require('./package.json').version; } catch (_) { return '0.0.0'; } })();

const HELP = `TrafficDrive MCP server ${VERSION}

Usage: node mcp-server.js [options]

Connection (default: attach to the running TrafficDrive app, else start a private embedded backend):
  --mode <auto|connect|embedded>  auto (default) | connect (never start one) | embedded (always start one)
  --url <http://127.0.0.1:PORT>   attach to this backend (also TD_API_URL); needs --token
  --token <token>                 backend API token (also TD_API_TOKEN)
  --port <n>                      embedded backend port (default: any free port; also TD_PORT)
  -h, --help                      show this help
  -v, --version                   show the version

Environment:
  TD_MCP_MODE, TD_API_URL, TD_API_TOKEN, TD_PORT   same as the options above
  TD_MAX_THREADS (default 50), TD_MAX_SESSIONS (default 100000)   safety limits of an embedded backend
  TD_DATA_DIR                      where settings, schedules and the connection file live
  TD_NO_CONNECTION_FILE=1          (desktop app) do not publish the connection file

Attaching to the desktop app means campaigns started here appear in its dashboard.
`;

function parseArgs(argv) {
  const out = { mode: process.env.TD_MCP_MODE, url: process.env.TD_API_URL, token: process.env.TD_API_TOKEN, port: process.env.TD_PORT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-v' || a === '--version') out.version = true;
    else if (a === '--mode') out.mode = next();
    else if (a === '--url') out.url = next();
    else if (a === '--token') out.token = next();
    else if (a === '--port') out.port = next();
    else throw new Error(`Unknown option ${a} (see --help)`);
  }
  if (out.mode && !['auto', 'connect', 'embedded'].includes(out.mode)) throw new Error(`--mode must be auto, connect or embedded (got "${out.mode}")`);
  out.port = out.port !== undefined && out.port !== '' ? parseInt(out.port, 10) : undefined;
  if (out.port !== undefined && !(out.port >= 0 && out.port <= 65535)) throw new Error('--port must be 0-65535');
  return out;
}

const INSTRUCTIONS = `TrafficDrive automates website traffic with real browsers.

Typical flow: get_status → (optionally add_proxies, preview_privacy_config / verify_privacy) → start_direct_traffic | start_organic_search_traffic | start_referral_traffic | start_google_maps_traffic → wait_for_campaign or get_campaign → stop_campaign.
Start small (1–3 sessions) before large runs. Campaigns are listed by list_campaigns and removed 10 minutes after they finish.
Privacy: use privacyProfile ("balanced" / "stealth") or explicit privacyFeatures; list_privacy_features explains each one.
Schedules created with create_schedule run inside the backend; the app must be running at that time.
Saved campaigns (save_campaign / run_saved_campaign) are shared with the dashboard's Campaigns page. list_user_agents, list_resolutions and list_browser_catalog expose the app's built-in libraries. rpa_* tools record and replay browser sessions, and a replay can be scheduled (mode "rpa").
scrape_free_proxies downloads from the sources switched on in the app (list_proxy_sources); validate_proxies tests many proxies at once and, unless removeDead=false, removes the dead ones. Only the user can add proxy sources, in the app.
Proxy credentials are never returned by any tool. customBrowserPath only accepts browsers shown by list_browsers.`;

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
  if (args.help) { process.stdout.write(HELP); return; }
  if (args.version) { process.stdout.write(`${VERSION}\n`); return; }

  const log = (m) => process.stderr.write(`[trafficdrive-mcp] ${m}\n`);
  process.on('unhandledRejection', (r) => log(`unhandled rejection: ${r && r.stack || r}`));

  const backend = await connectBackend({ mode: args.mode, url: args.url, token: args.token, port: args.port, log });

  const server = new McpServer(
    { name: 'trafficdrive', title: 'TrafficDrive', version: VERSION },
    { capabilities: { resources: { subscribe: true, listChanged: true }, logging: {} }, instructions: INSTRUCTIONS },
  );
  const ctx = { backend };
  registerTools(server, ctx);
  const resources = registerResources(server, ctx);
  registerPrompts(server);

  let closing = false;
  async function shutdown(reason) {
    if (closing) return;
    closing = true;
    log(`shutting down (${reason})`);
    resources.stopWatcher();
    try { await Promise.race([backend.close(), new Promise((r) => setTimeout(r, 15000))]); } catch (_) {}
    process.exit(0);
  }
  server.server.onclose = () => shutdown('client disconnected');
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.connect(new StdioServerTransport());
  resources.startWatcher();
  log(`ready — ${backend.mode} backend (${backend.source}) at ${backend.url}`);
}

main().catch((e) => { process.stderr.write(`[trafficdrive-mcp] fatal: ${e && e.message ? e.message : e}\n`); process.exit(1); });
