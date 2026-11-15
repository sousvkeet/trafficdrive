#!/usr/bin/env node
// scripts/smoke-packaged.js — proves that a *packaged* TrafficDrive really starts and works, before it is released.
//
//   node scripts/smoke-packaged.js <TrafficDrive.exe> [options]
//
// What it does, with the real executable (no mocks):
//   1. MCP server  — runs `<exe> mcp-server.js` the way an AI assistant would (ELECTRON_RUN_AS_NODE, no Node
//                    install needed) and speaks the protocol to it: tools, resources, prompts, get_status.
//   2. Desktop app — starts the app itself, waits for it to publish its connection file, then calls its API:
//                    health, the assistant list, and the skill download (must be a real zip).
//   3. Attach      — starts a second MCP server in "connect" mode and checks it attaches to the running app.
//
// Options
//   --app-dir <dir>          folder holding mcp-server.js (default: <exe folder>/resources/app)
//   --electron-arg <arg>     extra argument for the desktop app (repeatable; used to run a dev checkout)
//   --expect-runtime <name>  value launch.runtime must have (e.g. packaged-app)
//   --skip-gui               only run step 1
// Exit code 0 = everything passed.
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const exe = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const optAll = (name) => argv.reduce((acc, a, i) => (a === name ? acc.concat(argv[i + 1]) : acc), []);
if (!exe || !fs.existsSync(exe)) { console.error('Usage: node scripts/smoke-packaged.js <path to TrafficDrive.exe> [options]\nExecutable not found: ' + exe); process.exit(2); }
const exePath = path.resolve(exe);
const appDir = path.resolve(opt('--app-dir') || path.join(path.dirname(exePath), 'resources', 'app'));
const guiArgs = optAll('--electron-arg');
const expectRuntime = opt('--expect-runtime');
const skipGui = argv.includes('--skip-gui');

const results = [];
const ok = (cond, name, extra) => { results.push(!!cond); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined && extra !== '' ? '  — ' + String(extra).slice(0, 200) : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `td-smoke-${label}-`));

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
  } catch (_) {}
}

