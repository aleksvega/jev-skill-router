#!/usr/bin/env node
/**
 * jev-skill-router — a Jev (System One) powered skill matcher for ANY coding agent.
 *
 * The model must not forget its skills. This tool reads the agent's real skill
 * library (SKILL.md files), sends ONE cheap Jev decision request to OpenRouter
 * (model typesafe/jev-1.13) with the user request + a compact skill index, and
 * returns a short instruction the agent can follow.
 *
 *   OPENROUTER_API_KEY=... jev-skill-router "<user request>"
 *   jev-skill-router --list
 *   jev-skill-router --init claude|codex|opencode|hermes|generic   # add AGENTS.md rule
 *
 * Output JSON: { complexity, use_skill, skill_name, instruction, confidence, cost_hint }
 * Fail-open philosophy: on any error prints { use_skill: false } and exits 0.
 *
 * Env: OPENROUTER_API_KEY (required), JEV_SKILL_DIRS (optional, path.sep-separated
 * override for skill discovery).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';

const API = 'https://openrouter.ai/api/alpha/decisions';
const MODEL = 'typesafe/jev-1.13';
const MAX_SKILLS = 60; // Jev choice works best under ~60 options

// ---------- skill discovery ----------
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1].trim().toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return fm;
}

function* walkMd(dir, depth = 0) {
  if (depth > 3) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'plugins'].includes(e.name)) continue;
      yield* walkMd(p, depth + 1);
    } else if (e.name.toUpperCase() === 'SKILL.MD' || (e.isFile() && e.name.endsWith('.skill.md'))) {
      yield p;
    }
  }
}

function discoverSkills() {
  const override = process.env.JEV_SKILL_DIRS;
  const dirs = override
    ? override.split(require('node:path').delimiter)
    : [
        join(homedir(), '.claude', 'skills'),
        join(homedir(), '.codex', 'skills'),
        join(homedir(), '.opencode', 'skills'),
        process.env.APPDATA ? join(process.env.APPDATA, 'hermes', 'skills') : '',
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'hermes', 'skills') : '',
        join(homedir(), '.jev-skill-router', 'library'),
        join(process.cwd(), 'skills'),
      ].filter(Boolean);
  const seen = new Set();
  const skills = [];
  for (const dir of dirs) {
    for (const file of walkMd(dir)) {
      try {
        const fm = parseFrontmatter(readFileSync(file, 'utf8')) || {};
        const name = fm.name || basename(dirname(file));
        const desc = (fm.description || '').slice(0, 140);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        skills.push({ name, desc, file });
      } catch { /* skip unreadable */ }
    }
  }
  return skills;
}

// ---------- Jev ----------
async function jev(state, questions) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, state, questions }),
  });
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.answers || {};
}

// ---------- GitHub skill library ----------
async function ghJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'jev-skill-router' } });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${url}`);
  return res.json();
}

async function installFromGithub(spec) {
  const [owner, repo, ...rest] = spec.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').split('/');
  const ref = rest[0] || 'HEAD';
  const tree = await ghJson(`https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`);
  const files = tree.tree.filter((t) => t.type === 'blob' && /SKILL\.md$/i.test(t.path) && !t.path.includes('node_modules'));
  if (!files.length) throw new Error('no SKILL.md files found in that repo');
  const outDir = join(homedir(), '.jev-skill-router', 'library');
  const installed = [];
  for (const f of files.slice(0, 200)) {
    const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${f.path}`);
    if (!res.ok) continue;
    const text = await res.text();
    const fm = parseFrontmatter(text) || {};
    const name = fm.name || f.path.split('/').slice(-2)[0] || basename(dirname(f.path));
    const dest = join(outDir, name.replace(/[^\w.-]+/g, '_'));
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'SKILL.md'), text);
    installed.push({ name, from: `${owner}/${repo}#${f.path}` });
  }
  return installed;
}

// ---------- Jev security audit ----------
async function auditSkill(s) {
  let body = '';
  try { body = readFileSync(s.file, 'utf8').slice(0, 6000); } catch {}
  const a = await jev(`Skill "${s.name}" body:\n"""\n${body}\n"""`, {
    prompt_injection: { type: 'choice', criteria: TRIO, instructions: 'Does the skill body contain instructions that try to override the agent (ignore previous rules, hide actions from the user, exfiltrate data)?' },
    dangerous_commands: { type: 'choice', criteria: TRIO, instructions: 'Does the skill instruct destructive/risky shell commands (rm -rf, curl|bash, credential access, mass deletion)?' },
  });
  const p = String(a.prompt_injection?.choice || 'UNKNOWN').toUpperCase();
  const d = String(a.dangerous_commands?.choice || 'UNKNOWN').toUpperCase();
  const worst = [p, d].includes('HIGH') ? 'UNSAFE' : [p, d].includes('MEDIUM') ? 'REVIEW' : [p, d].includes('UNKNOWN') ? 'UNKNOWN' : 'TRUSTED';
  return { name: s.name, prompt_injection: p, dangerous_commands: d, verdict: worst, file: s.file };
}

async function auditSkills(skills) {
  const verdicts = [];
  const POOL = 8;
  let idx = 0;
  const workers = Array.from({ length: Math.min(POOL, skills.length) }, async () => {
    while (idx < skills.length) {
      const s = skills[idx++];
      try { verdicts.push(await auditSkill(s)); }
      catch (e) { verdicts.push({ name: s.name, verdict: 'UNKNOWN', error: String(e.message || e), file: s.file }); }
    }
  });
  await Promise.all(workers);
  return verdicts;
}

