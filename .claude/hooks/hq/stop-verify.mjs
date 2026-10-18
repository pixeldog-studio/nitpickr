#!/usr/bin/env node
// Stop: if the worktree has changes, run the repo's fast verify (env HQ_FAST_VERIFY) and
// block stopping while it fails — at most 3 consecutive blocks, then let the agent stop and report.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readInput } from './lib.mjs';

const MAX_BLOCKS = 3;
const input = await readInput();
const cmd = process.env.HQ_FAST_VERIFY;
if (!input || !cmd) process.exit(0);
const cwd = input.cwd || process.cwd();
const top = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (top.status !== 0) process.exit(0);
const root = top.stdout.trim();
const dirty = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim();
if (!dirty) process.exit(0);
// Keep state in the per-worktree git dir so the working tree never looks dirty.
const gitDir = spawnSync('git', ['-C', root, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).stdout.trim();
const counterFile = join(gitDir || join(root, '.git'), 'hq-stop-verify-count');
let count = 0;
try { count = Number(readFileSync(counterFile, 'utf8')) || 0; } catch { /* first run */ }
const res = spawnSync('sh', ['-c', cmd], { cwd: root, encoding: 'utf8', timeout: 240000 });
if (res.status === 0) {
  try { writeFileSync(counterFile, '0'); } catch { /* no .hq dir */ }
  process.exit(0);
}
if (count >= MAX_BLOCKS) {
  try { writeFileSync(counterFile, '0'); } catch { /* reset so the next failing Stop blocks again */ }
  process.stderr.write(`[stop-verify] \`${cmd}\` still failing after ${MAX_BLOCKS} attempts; stopping. Report the failure.\n`);
  process.exit(0);
}
writeFileSync(counterFile, String(count + 1));
const tail = `${res.stdout || ''}\n${res.stderr || ''}`.trim().split('\n').slice(-40).join('\n');
process.stderr.write(`[stop-verify] \`${cmd}\` failed (attempt ${count + 1}/${MAX_BLOCKS}). Fix before stopping:\n${tail}\n`);
process.exit(2);
