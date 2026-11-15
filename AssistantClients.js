// AssistantClients.js — the AI assistants / agents TrafficDrive's MCP server can be added to.
//
// Pure data and string building (no I/O): for each client, how to recognise it on this computer, where its MCP
// config lives (when that is known), and the exact setup to show — a one-line command and/or a config snippet in
// the client's own format. server.js does the file/PATH probing using the fields below.
//
// Every client here was checked against its official documentation (links in `docs`); where a doc gives no config
// path (VS Code user profile, Roo, Zed, Continue, LM Studio) none is invented: the UI route the doc describes is
// shown instead and no "already set up" state is reported (`stateFile` is null).
// Windsurf is deliberately absent: its documentation now redirects away and could not be verified.
//
// `launch` is server.js's mcpLaunchInfo(): { command, args:[script], env:{} }.
'use strict';

// ── quoting ───────────────────────────────────────────────────────────────────
function shellQuote(str, platform) {
  if (/^[\w@%+=:,./-]+$/.test(str)) return str;
  if (platform === 'win32') return '"' + str.replace(/"/g, '\\"') + '"';
  return '"' + str.replace(/(["\\$`])/g, '\\$1') + '"';
}
// POSIX single quotes: nothing is special inside them except the quote itself.
const posixSingle = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
// TOML literal string (no escapes) unless the value contains a quote/newline; then a basic string.
const tomlStr = (s) => (/^[^'\r\n]*$/.test(s) ? `'${s}'` : JSON.stringify(s));
const yamlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;
const json = (o) => JSON.stringify(o, null, 2);
const hasEnv = (launch) => Object.keys(launch.env || {}).length > 0;

// { command, args, env? } — the stdio server definition most clients share.
function entry(launch, extra) {
  const e = { command: launch.command, args: launch.args.slice() };
  if (hasEnv(launch)) e.env = { ...launch.env };
  return { ...e, ...(extra || {}) };
}
const mcpServersJson = (launch, extra) => json({ mcpServers: { trafficdrive: entry(launch, extra) } });
const envFlags = (launch, flag) => Object.entries(launch.env || {}).map(([k, v]) => `${flag} ${k}=${v} `).join('');
const home = (env, ...p) => env.join(env.home, ...p);

// ── state helpers (shared) ────────────────────────────────────────────────────
// 'none' | 'current' (points at this install) | 'stale' (set up for another location)
function entryState(e, launch) {
  if (!e || typeof e !== 'object') return 'none';
  return e.command === launch.command && Array.isArray(e.args) && e.args[0] === launch.args[0] ? 'current' : 'stale';
}
const mcpServersState = (cfg, launch) => ({ state: entryState(cfg && cfg.mcpServers && cfg.mcpServers.trafficdrive, launch) });

// Codex keeps servers in TOML: look inside the [mcp_servers.trafficdrive] section.
function codexState(text, launch) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\[mcp_servers\.trafficdrive\]\s*$/.test(l));
  if (start < 0) return { state: 'none' };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]) && !/^\s*\[mcp_servers\.trafficdrive\./.test(lines[i])) { end = i; break; }
  }
  const body = lines.slice(start, end).join('\n');
  const variants = (s) => [s, s.replace(/\\/g, '\\\\')];       // literal vs basic-string spelling of a path
  const has = (s) => variants(s).some((v) => body.includes(v));
  return { state: has(launch.command) && has(launch.args[0]) ? 'current' : 'stale' };
}

// Claude Code spreads entries over user scope and per-project scopes inside one file.
function claudeCodeState(cfg, launch) {
  const states = [], scopes = [];
  if (cfg && cfg.mcpServers && cfg.mcpServers.trafficdrive) { states.push(entryState(cfg.mcpServers.trafficdrive, launch)); scopes.push('user'); }
  if (cfg && cfg.projects && typeof cfg.projects === 'object') {
    for (const p of Object.values(cfg.projects)) {
      if (p && p.mcpServers && p.mcpServers.trafficdrive) { states.push(entryState(p.mcpServers.trafficdrive, launch)); if (!scopes.includes('project')) scopes.push('project'); }
    }
  }
  return { state: states.includes('current') ? 'current' : (states.includes('stale') ? 'stale' : 'none'), scopes };
}

// ── the clients ───────────────────────────────────────────────────────────────
//  cli / cliVersion   command looked up on PATH (version only run for well-known CLI agents)
//  appDirs(env)       folders whose presence means the app is installed
//  extPrefix          VS Code extension id (matched in the extensions folders)
//  stateFile / stateKind / stateOf   where to read "is TrafficDrive already set up?" from (null = unknown)
const CLIENTS = [
  {
    id: 'claudeCode', name: 'Claude Code', cli: 'claude', cliVersion: true,
    docs: 'https://docs.claude.com/en/docs/claude-code/mcp',
    stateFile: (env) => home(env, '.claude.json'), stateKind: 'json', stateOf: claudeCodeState,
    setup: (launch, env) => ({
      blocks: [{ label: 'Run once in a terminal', text: `claude mcp add ${envFlags(launch, '-e')}trafficdrive -- ${shellQuote(launch.command, env.platform)} ${shellQuote(launch.args[0], env.platform)}` }],
      steps: ["Claude Code then starts TrafficDrive's tools automatically."],
    }),
  },
  {
    id: 'claudeDesktop', name: 'Claude Desktop',
    docs: 'https://modelcontextprotocol.io/quickstart/user',
    appDirs: (env) => [env.claudeDesktopDir, env.platform === 'win32' && env.join(env.localappdata, 'AnthropicClaude'), env.platform === 'darwin' && '/Applications/Claude.app'],
    stateFile: (env) => env.join(env.claudeDesktopDir, 'claude_desktop_config.json'), stateKind: 'json', stateOf: mcpServersState,
    setup: (launch, env) => ({
      blocks: [{ label: 'Add to claude_desktop_config.json', text: mcpServersJson(launch) }],
      steps: ['In Claude Desktop open Settings → Developer → Edit Config, merge this under "mcpServers", then restart Claude Desktop.', `Config file: ${env.join(env.claudeDesktopDir, 'claude_desktop_config.json')}`],
    }),
  },
  {
    id: 'cursor', name: 'Cursor', cli: 'cursor',
    docs: 'https://cursor.com/docs/context/mcp',
    appDirs: (env) => [home(env, '.cursor')],
    stateFile: (env) => home(env, '.cursor', 'mcp.json'), stateKind: 'json', stateOf: mcpServersState,
    setup: (launch, env) => ({
      blocks: [{ label: 'Add to ~/.cursor/mcp.json', text: mcpServersJson(launch, { type: 'stdio' }) }],
      steps: [`Merge it into ${home(env, '.cursor', 'mcp.json')} (all projects) or .cursor/mcp.json inside one project; create the file if it does not exist.`, 'Then restart Cursor.'],
    }),
  },
  {
    id: 'vscode', name: 'VS Code (Copilot)', cli: 'code',
    docs: 'https://code.visualstudio.com/docs/copilot/reference/mcp-configuration',
    appDirs: (env) => [env.vscodeUserRoot],
    stateFile: () => null,
    setup: (launch, env) => {
      const blocks = [];
      const def = { name: 'trafficdrive', type: 'stdio', ...entry(launch) };
      // A JSON argument needs quoting that differs per shell; only the POSIX form is dependable, so Windows gets the file route.
      if (env.platform !== 'win32') blocks.push({ label: 'Run once in a terminal (adds it to your VS Code user profile)', text: `code --add-mcp ${posixSingle(JSON.stringify(def))}` });
      blocks.push({ label: 'Or save as .vscode/mcp.json in a project (VS Code uses "servers", not "mcpServers")', text: json({ servers: { trafficdrive: { type: 'stdio', ...entry(launch) } } }) });
      return { blocks, steps: ['Or in VS Code: Command Palette → "MCP: Add Server" → Command (stdio).'] };
    },
  },
  {
    id: 'antigravity', name: 'Antigravity',
    docs: 'https://antigravity.google/docs/mcp',
    // Shares ~/.gemini with Gemini CLI, so only Antigravity's own folders count as "installed".
    appDirs: (env) => [home(env, '.gemini', 'antigravity'), home(env, '.gemini', 'antigravity-ide'), home(env, '.gemini', 'antigravity-cli'),
      env.platform === 'darwin' && '/Applications/Antigravity.app', env.platform === 'win32' && env.join(env.localappdata, 'Programs', 'Antigravity')],
    stateFile: (env) => home(env, '.gemini', 'config', 'mcp_config.json'), stateAlso: (env) => [home(env, '.gemini', 'antigravity', 'mcp_config.json')], stateKind: 'json', stateOf: mcpServersState,
    setup: (launch, env) => ({
      blocks: [{ label: 'Add to mcp_config.json', text: mcpServersJson(launch) }],
      steps: ['In Antigravity: the "…" menu at the top of the agent panel → MCP Servers → Manage MCP Servers → View raw config. Merge this under "mcpServers" and save.',
        `Global file: ${home(env, '.gemini', 'config', 'mcp_config.json')} (older versions: ${home(env, '.gemini', 'antigravity', 'mcp_config.json')}). For one project use .agents/mcp_config.json.`],
    }),
  },
  {
    id: 'cline', name: 'Cline', cli: 'cline', extPrefix: 'saoudrizwan.claude-dev',
    docs: 'https://docs.cline.bot/mcp/configuring-mcp-servers',
    // The doc gives the CLI's file; the VS Code extension's file is reached through its UI.
    stateFile: (env) => home(env, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), stateKind: 'json', stateOf: mcpServersState,
    setup: (launch, env) => {
      const blocks = [{ label: 'Add under "mcpServers"', text: mcpServersJson(launch, { disabled: false, autoApprove: [] }) }];
      // The documented CLI form has no environment flag, so offer it only when the server needs no environment.
      if (!hasEnv(launch)) blocks.push({ label: 'Cline CLI one-liner', text: `cline mcp add trafficdrive --yes -- ${shellQuote(launch.command, env.platform)} ${shellQuote(launch.args[0], env.platform)}` });
      return { blocks, steps: ['In the Cline panel: MCP Servers icon → Configure tab → "Configure MCP Servers", merge this in and save.', `Cline CLI users: the file is ${home(env, '.cline', 'data', 'settings', 'cline_mcp_settings.json')}.`] };
    },
  },
  {
    id: 'roo', name: 'Roo Code', extPrefix: 'rooveterinaryinc.roo-cline',
    docs: 'https://docs.roocode.com/features/mcp/using-mcp-in-roo',
    stateFile: () => null,
    setup: (launch) => ({
      blocks: [{ label: 'Add under "mcpServers"', text: mcpServersJson(launch) }],
      steps: ['In the Roo Code panel open the MCP settings and use "Edit Global MCP" (all projects), or save it as .roo/mcp.json inside a project (the project file wins on a name clash).'],
    }),
  },
  {
    id: 'gemini', name: 'Gemini CLI', cli: 'gemini', cliVersion: true,
    docs: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md',
    appDirs: (env) => [], // ~/.gemini is shared with Antigravity, so it is not evidence of Gemini CLI by itself
    stateFile: (env) => home(env, '.gemini', 'settings.json'), stateKind: 'json', stateOf: mcpServersState,
    setup: (launch, env) => ({
      blocks: [
        { label: 'Run once in a terminal', text: `gemini mcp add -s user ${envFlags(launch, '-e')}trafficdrive ${shellQuote(launch.command, env.platform)} ${shellQuote(launch.args[0], env.platform)}` },
        { label: `Or add to ${home(env, '.gemini', 'settings.json')}`, text: mcpServersJson(launch) },
      ],
      steps: ['The command uses "-s user" so it works in every folder — without it Gemini CLI saves the server for the current project only.'],
    }),
  },
  {
    id: 'codex', name: 'Codex CLI', cli: 'codex', cliVersion: true,
    docs: 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli',
    appDirs: (env) => [env.codexHome],
    stateFile: (env) => env.join(env.codexHome, 'config.toml'), stateKind: 'toml', stateOf: codexState,
    setup: (launch, env) => {
      const toml = [`[mcp_servers.trafficdrive]`, `command = ${tomlStr(launch.command)}`, `args = [${launch.args.map(tomlStr).join(', ')}]`];
      if (hasEnv(launch)) { toml.push('', '[mcp_servers.trafficdrive.env]'); Object.entries(launch.env).forEach(([k, v]) => toml.push(`${k} = ${tomlStr(v)}`)); }
      return {
        blocks: [
          { label: 'Run once in a terminal', text: `codex mcp add trafficdrive ${envFlags(launch, '--env')}-- ${shellQuote(launch.command, env.platform)} ${shellQuote(launch.args[0], env.platform)}` },
          { label: `Or add to ${env.join(env.codexHome, 'config.toml')}`, text: toml.join('\n') },
        ],
        steps: [],
      };
    },
  },
  {
    id: 'zed', name: 'Zed', cli: 'zed',
    docs: 'https://zed.dev/docs/ai/mcp',
    appDirs: (env) => [env.platform === 'win32' ? env.join(env.appdata, 'Zed') : home(env, '.config', 'zed')],
    stateFile: () => null,
    setup: (launch) => ({
      blocks: [{ label: 'Add to Zed settings.json', text: json({ context_servers: { trafficdrive: entry(launch) } }) }],
      steps: ['In Zed run "zed: open settings file" and merge this in — or Settings → AI → MCP Servers → Add Server → Add Local Server.'],
    }),
  },
  {
    id: 'continue', name: 'Continue', extPrefix: 'continue.continue',
    docs: 'https://docs.continue.dev/customize/deep-dives/mcp',
    appDirs: (env) => [home(env, '.continue')],
    stateFile: () => null,
    setup: (launch) => {
      const y = ['name: TrafficDrive', 'version: 0.0.1', 'schema: v1', 'mcpServers:', '  - name: trafficdrive', '    type: stdio', `    command: ${yamlStr(launch.command)}`, '    args:'];
      launch.args.forEach((a) => y.push(`      - ${yamlStr(a)}`));
      if (hasEnv(launch)) { y.push('    env:'); Object.entries(launch.env).forEach(([k, v]) => y.push(`      ${k}: ${yamlStr(v)}`)); }
      return { blocks: [{ label: 'Save as .continue/mcpServers/trafficdrive.yaml in your project', text: y.join('\n') }], steps: ['Create the .continue/mcpServers folder at the top level of your workspace if it does not exist.'] };
    },
  },
  {
    id: 'lmstudio', name: 'LM Studio',
    docs: 'https://lmstudio.ai/docs/app/mcp',
    appDirs: (env) => [home(env, '.lmstudio')],
    stateFile: () => null,
    setup: (launch) => {
      // The doc: copy only what sits inside the existing "mcpServers": { … } braces.
      const inner = json({ trafficdrive: entry(launch) }).split('\n').slice(1, -1).map((l) => l.replace(/^ {2}/, '')).join('\n');
      return { blocks: [{ label: 'Add inside "mcpServers" in mcp.json', text: inner }], steps: ['In LM Studio: Program tab → Install → Edit mcp.json. Paste this between the braces of "mcpServers" (add a comma after any entry already there).'] };
    },
  },
  {
    id: 'kiro', name: 'Kiro', cli: 'kiro',
    docs: 'https://kiro.dev/docs/mcp/configuration/',
    appDirs: (env) => [home(env, '.kiro')],
    stateFile: (env) => home(env, '.kiro', 'settings', 'mcp.json'), stateKind: 'json', stateOf: mcpServersState,
    setup: (launch, env) => ({
      blocks: [{ label: 'Add to ~/.kiro/settings/mcp.json', text: mcpServersJson(launch) }],
      steps: [`File: ${home(env, '.kiro', 'settings', 'mcp.json')} (or .kiro/settings/mcp.json for one workspace). Kiro applies the change when you save the file.`],
    }),
  },
  {
    id: 'json', name: 'Other (JSON)', generic: true,
    setup: (launch) => ({
      blocks: [{ label: 'MCP server definition', text: mcpServersJson(launch) }],
      steps: ['For any other MCP client: add this server definition to its MCP configuration — the command, arguments and environment are what matter.'],
    }),
  },
];

module.exports = { CLIENTS, shellQuote, entryState };
