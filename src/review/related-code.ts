/**
 * Related code for the verifier: definitions and call sites, elsewhere in
 * the PR, of the identifiers on the lines a finding points at. Many false
 * positives hinge on code the reviewer did not look at (a guard in the
 * caller, a type that makes the case impossible); many real bugs need the
 * callee's contract. Pure text search, no language server: cheap and
 * language-agnostic across Swift, TypeScript, Python and SQL.
 */

export interface RelatedCodeFile {
  path: string;
  fileContent?: string | null | undefined;
}

export interface RelatedSnippet {
  path: string;
  startLine: number;
  kind: "definition" | "call site";
  symbol: string;
  text: string;
}

const KEYWORDS = new Set(
  [
    "async await return const let var function class struct enum protocol",
    "interface type import export from default public private internal static",
    "final override self this super true false null nil undefined none",
    "throw throws try catch finally guard else elif while for case switch",
    "where with select insert update delete into values table create alter",
    "string number boolean int bool void any some optional array dict list",
    "self await new typeof instanceof extends implements raise pass lambda",
  ]
    .join(" ")
    .split(" "),
);

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]{3,}/g;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Identifiers on the lines around the finding, calls first. */
export function symbolsNear(
  content: string,
  line: number,
  radius = 2,
): string[] {
  const lines = content.split("\n");
  const window = lines
    .slice(Math.max(0, line - 1 - radius), line + radius)
    .join("\n");
  const called = [...window.matchAll(/([A-Za-z_][A-Za-z0-9_]{3,})\s*\(/g)]
    .map((match) => match[1] ?? "")
    .filter((name) => !KEYWORDS.has(name.toLowerCase()));
  const all = [...window.matchAll(IDENTIFIER)]
    .map((match) => match[0])
    .filter((name) => !KEYWORDS.has(name.toLowerCase()));
  return [...new Set([...called, ...all])].slice(0, 8);
}

function definitionPattern(symbol: string): RegExp {
  const name = escapeRegex(symbol);
  return new RegExp(
    [
      `\\b(?:function|def|func|class|struct|enum|protocol|interface|type|actor)\\s+${name}\\b`,
      `\\b(?:const|let|var)\\s+${name}\\s*[:=]`,
      `^\\s*(?:export\\s+)?(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*(?::[^{=]+)?\\{`,
    ].join("|"),
  );
}

function snippet(
  lines: string[],
  index: number,
  contextLines: number,
): { startLine: number; text: string } {
  const start = Math.max(0, index - 2);
  const end = Math.min(lines.length, index + contextLines);
  return {
    startLine: start + 1,
    text: lines
      .slice(start, end)
      .map((text, offset) => `${start + offset + 1}: ${text}`)
      .join("\n"),
  };
}

export function findRelatedCode(input: {
  finding: { path: string; line: number };
  files: RelatedCodeFile[];
  maxSnippets?: number;
  contextLines?: number;
  maxCharacters?: number;
}): RelatedSnippet[] {
  const maxSnippets = input.maxSnippets ?? 4;
  const contextLines = input.contextLines ?? 12;
  const maxCharacters = input.maxCharacters ?? 6_000;
  const own = input.files.find((file) => file.path === input.finding.path);
  if (!own?.fileContent) {
    return [];
  }
  const symbols = symbolsNear(own.fileContent, input.finding.line);
  const definitions: RelatedSnippet[] = [];
  const callSites: RelatedSnippet[] = [];

  for (const symbol of symbols) {
    const definition = definitionPattern(symbol);
    const call = new RegExp(`\\b${escapeRegex(symbol)}\\s*\\(`);
    for (const file of input.files) {
      if (!file.fileContent) {
        continue;
      }
      const lines = file.fileContent.split("\n");
      lines.forEach((text, index) => {
        const sameSpot =
          file.path === input.finding.path &&
          Math.abs(index + 1 - input.finding.line) <= contextLines;
        if (sameSpot) {
          return;
        }
        if (definition.test(text)) {
          definitions.push({
            path: file.path,
            kind: "definition",
            symbol,
            ...snippet(lines, index, contextLines),
          });
        } else if (file.path !== input.finding.path && call.test(text)) {
          callSites.push({
            path: file.path,
            kind: "call site",
            symbol,
            ...snippet(lines, index, Math.ceil(contextLines / 2)),
          });
        }
      });
    }
  }

  // Definitions matter most; then call sites in other files. Skip snippets
  // that overlap one already taken, and stay within the character budget.
  const chosen: RelatedSnippet[] = [];
  let used = 0;
  for (const candidate of [...definitions, ...callSites]) {
    const overlaps = chosen.some(
      (entry) =>
        entry.path === candidate.path &&
        Math.abs(entry.startLine - candidate.startLine) <= contextLines,
    );
    if (overlaps || used + candidate.text.length > maxCharacters) {
      continue;
    }
    chosen.push(candidate);
    used += candidate.text.length;
    if (chosen.length >= maxSnippets) {
      break;
    }
  }
  return chosen;
}
