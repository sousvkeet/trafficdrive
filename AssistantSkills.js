// AssistantSkills.js — where each AI assistant keeps "skills", and the instructions the AI Assistant page shows for
// installing TrafficDrive's skill (the skills/trafficdrive folder) into it.
//
// Pure data and string building (no I/O). server.js reads the files and works out whether the skill is already
// installed; this module only describes where to look and what to tell the user.
//
// Every location below was taken from the assistant's own documentation (linked in `docs`) when this was written —
// the skills ecosystem moves fast, so a doc link is always shown. Where an assistant has no documented skills
// folder, nothing is invented: Continue only documents "rules" (so the SKILL.md text is offered as a rule) and
// LM Studio documents skills only for its Bionic agent (so the page points to Settings → Skills).
//
//   kind 'folder' — the assistant loads <skills dir>/<name>/SKILL.md; the page offers the .zip and a command
//   kind 'upload' — Claude Desktop: the .zip itself is uploaded in the app
//   kind 'app'    — added through the app's own settings screen
//   kind 'rules'  — no skills feature documented; the SKILL.md text is copied into a rules file
'use strict';

const SKILL_NAME = 'trafficdrive';
const ZIP_NAME = 'trafficdrive-skill.zip';
const AGENTS_DIR = ['.agents', 'skills'];   // the cross-agent location several assistants read

const SKILLS = {
  claudeCode: {
    kind: 'folder', personal: ['.claude', 'skills'], project: '.claude/skills',
    docs: 'https://code.claude.com/docs/en/skills',
    after: ['Start a new session, then type /trafficdrive to check that it loaded.'],
  },
  claudeDesktop: {
    kind: 'upload', docs: 'https://claude.com/docs/skills/how-to',
  },
  cursor: {
    kind: 'folder', personal: ['.cursor', 'skills'], project: '.cursor/skills',
    docs: 'https://cursor.com/docs/skills',
  },
  vscode: {
    kind: 'folder', personal: ['.copilot', 'skills'], project: '.github/skills',
    docs: 'https://code.visualstudio.com/docs/agent-customization/agent-skills',
  },
  antigravity: {
    kind: 'folder', personal: ['.gemini', 'config', 'skills'], project: '.agents/skills',
    docs: 'https://antigravity.google/docs/skills',
    after: ['This personal folder is shared by the Antigravity app, CLI and IDE.'],
  },
  cline: {
    kind: 'folder', personal: ['.cline', 'skills'], project: '.cline/skills',
    docs: 'https://docs.cline.bot/customization/skills',
    after: ['Cline lists discovered skills in its Skills menu (the scale icon at the bottom of the Cline panel → Skills tab), where each one can be switched on or off.'],
  },
  roo: {
    kind: 'folder', personal: ['.roo', 'skills'], also: [AGENTS_DIR], project: '.roo/skills',
    docs: 'https://docs.roocode.com/features/skills',
  },
  gemini: {
    kind: 'folder', personal: ['.gemini', 'skills'], also: [AGENTS_DIR], project: '.gemini/skills',
    docs: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md',
    after: ['Gemini CLI also reads ~/.agents/skills. In a session run /skills reload, then /skills list to check that TrafficDrive is listed.'],
  },
  codex: {
    kind: 'folder', personal: AGENTS_DIR, project: '.agents/skills',
    docs: 'https://learn.chatgpt.com/docs/build-skills',
  },
  zed: {
    kind: 'folder', personal: AGENTS_DIR, project: '.agents/skills',
    docs: 'https://zed.dev/docs/ai/skills',
    after: ['Project skills load only from trusted worktrees.'],
  },
  continue: {
    kind: 'rules', docs: 'https://docs.continue.dev/customize/deep-dives/rules',
  },
  lmstudio: {
    kind: 'app', docs: 'https://lmstudio.ai/docs/bionic/agent/skills',
  },
  kiro: {
    kind: 'folder', personal: ['.kiro', 'skills'], project: '.kiro/skills',
    docs: 'https://kiro.dev/docs/skills/',
    after: ['Global skills work in the Kiro IDE and CLI. Custom agents only see skills listed in their "resources", for example "skill://.kiro/skills/**/SKILL.md".'],
  },
  json: {
    kind: 'folder', personal: AGENTS_DIR, project: '.agents/skills', copyText: true,
    docs: 'https://agentskills.io/specification',
    after: [
      'That folder is read by Codex, Gemini CLI, Cursor, Roo Code and Zed (each according to its own documentation).',
      'An assistant without skills support can still use the guidance: copy the SKILL.md text from the block above into its custom instructions or rules file.',
    ],
  },
};

