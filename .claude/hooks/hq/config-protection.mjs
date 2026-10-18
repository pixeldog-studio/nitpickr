#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit): block edits to existing lint/format/type-check configs.
// Agents must fix code, not loosen the checks. Override: HQ_ALLOW_CONFIG_EDIT=1 (human-approved).
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { readInput, block } from './lib.mjs';

const PATTERNS = [
  /^\.eslintrc(\..+)?$/, /^eslint\.config\.(js|mjs|cjs|ts)$/,
  /^\.prettierrc(\..+)?$/, /^prettier\.config\.(js|mjs|cjs)$/,
  /^biome\.jsonc?$/, /^tsconfig(\..+)?\.json$/,
  /^\.swiftlint\.ya?ml$/, /^\.swiftformat$/,
  /^ruff\.toml$/, /^\.ruff\.toml$/, /^mypy\.ini$/, /^\.markdownlint(\..+)?$/,
];

// The guard rails themselves: an agent must not be able to edit its own hooks or permissions.
// Case-insensitive: APFS is case-insensitive by default, so .CLAUDE/hooks is the same directory.
const GUARD_PATHS = [/\/\.claude\/hooks\//i, /\/\.claude\/settings(\.local)?\.json$/i, /\/harness\/lane-settings\.json$/i];

export function isProtectedConfig(path) {
  return PATTERNS.some((re) => re.test(basename(path))) || GUARD_PATHS.some((re) => re.test(path));
}

const input = await readInput();
if (!input || process.env.HQ_ALLOW_CONFIG_EDIT === '1') process.exit(0);
const file = input.tool_input?.file_path;
if (!file) process.exit(0);
const abs = resolve(input.cwd || process.cwd(), file);
if (isProtectedConfig(abs) && (existsSync(abs) || GUARD_PATHS.some((re) => re.test(abs)))) {
  block('config-protection', `${basename(abs)} is a protected check config. Fix the code instead; if the config truly must change, ask the human.`);
}
process.exit(0);
