#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit|NotebookEdit): block edits inside a primary git checkout.
// All work happens in linked worktrees (WORKFLOW.md §1). Override: HQ_ALLOW_PRIMARY=1.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { readInput, block } from './lib.mjs';

export function nearestExistingDir(p) {
  let d = dirname(p);
  while (!existsSync(d) && d !== dirname(d)) d = dirname(d);
  return d;
}

export function isPrimaryCheckout(dir) {
  const opts = { encoding: 'utf8' };
  const a = spawnSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir'], opts);
  const b = spawnSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], opts);
  if (a.status !== 0 || b.status !== 0) return false; // not in a repo: nothing to guard
  return a.stdout.trim() === b.stdout.trim();
}

const input = await readInput();
if (!input || process.env.HQ_ALLOW_PRIMARY === '1') process.exit(0);
const file = input.tool_input?.file_path || input.tool_input?.notebook_path;
if (!file) process.exit(0);
const abs = resolve(input.cwd || process.cwd(), file);
if (isPrimaryCheckout(nearestExistingDir(abs))) {
  block('worktree-guard', `${abs} is in a primary checkout. Create a worktree first: git worktree add --no-track -b <branch> ../<repo>-<id> origin/<base> (see WORKFLOW.md §1).`);
}
process.exit(0);
