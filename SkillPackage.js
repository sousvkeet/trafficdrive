// SkillPackage.js — collects a skill folder and packs it into a .zip, in memory, with no dependencies.
//
// Why this exists: AI assistants want the skill as a folder (Claude Code, Cursor, Codex, …) or, for Claude Desktop,
// as a .zip whose TOP LEVEL is the skill folder ("trafficdrive/SKILL.md", never a bare SKILL.md). Building the
// archive here means the dashboard can offer one download that works everywhere — including a packaged app whose
// files sit inside app.asar, where a shell `cp` or `zip` cannot read them (Electron's patched fs can).
//
// The archive follows what `zip -r` produces: forward-slash names, explicit directory entries, UTF-8 names,
// Unix permissions in the attributes, deflate for files it makes smaller.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

// Every regular file under `dir`, as { path: 'a/b.md' (relative, forward slashes), data: Buffer, mtime: Date },
// in a stable order so the same folder always yields the same archive. Dot-files and node_modules are skipped.
function collectFiles(dir) {
  const out = [];
  let total = 0;
  (function walk(abs, rel) {
    const names = fs.readdirSync(abs).sort();
    for (const name of names) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = path.join(abs, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, relPath);
      else if (st.isFile()) {
        const data = fs.readFileSync(full);
        total += data.length;
        if (out.length >= MAX_FILES || total > MAX_TOTAL_BYTES) throw new Error('The skill folder is unexpectedly large');
        out.push({ path: relPath, data, mtime: st.mtime });
      }
    }
  })(dir, '');
  return out;
}

// ── CRC-32 (the zip checksum) ─────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const date = d instanceof Date && !isNaN(d) ? d : new Date();
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// Build a zip whose single top-level folder is `rootName`, holding `files` (as returned by collectFiles).
function buildZip(rootName, files) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(rootName)) throw new Error('Invalid skill folder name');
  const entries = [];   // { name, data, method, crc, mtime, dir }
  const seenDirs = new Set();
  const addDir = (name, mtime) => { if (!seenDirs.has(name)) { seenDirs.add(name); entries.push({ name: name + '/', data: Buffer.alloc(0), method: 0, crc: 0, csize: 0, usize: 0, mtime, dir: true }); } };
  const newest = files.reduce((m, f) => (f.mtime > m ? f.mtime : m), new Date(0));
  addDir(rootName, newest);
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) addDir(`${rootName}/${parts.slice(0, i).join('/')}`, f.mtime);
    const deflated = zlib.deflateRawSync(f.data, { level: 9 });
    const useDeflate = deflated.length < f.data.length;
    entries.push({ name: `${rootName}/${f.path}`, data: useDeflate ? deflated : f.data, method: useDeflate ? 8 : 0, crc: crc32(f.data), csize: useDeflate ? deflated.length : f.data.length, usize: f.data.length, mtime: f.mtime, dir: false });
  }

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const { time, date } = dosDateTime(e.mtime);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(e.method, 8);
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(e.crc, 14); lh.writeUInt32LE(e.csize, 18); lh.writeUInt32LE(e.usize, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, e.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(e.method, 10);
    ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(e.crc, 16); ch.writeUInt32LE(e.csize, 20); ch.writeUInt32LE(e.usize, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE((((e.dir ? 0o040755 : 0o100644) << 16) | (e.dir ? 0x10 : 0)) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + e.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cd, end]);
}

module.exports = { collectFiles, buildZip, crc32 };
