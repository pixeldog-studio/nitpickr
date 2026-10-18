#!/usr/bin/env node
// PreToolUse(Bash): block hook bypass, force-push and pushes to protected branches.
// Early warning only — server-side branch rulesets are the real boundary.
import { readInput, block } from './lib.mjs';

const PROTECTED = ['main', 'master', 'develop'];

export function findViolation(command) {
  const cmd = ` ${command.replace(/\s+/g, ' ')} `;
  if (/\bgit\b[^;&|]*\s--no-verify\b/.test(cmd)) return 'git --no-verify bypasses hooks';
  if (/\bgit\b[^;&|]*\bcommit\b[^;&|]*\s-[a-zA-Z]*n[a-zA-Z]*\s/.test(cmd)) return 'git commit -n bypasses hooks';
  if (/core\.hooksPath/.test(cmd)) return 'overriding core.hooksPath bypasses hooks';
  const pushes = cmd.match(/\bgit\b[^;&|]*\bpush\b[^;&|]*/g) || [];
  for (const p of pushes) {
    if (/\s(--force|--force-with-lease|-f)(\s|=)/.test(`${p} `) || /\s\+\S+/.test(p)) return 'force-push is never allowed';
    const tokens = p.trim().split(' ').slice(p.trim().split(' ').indexOf('push') + 1).filter((t) => !t.startsWith('-'));
    for (const t of tokens.slice(1)) {
      const dest = t.includes(':') ? t.split(':').pop() : t;
      const branch = dest.replace(/^refs\/heads\//, '');
      if (PROTECTED.includes(branch)) return `pushing to ${branch} is never allowed; open a draft PR`;
    }
  }
  if (/\bgh\s+pr\s+merge\b/.test(cmd)) return 'agents never merge PRs';
  return null;
}

const input = await readInput();
if (!input) process.exit(0);
const command = input.tool_input?.command;
if (typeof command === 'string') {
  const v = findViolation(command);
  if (v) block('git-guard', `${v} (rules/git-safety.md).`);
}
process.exit(0);
