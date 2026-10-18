#!/usr/bin/env node
// PreToolUse(Bash): block hook bypass, force-push, pushes to protected branches, and merges into
// anything but develop (strict gitflow). Early warning only — server-side rules are the real boundary,
// so this errs on the side of blocking.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readInput, block } from './lib.mjs';

const PROTECTED = ['main', 'master', 'develop'];

// Drop quoted strings (commit messages, echo text) so flags inside them don't trigger.
export function stripQuoted(command) {
  return command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

// Shell-unquote for refspec analysis: `"develop"`, `dev""elop` and `'HEAD:main'` all mean develop/main.
export function unquote(command) {
  return command.replace(/["'\\]/g, '');
}

export function normalizeRef(ref) {
  return ref.replace(/^\+/, '').replace(/\/{2,}/g, '/').replace(/^refs\//, '').replace(/^heads\//, '').replace(/^remotes\/[^/]+\//, '');
}

// Returns the destination branch names a `git push` segment targets, or ['<implicit>'] when none is named.
export function pushDestinations(segment) {
  const tokens = segment.trim().split(/\s+/);
  const args = tokens.slice(tokens.indexOf('push') + 1);
  const positional = args.filter((t) => !t.startsWith('-'));
  if (positional.length <= 1) return ['<implicit>'];
  if (positional.slice(1).some((t) => t.startsWith(':'))) return ['<delete>'];
  return positional.slice(1).map((t) => {
    const dest = t.includes(':') ? t.split(':').pop() : t;
    return dest === 'HEAD' || dest === '' ? '<implicit>' : normalizeRef(dest);
  });
}

export function findViolation(command, currentBranch = () => null) {
  const plain = ` ${stripQuoted(command).replace(/\s+/g, ' ')} `;
  if (/\bgit\b[^;&|]*\s--no-verify\b/.test(plain)) return 'git --no-verify bypasses hooks';
  if (/\bgit\b[^;&|]*\bcommit\b[^;&|]*\s-[a-zA-Z]*n[a-zA-Z]*\s/.test(plain)) return 'git commit -n bypasses hooks';
  if (/core\.hooksPath/.test(command)) return 'overriding core.hooksPath bypasses hooks';
  if (/\b(sh|bash|zsh|eval)\b[^;&|]*\bgit\b[^;&|]*\bpush\b/.test(command) && /\b(sh|bash|zsh)\s+-c\b|\beval\b/.test(command)) {
    return 'git push inside sh -c/eval cannot be checked';
  }
  const cmd = ` ${unquote(command).replace(/\s+/g, ' ')} `;
  const pushes = cmd.match(/\bgit\b[^;&|]*\bpush\b[^;&|]*/g) || [];
  for (const p of pushes) {
    if (/[$`]/.test(p)) return 'git push with shell expansion cannot be checked';
    if (/\s(--force|--force-with-lease|--force-if-includes|--mirror|--all|--delete)(\s|=)/.test(`${p} `)) return 'force/mirror/all/delete pushes are never allowed';
    if (/\s-[a-zA-Z]*[fd][a-zA-Z]*(\s|$)/.test(`${p} `) || /\s\+\S+/.test(p)) return 'force-push is never allowed';
    for (const dest of pushDestinations(p)) {
      if (dest === '<delete>') return 'deleting remote branches with git push is not allowed';
      const branch = dest === '<implicit>' ? currentBranch() : dest;
      if (branch == null) return 'git push without an explicit feature/ refspec; use git push -u origin HEAD:refs/heads/<feature-branch>';
      if (PROTECTED.includes(branch)) return `pushing to ${branch} is never allowed; open a PR into develop`;
    }
  }
  return null;
}

// gh pr merge is allowed only into develop (strict gitflow); main/master releases are human-only.
export function mergeTarget(command) {
  const m = unquote(command).match(/\bgh\s+pr\s+merge\b([^;&|]*)/);
  if (!m) return null;
  const args = m[1].trim().split(/\s+/).filter(Boolean);
  const repoIdx = args.findIndex((a) => a === '-R' || a === '--repo');
  const repo = repoIdx >= 0 ? args[repoIdx + 1] : null;
  const pr = args.find((a) => /^(\d+|https:\/\/github\.com\/\S+\/pull\/\d+)$/.test(a));
  return { pr: pr || null, repo };
}

export function checkMerge(command, lookupBase) {
  if (/\bgh\s+api\b[^;&|]*\/merge\b/.test(command)) return 'merge via gh api is not allowed; use gh pr merge <n>';
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
    const cwd = input.cwd || process.cwd();
    const currentBranch = () => {
      const res = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
      return res.status === 0 ? res.stdout.trim() : null;
    };
    const v = findViolation(command, currentBranch) || checkMerge(command, ghBase);
    if (v) block('git-guard', `${v} (rules/git-safety.md).`);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
