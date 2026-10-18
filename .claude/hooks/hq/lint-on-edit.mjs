#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit): syntax-check the edited file for repos without a formatter:
// `node --check` for .js/.mjs/.cjs, JSON.parse for .json. Other files are covered by stop-verify.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { readInput } from './lib.mjs';

const input = await readInput();
const file = input?.tool_input?.file_path;
if (!file) process.exit(0);
const abs = resolve(input.cwd || process.cwd(), file);
const ext = extname(abs);
let error = '';
if (['.js', '.mjs', '.cjs'].includes(ext)) {
  const res = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  if (res.status !== 0) error = res.stderr || 'node --check failed';
} else if (ext === '.json') {
  try { JSON.parse(readFileSync(abs, 'utf8')); } catch (e) { error = String(e.message); }
}
if (error) {
  process.stderr.write(`[lint-on-edit] ${file} has a syntax error:\n${error}\n`);
  process.exit(2);
}
process.exit(0);
