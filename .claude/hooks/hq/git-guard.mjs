#!/usr/bin/env node
// PreToolUse(Bash): block hook bypass, force-push, pushes to protected branches, ref-moving gh api
// calls, and merges into anything but develop (strict gitflow). Early warning only — it errs on the
// side of blocking, but quoted text (commit messages, heredocs) is never parsed as a command.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readInput, block } from './lib.mjs';

const PROTECTED = ['main', 'master', 'develop'];
const SEPARATORS = new Set([';', '&', '|', '\n']);

// Minimal POSIX-ish tokenizer: splits on ; & | newline outside quotes, unquotes tokens, and flags
// tokens whose value depends on expansion ($, backticks) so they can't be trusted as refspecs.
export function tokenize(command) {
  const commands = [];
  let tokens = [];
  let cur = null;
  let quote = null;
  const pushTok = () => { if (cur) tokens.push(cur); cur = null; };
  const endCmd = () => { pushTok(); if (tokens.length) commands.push(tokens); tokens = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (quote === '"' && c === '\\' && i + 1 < command.length) { cur.text += command[++i]; continue; }
      if (quote === '"' && (c === '$' || c === '`')) cur.expands = true;
      cur.text += c;
      continue;
    }
    if (c === "'" || c === '"') { cur ||= { text: '', expands: false }; quote = c; continue; }
    if (c === '\\' && i + 1 < command.length) { cur ||= { text: '', expands: false }; cur.text += command[++i]; continue; }
    if (SEPARATORS.has(c)) { endCmd(); continue; }
    if (/\s/.test(c)) { pushTok(); continue; }
    cur ||= { text: '', expands: false };
    if (c === '$' || c === '`') cur.expands = true;
    if (c === '(' || c === ')') { pushTok(); continue; }
    cur.text += c;
  }
  endCmd();
  return commands;
}