// The personal skill folders (as path segments below the home directory) where an installed copy would be.
function candidates(id) {
  const d = SKILLS[id];
  if (!d || d.kind !== 'folder') return [];
  return [d.personal, ...(d.also || [])];
}

// ctx: { platform, name, skillMd, state ('none'|'current'|'stale'|'unknown'), available (false if the build has no skill files) }
function skillSetup(id, ctx) {
  const def = SKILLS[id];
  if (!def) return null;
  const win = ctx.platform === 'win32';
  const sep = win ? '\\' : '/';
  const shown = (segs) => (win ? '%USERPROFILE%\\' : '~/') + segs.join(sep);
  const inCmd = (segs) => (win ? '"$HOME\\' + segs.join('\\') + '"' : '"$HOME/' + segs.join('/') + '"');
  const out = { id, kind: def.kind, state: ctx.state || 'unknown', zip: def.kind !== 'rules', docs: def.docs, available: ctx.available !== false, personal: null, project: null, blocks: [], steps: [] };

  if (!out.available) {
    out.zip = false;
    out.steps = ['The skill files are not included in this build of TrafficDrive.'];
    return out;
  }

  if (def.kind === 'folder') {
    const dest = inCmd(def.personal);
    const zip = win ? `"$HOME\\Downloads\\${ZIP_NAME}"` : `"$HOME/Downloads/${ZIP_NAME}"`;
    out.personal = shown(def.personal) + sep + SKILL_NAME;
    out.project = `${def.project}/${SKILL_NAME}`;
    out.blocks.push({
      label: win ? 'Then run in PowerShell' : 'Then run in a terminal',
      text: win ? `New-Item -ItemType Directory -Force ${dest} | Out-Null; Expand-Archive -Force ${zip} ${dest}` : `mkdir -p ${dest} && unzip -o ${zip} -d ${dest}`,
    });
    out.steps.push(`Press "Download skill (.zip)", then run the command shown above. It unpacks into ${out.personal} — your personal skills, available in every project.`);
    out.steps.push(`The command looks for the file in your Downloads folder; change the path if you saved it elsewhere.${win ? '' : ' (No unzip? Extract the file with any archive tool so that the "trafficdrive" folder ends up inside that directory.)'}`);
    out.steps.push(`To use it in one project only, unpack into ${def.project}/ inside that project instead.`);
    (def.after || []).forEach((s) => out.steps.push(s));
    out.steps.push(`If TrafficDrive does not show up, restart ${ctx.name || 'the assistant'}.`);
  } else if (def.kind === 'upload') {
    out.steps = [
      'Press "Download skill (.zip)" and keep the file as it is — do not unpack it.',
      'In Claude Desktop open Customize → Skills, press "+", then "+ Create skill", choose "Upload a skill" and select the downloaded .zip.',
      'Switch the skill on in your skills list.',
      'Uploading needs "Code execution and file creation" (called "Create and edit files" in newer versions) switched on under Settings → Capabilities. On Team and Enterprise plans an owner must allow skills.',
      'Skills added here are separate from the ones Claude Code uses.',
    ];
  } else if (def.kind === 'app') {
    out.steps = [
      "Skills are documented for LM Studio's agent, Bionic. Press \"Download skill (.zip)\", unpack it, then add the extracted skill in Settings → Skills.",
      'Alternatively install the skill for Claude Code or Codex and turn on Settings → Skills → "Use skills found in other apps".',
      "The documentation doesn't say whether skills also apply to regular LM Studio chat.",
    ];
  } else if (def.kind === 'rules') {
    out.blocks.push({ label: 'Save as .continue/rules/trafficdrive.md in your workspace', text: ctx.skillMd || '', hidden: true });
    out.steps = [
      "Continue's documentation describes rules, not skills, so it cannot load the skill folder. The closest match is a rule: press Copy on the block above, then save the text in a file named .continue/rules/trafficdrive.md at the top of your workspace.",
      "TrafficDrive's tools work the same without it; the rule only adds the usage guidance.",
    ];
  }

  if (def.copyText) {
    out.blocks.push({ label: 'SKILL.md text (for assistants without skills support)', text: ctx.skillMd || '', hidden: true });
  }
  return out;
}

module.exports = { SKILLS, SKILL_NAME, ZIP_NAME, candidates, skillSetup };