// Minimal MCP client over stdio: send requests, collect replies by id.
function mcpSession(args, env, label) {
  const child = spawn(exePath, [path.join(appDir, 'mcp-server.js'), ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = '', stderr = '';
  const waiting = new Map();
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  let nextId = 1;
  const request = (method, params, timeoutMs = 60000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${label}: no answer to ${method} in ${timeoutMs / 1000}s. stderr: ${stderr.slice(-300)}`)); }, timeoutMs);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  return { child, request, notify, exited, stderr: () => stderr, close: () => killTree(child) };
}
async function handshake(s) {
  const init = await s.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  s.notify('notifications/initialized');
  return init;
}

function httpGet(url, token, asBuffer) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: token ? { 'X-TD-Token': token } : {}, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const body = Buffer.concat(chunks); resolve({ status: res.statusCode, body: asBuffer ? body : body.toString('utf8') }); });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}
const getJson = async (url, token) => { const r = await httpGet(url, token); return { status: r.status, json: JSON.parse(r.body) }; };

(async () => {
  console.log(`executable: ${exePath}\napp folder: ${appDir}\n`);
  ok(fs.existsSync(path.join(appDir, 'mcp-server.js')) && fs.existsSync(path.join(appDir, 'skills', 'trafficdrive', 'SKILL.md')), 'the app folder contains mcp-server.js and the skills/trafficdrive files');

  console.log('\n── 1. the MCP server, started by the packaged executable');
  const dataA = tmp('mcp');
  const m1 = mcpSession(['--mode', 'embedded', '--port', '0'], { TD_DATA_DIR: dataA, TD_NO_CONNECTION_FILE: '1' }, 'mcp');
  try {
    const init = await handshake(m1);
    ok(init.result && init.result.serverInfo && /trafficdrive/i.test(init.result.serverInfo.name), 'it answers the MCP handshake', init.result && JSON.stringify(init.result.serverInfo));
    const tools = (await m1.request('tools/list', {})).result.tools;
    const resources = (await m1.request('resources/list', {})).result.resources;
    const prompts = (await m1.request('prompts/list', {})).result.prompts;
    ok(tools.length >= 40 && resources.length >= 10 && prompts.length >= 5, 'it lists its tools, resources and prompts', `${tools.length} tools, ${resources.length} resources, ${prompts.length} prompts`);
    const st = (await m1.request('tools/call', { name: 'get_status', arguments: {} })).result;
    ok(st && !st.isError && st.structuredContent && st.structuredContent.connection && st.structuredContent.connection.mode === 'embedded', 'a tool call works against its own backend', st && st.structuredContent && JSON.stringify(st.structuredContent.connection));
  } catch (e) { ok(false, 'the MCP server runs from the packaged executable', e.message); }
  m1.close();

  if (!skipGui) {
    console.log('\n── 2. the desktop app itself');
    const dataB = tmp('app');
    const apiFile = path.join(dataB, 'api.json');
    const appEnv = { ...process.env, TD_DATA_DIR: dataB };
    delete appEnv.ELECTRON_RUN_AS_NODE;   // must be absent (not just empty) so Electron runs the app, not plain Node
    const app = spawn(exePath, guiArgs, { env: appEnv, stdio: 'ignore', windowsHide: false });
    let appExited = null; app.on('exit', (c) => { appExited = c; });
    let info = null;
    for (let i = 0; i < 180 && !info && appExited === null; i++) {
      await sleep(500);
      try { const j = JSON.parse(fs.readFileSync(apiFile, 'utf8')); if (j && j.url && j.token) info = j; } catch (_) {}
    }
    ok(!!info, 'the app starts and publishes its connection file', info ? info.url : (appExited !== null ? `the app exited early (code ${appExited})` : 'timed out after 90 s'));
    if (info) {
      try {
        const health = await getJson(info.url + '/api/health', info.token);
        ok(health.status === 200 && health.json.success, 'its backend answers /api/health', JSON.stringify({ v: health.json.version, platform: health.json.platform }));
        const noToken = await httpGet(info.url + '/api/health');
        ok(noToken.status === 401, 'and refuses requests without the API token (401)', noToken.status);
        const mi = await getJson(info.url + '/api/mcp/info', info.token);
        if (expectRuntime) ok(mi.json.launch && mi.json.launch.runtime === expectRuntime, `the app reports how assistants should launch its MCP server (runtime "${expectRuntime}")`, mi.json.launch && mi.json.launch.runtime);
        ok(mi.json.launch && mi.json.launch.env && mi.json.launch.env.ELECTRON_RUN_AS_NODE === '1' && fs.existsSync(mi.json.launch.command) && fs.existsSync(mi.json.launch.args[0]), 'the launch command it gives assistants points at files that exist (no Node.js needed)', mi.json.launch && mi.json.launch.command);
        const det = await getJson(info.url + '/api/mcp/detect', info.token);
        ok(det.json.success && det.json.assistants.length >= 14 && det.json.skill && det.json.skill.files >= 3, 'assistant detection works and the skill files are bundled', det.json.skill && JSON.stringify(det.json.skill));
        const src = await getJson(info.url + '/api/proxies/sources', info.token);
        ok(src.json.success && src.json.sources.length >= 8 && src.json.sources.every((x) => x.builtin && x.enabled), 'the proxy sources are listed (the built-in ones, switched on)', `${src.json.sources.length} sources`);
        const pl = await getJson(info.url + '/api/proxies?limit=10', info.token);
        ok(pl.json.success && pl.json.stats && pl.json.stats.total === 0, 'the proxy list answers (empty on a fresh start)', JSON.stringify(pl.json.stats));
        const zip = await httpGet(info.url + '/api/mcp/skill.zip', info.token, true);
        ok(zip.status === 200 && zip.body.slice(0, 2).toString() === 'PK' && zip.body.length > 1000, 'the skill download is a real zip', `${zip.status}, ${zip.body.length} bytes`);

        console.log('\n── 3. an MCP client attaching to the running app');
        const m2 = mcpSession(['--mode', 'connect'], { TD_DATA_DIR: dataB }, 'mcp-connect');
        try {
          await handshake(m2);
          const st2 = (await m2.request('tools/call', { name: 'get_status', arguments: {} })).result;
          const conn = st2 && st2.structuredContent && st2.structuredContent.connection;
          ok(conn && conn.mode === 'connect' && /running TrafficDrive app/.test(conn.source), 'the MCP server attaches to the running desktop app', conn && JSON.stringify(conn));
        } catch (e) { ok(false, 'the MCP server attaches to the running desktop app', e.message); }
        m2.close();
      } catch (e) { ok(false, 'the desktop app answers its API', e.message); }
    }
    killTree(app);
    await sleep(500);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} smoke checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('SMOKE TEST ERROR', e); process.exit(2); });