export function normalizeRef(ref) {
  return ref.replace(/^\+/, '').replace(/\/{2,}/g, '/').replace(/^refs\//, '').replace(/^heads\//, '').replace(/^remotes\/[^/]+\//, '');
}

const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const PUSH_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--recurse-submodules', '--receive-pack', '--exec']);
const COMMIT_WITH_VALUE = new Set(['-m', '--message', '-F', '--file', '-C', '-c', '--reuse-message', '--reedit-message', '--author', '--date', '-t', '--template', '--fixup', '--squash', '--cleanup']);

function checkGit(args, currentBranch) {
  let i = 0;
  while (i < args.length && args[i].text.startsWith('-')) {
    const t = args[i].text;
    if (/core\.hooksPath|^alias\.|-c\s*alias\./i.test(t) || (t === '-c' && /^(alias\.|core\.hookspath)/i.test(args[i + 1]?.text || ''))) {
      return 'overriding core.hooksPath or defining aliases inline bypasses hooks';
    }
    i += GIT_GLOBAL_WITH_VALUE.has(t) ? 2 : 1;
  }
  const sub = args[i]?.text;
  const rest = args.slice(i + 1);
  if (sub === 'commit') {
    for (let j = 0; j < rest.length; j++) {
      const t = rest[j].text;
      if (t === '--no-verify') return 'git commit --no-verify bypasses hooks';
      if (/^-[a-zA-Z]+$/.test(t) && t.includes('n')) return 'git commit -n bypasses hooks';
      if (COMMIT_WITH_VALUE.has(t)) j++;
    }
    return null;
  }
  if (sub !== 'push') return null;
  const positional = [];
  for (let j = 0; j < rest.length; j++) {
    const tok = rest[j];
    const t = tok.text;
    if (tok.expands) return 'git push with shell expansion cannot be checked';
    if (/^--(force|force-with-lease|force-if-includes|mirror|all|delete|prune)(=|$)/.test(t)) return 'force/mirror/all/delete/prune pushes are never allowed';
    if (t === '--no-verify') return 'git push --no-verify bypasses hooks';
    if (/^-[a-zA-Z]+$/.test(t) && /[fd]/.test(t)) return 'force/delete pushes are never allowed';
    if (PUSH_WITH_VALUE.has(t)) { j++; continue; }
    if (t.startsWith('-')) continue;
    positional.push(t);
  }
  const refspecs = positional.slice(1);
  const dests = refspecs.length ? refspecs : ['<implicit>'];
  for (const spec of dests) {
    if (spec.startsWith('+')) return 'force-push is never allowed';
    if (spec.startsWith(':')) return 'deleting remote branches with git push is not allowed';
    let dest = spec === '<implicit>' ? spec : spec.includes(':') ? spec.split(':').pop() : spec;
    if (dest === 'HEAD') dest = '<implicit>';
    const branch = dest === '<implicit>' ? currentBranch() : normalizeRef(dest);
    if (branch == null) return 'git push without an explicit feature/ refspec; use git push -u origin HEAD:refs/heads/<feature-branch>';
    if (PROTECTED.includes(branch)) return `pushing to ${branch} is never allowed; open a PR into develop`;
  }
  return null;
}

function checkGhApi(args) {
  let method = null;
  let hasFields = false;
  let path = '';
  for (let j = 0; j < args.length; j++) {
    const t = args[j].text;
    if (t === '-X' || t === '--method') { method = (args[j + 1]?.text || '').toUpperCase(); j++; continue; }
    if (/^--method=/.test(t)) { method = t.split('=')[1].toUpperCase(); continue; }
    if (['-f', '-F', '--field', '--raw-field', '--input'].includes(t)) { hasFields = true; j++; continue; }
    if (!t.startsWith('-') && !path) path = t;
  }
  const effective = method || (hasFields ? 'POST' : 'GET');
  if (effective === 'GET') return null;
  if (/\/merges\b|\/pulls\/\d+\/merge\b|\/git\/refs\b|\/contents\/|\/branches\/[^/]+\/(rename|protection)/.test(path)) {
    return `gh api ${effective} ${path} can move or merge branches; use gh pr merge <n> into develop`;
  }
  return null;
}

// gh pr merge is allowed only into develop (strict gitflow); main/master releases are human-only.
export function checkMerge(command, lookupBase) {
  for (const args of tokenize(command)) {
    const words = args.map((a) => a.text);
    const g = words.indexOf('gh');
    if (g < 0) continue;
    if (words[g + 1] === 'api') {
      const v = checkGhApi(args.slice(g + 2));
      if (v) return v;
      continue;
    }
    if (words[g + 1] !== 'pr' || words[g + 2] !== 'merge') continue;
    const rest = words.slice(g + 3);
    const ri = rest.findIndex((a) => a === '-R' || a === '--repo');
    const repo = ri >= 0 ? rest[ri + 1] : null;
    const pr = rest.find((a) => /^(\d+|https:\/\/github\.com\/\S+\/pull\/\d+)$/.test(a));
    if (!pr) return 'gh pr merge needs an explicit PR number so the base can be checked';
    const base = lookupBase(pr, repo);
    if (base !== 'develop') return `merging into "${base ?? 'unknown'}" is human-only; agents merge into develop only`;
  }
  return null;
}

export function findViolation(command, currentBranch = () => null) {
  for (const args of tokenize(command)) {
    let k = 0;
    while (k < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[k].text)) {
      if (/^GIT_CONFIG_|^GIT_DIR=|^GIT_EXEC_PATH=/.test(args[k].text)) return 'git config/env overrides cannot be checked';
      k++;
    }
    const words = args.slice(k);
    const head = words[0]?.text;
    if (['sh', 'bash', 'zsh', 'eval', 'xargs', 'env'].includes(head) && /\bgit\b[\s\S]*\bpush\b|\bgh\s+(pr\s+merge|api)\b/.test(words.map((w) => w.text).join(' '))) {
      return 'git push / gh merge inside sh -c, eval, xargs or env cannot be checked';
    }
    const gi = words.findIndex((w) => w.text === 'git');
    if (gi >= 0 && (gi === 0 || ['sudo', 'command', 'time', 'nice'].includes(words[0].text))) {
      const v = checkGit(words.slice(gi + 1), currentBranch);
      if (v) return v;
    }
  }
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
