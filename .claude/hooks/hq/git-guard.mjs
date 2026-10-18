#!/usr/bin/env node
// PreToolUse(Bash): block hook bypass, force-push and pushes to protected branches.
// Early warning only — server-side branch rulesets are the real boundary.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readInput, block } from './lib.mjs';

const PROTECTED = ['main', 'master', 'develop'];

// Drop quoted strings (commit messages, echo text) so flags inside them don't trigger.
export function stripQuoted(command) {
  return command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

export function findViolation(command) {
  const cmd = ` ${stripQuoted(command).replace(/\s+/g, ' ')} `;
  if (/\bgit\b[^;&|]*\s--no-verify\b/.test(cmd)) return 'git --no-verify bypasses hooks';
  if (/\bgit\b[^;&|]*\bcommit\b[^;&|]*\s-[a-zA-Z]*n[a-zA-Z]*\s/.test(cmd)) return 'git commit -n bypasses hooks';
  if (/core\.hooksPath/.test(cmd)) return 'overriding core.hooksPath bypasses hooks';
  const pushes = cmd.match(/\bgit\b[^;&|]*\bpush\b[^;&|]*/g) || [];
  for (const p of pushes) {
    if (/\s(--force|--force-with-lease|-f)(\s|=)/.test(`${p} `) || /\s\+\S+/.test(p)) return 'force-push is never allowed';
    const tokens = p.trim().split(' ').slice(p.trim().split(' ').indexOf('push') + 1).filter((t) => !t.startsWith('-'));
    // Check every positional token (a flag value like `--push-option x` must not hide the refspec).
    for (const t of tokens) {
      const dest = t.includes(':') ? t.split(':').pop() : t;
      const branch = dest.replace(/^refs\/heads\//, '');
      if (PROTECTED.includes(branch)) return `pushing to ${branch} is never allowed; open a draft PR`;
    }
  }
  return null;
}

// gh pr merge is allowed only into develop (strict gitflow); main/master releases are human-only.
export function mergeTarget(command) {
  const m = command.match(/\bgh\s+pr\s+merge\b([^;&|]*)/);
  if (!m) return null;
  const args = m[1].trim().split(/\s+/).filter(Boolean);
  const repoIdx = args.findIndex((a) => a === '-R' || a === '--repo');
  const repo = repoIdx >= 0 ? args[repoIdx + 1] : null;
  const pr = args.find((a, i) => !a.startsWith('-') && (repoIdx < 0 || i !== repoIdx + 1));
  return { pr: pr || null, repo };
}

export function checkMerge(command, lookupBase) {
  const t = mergeTarget(command);
  if (!t) return null;
  if (!t.pr) return 'gh pr merge needs an explicit PR number so the base can be checked';
  const base = lookupBase(t.pr, t.repo);
  if (base !== 'develop') return `merging into "${base ?? 'unknown'}" is human-only; agents merge into develop only`;
  return null;
}

function ghBase(pr, repo) {
  const args = ['pr', 'view', pr, '--json', 'baseRefName', '-q', '.baseRefName'];
  if (repo) args.push('-R', repo);
  const res = spawnSync('gh', args, { encoding: 'utf8', timeout: 15000 });
  return res.status === 0 ? res.stdout.trim() : null;
}

async function main() {
  const input = await readInput();
  if (!input) process.exit(0);
  const command = input.tool_input?.command;
  if (typeof command === 'string') {
    const v = findViolation(command) || checkMerge(command, ghBase);
    if (v) block('git-guard', `${v} (rules/git-safety.md).`);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