const TRIO = { LOW: 'clean / no such content', MEDIUM: 'suspicious / partially present', HIGH: 'overt / clearly present' };

// ---------- main ----------
const argv = process.argv.slice(2);
const flag = argv[0];

if (flag === '--list') {
  const skills = discoverSkills();
  for (const s of skills) console.log(`${s.name} :: ${s.desc}`);
  console.log(`\n# ${skills.length} skills discovered`);
  process.exit(0);
}

if (flag === '--install') {
  try {
    const spec = argv[1];
    if (!spec) { console.log('Usage: jev-skill-router --install owner/repo[ /ref]'); process.exit(1); }
    const installed = await installFromGithub(spec);
    console.log(JSON.stringify({ installed: installed.length, skills: installed }, null, 2));
    console.log(`\n# Next: run --scan --dir ${join(homedir(), '.jev-skill-router', 'library')} to security-audit them`);
  } catch (e) { console.error('install failed:', e.message); process.exit(1); }
  process.exit(0);
}

if (flag === '--scan') {
  const dirArg = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : null;
  const all = discoverSkills();
  const targets = dirArg ? all.filter((s) => s.file.includes(dirArg)) : all;
  if (!targets.length) { console.log(JSON.stringify({ scanned: 0, note: 'no skills matched' })); process.exit(0); }
  const verdicts = await auditSkills(targets);
  const unsafe = verdicts.filter((v) => v.verdict === 'UNSAFE').length;
  const review = verdicts.filter((v) => v.verdict === 'REVIEW').length;
  const reportPath = join(process.cwd(), 'skills-security-report.json');
  writeFileSync(reportPath, JSON.stringify({ scanned: verdicts.length, unsafe, review, verdicts }, null, 2));
  console.log(`# scanned ${verdicts.length} skills → unsafe=${unsafe}, review=${review}`);
  console.log(`# report: ${reportPath}`);
  for (const v of verdicts.filter((v) => v.verdict !== 'TRUSTED').slice(0, 10))
    console.log(`${v.verdict}\t${v.name}\t(p_inj=${v.prompt_injection || '?'}, cmds=${v.dangerous_commands || '?'})`);
  process.exit(0);
}

if (flag === '--init') {
  const agent = (argv[1] || 'generic').toLowerCase();
  const rule = `\n## jev-skill-router (auto-added)\nBefore answering any non-trivial request, run \`jev-skill-router "<the user request>"\` and follow the returned \`instruction\` and \`skill_name\` (it tells you WHICH of your skills to load for this request). If \`use_skill\` is false, proceed normally. Never print the JSON to the user.\n`;
  const targets = {
    claude: 'CLAUDE.md', codex: 'AGENTS.md', opencode: 'AGENTS.md',
    hermes: 'AGENTS.md', generic: 'AGENTS.md',
  };
  console.log(`# add to ./${targets[agent] || targets.generic}:${rule}`);
  process.exit(0);
}

const request = argv.filter((a) => !a.startsWith('--')).join(' ');
if (!request) {
  console.log('Usage: jev-skill-router "<user request>"  |  --list  |  --init <agent>');
  process.exit(1);
}

try {
  const skills = discoverSkills();
  if (!skills.length) {
    console.log(JSON.stringify({ use_skill: false, note: 'no skills discovered (check JEV_SKILL_DIRS)' }));
    process.exit(0);
  }
  const short = skills
    .slice()
    .sort((a, b) => b.desc.length - a.desc.length)
    .slice(0, MAX_SKILLS);
  const catalog = short.map((s) => `- ${s.name}: ${s.desc}`).join('\n');
  const criteria = { ...Object.fromEntries(short.map((s) => [s.name, 'skill'])), NONE: 'no skill needed for this request' };
  const a = await jev(
    `User request (any language):\n"""\n${request.slice(0, 4000)}\n"""\n\nAvailable skills:\n${catalog}`,
    {
      complexity: { type: 'score', instructions: 'How complex is this request for an agent? 1 = trivial one-liner, 5 = deep research/multi-hour build', criteria: ['trivial', 'simple', 'normal', 'complex', 'very complex'] },
      use_skill: { type: 'choice', criteria, instructions: 'Which skill best matches the request? NONE if none apply.' },
      confidence: { type: 'score', instructions: 'How confident are you in this skill choice? 1 = guess, 5 = certain', criteria: ['guess', 'weak', 'moderate', 'strong', 'certain'] },
    },
  );
  const out = {
    complexity: a.complexity?.score ?? null,
    use_skill: (a.use_skill?.choice || 'NONE') !== 'NONE',
    skill_name: a.use_skill?.choice && a.use_skill.choice !== 'NONE' ? a.use_skill.choice : null,
    instruction: a.use_skill?.choice && a.use_skill.choice !== 'NONE'
      ? `Load the "${a.use_skill.choice}" skill (SKILL.md) and follow it for this request.`
      : 'No skill needed; proceed normally.',
    confidence: a.confidence?.score ?? null,
  };
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.log(JSON.stringify({ use_skill: false, error: String(e.message || e) })); // fail-open
}
