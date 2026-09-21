# jev-skill-router

[![npm version](https://img.shields.io/npm/v/jev-skill-router.svg)](https://www.npmjs.com/package/jev-skill-router)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![powered by Jev](https://img.shields.io/badge/powered%20by-Jev%20(System%20One)-orange)](https://github.com/tamaratran/fast-jev-compaction)

**A Jev-powered skill router & security auditor for any AI agent** — Codex, Claude Code, OpenCode, Hermes Agent, anything with `SKILL.md` skills.

The problem: agents have dozens of skills, but the model *forgets to use them* — or uses the wrong one. jev-skill-router sends ONE cheap Jev (System One) decision request per user request and returns a short instruction: *which skill to load, how complex the request is, how confident the choice is.*

Second problem it solves: **skill supply-chain safety.** Install skills from any GitHub repo, then run a Jev security audit that flags **prompt injection** and **dangerous shell commands** per skill.

Built on the public Jev endpoint (`POST https://openrouter.ai/api/alpha/decisions`, model `typesafe/jev-1.13`) with a normal OpenRouter key. One decision costs ~$0.00002 and takes ~0.5 s.

## Install (one command)

```bash
npm i -g jev-skill-router
export OPENROUTER_API_KEY=sk-or-v1-...   # key from env only, never hardcoded
```

## Why not just "list skills in AGENTS.md"?

| Approach | Cost / request | Latency | Stays in sync with skill library | Safety scan |
|---|---|---|---|---|
| Full skill catalog pasted in AGENTS.md | tokens EVERY request, grows with library | — | manual re-paste | ❌ |
| "The model remembers" (system prompt) | tokens, degrades with 100+ skills | — | ❌ model forgets | ❌ |
| LLM call to route | $0.01–0.10 | 3–10 s | manual | ❌ |
| **jev-skill-router (Jev)** | **~$0.00002** | **~0.5–1.5 s** | **auto (reads SKILL.md dirs)** | **✅ built-in** |

## Use

```bash
# Tell the agent WHICH skill to load for a request:
jev-skill-router "отсканируй конкурентов и напиши тред на reddit с цифрами"
# → {"complexity":3.05,"use_skill":true,"skill_name":"deep-researcher",
#    "instruction":"Load the \"deep-researcher\" skill (SKILL.md) and follow it for this request.",
#    "confidence":2.19}

# Wire it into your agent (prints the rule to paste into AGENTS.md / CLAUDE.md):
jev-skill-router --init codex        # codex | claude | opencode | hermes | generic

# See what skill libraries it discovered:
jev-skill-router --list

# Install skills from any GitHub repo + security-audit them in one step:
jev-skill-router --install anthropics/skills --scan
# → {"installed":20,...}
# → # security scan: 54 skills → unsafe=0, review=0 (report: ./skills-security-report.json)

# Security-audit discovered skills (prompt injection + dangerous commands):
jev-skill-router --scan --dir .jev-skill-router
# → # scanned 17 skills → unsafe=1, review=0
# → UNSAFE  evil-skill-test  (p_inj=HIGH, cmds=HIGH)
```

Skill discovery covers (add yours via `JEV_SKILL_DIRS`):
`~/.claude/skills`, `~/.codex/skills`, `~/.opencode/skills`, Hermes skills dir, `~/.jev-skill-router/library` (installed from GitHub), `./skills`.

## Wire into your agent (manual alternative)

Add to `AGENTS.md` / `CLAUDE.md`:

```md
Before answering any non-trivial request, run:
  jev-skill-router "<the user request>"
and follow the returned `instruction` and `skill_name`. If `use_skill` is false, proceed normally.
```

## How routing works

1. The CLI walks your skill dirs and parses `SKILL.md` frontmatter (name + description).
2. ONE Jev call with the user request + compact skill catalog asks, in parallel:
   - **complexity** 1–5 (how deep is this task),
   - **use_skill** choice over ≤60 skills (or NONE),
   - **confidence** 1–5.
3. Output is a single JSON line — the agent follows `instruction`.

## How the security audit works

For each skill body (up to 6 KB), one Jev call with two choices:
- `prompt_injection`: does the skill try to override the agent / hide actions / exfiltrate data?
- `dangerous_commands`: does it instruct destructive shell (`rm -rf`, `curl | bash`, credential access)?

Verdict: `TRUSTED` (both LOW) / `REVIEW` (any MEDIUM) / `UNSAFE` (any HIGH) / `UNKNOWN` (API error — fail-open). Report saved to `skills-security-report.json`.

## Verified on a real setup

- 213 skills discovered from 3 agent skill dirs + external library in <1 s.
- Request in Russian → correct skill `deep-researcher`, 1.1 s, ~$0.00002.
- `--install mattpocock/skills` → 38 skills; `--install anthropics/skills` → 20 skills.
- Planted malicious skill (jailbreak + `curl | bash`) → flagged `UNSAFE` (p_inj HIGH, cmds HIGH); 54 clean skills from Anthropic & mattpocock → `TRUSTED`.

## Fail-open philosophy

No key, no network, API error → the tool prints `{use_skill:false}` and exits 0. A broken router never blocks your agent.

## License

MIT
