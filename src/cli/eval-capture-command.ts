import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LiveEvaluationFixture } from "../eval/live-review-evaluator.js";

/**
 * `eval:capture owner/repo#123` (or `owner/repo@<sha>` for a commit pushed
 * without a PR) — snapshot a real change into a live eval fixture (patches +
 * file content at HEAD) so it can be replayed against local models.
 * `expectedFindings` is left empty for hand annotation.
 */

export type FetchLike = typeof fetch;

export interface EvalCaptureInput {
  reference: string;
  token: string;
  outDirectory: string;
  apiBaseUrl?: string;
  /** Skip file content fetches above this many bytes (default 60_000). */
  maxFileContentBytes?: number;
  fetchFn?: FetchLike;
  write?: (line: string) => void;
}

const REFERENCE_PATTERN =
  /^(?:https:\/\/github\.com\/)?([^/\s]+)\/([^/#\s]+)(?:#|\/pull\/)(\d+)$/;

export function parsePullReference(reference: string): {
  owner: string;
  repo: string;
  number: number;
} {
  const match = REFERENCE_PATTERN.exec(reference.trim());
  if (!match) {
    throw new Error(
      `Expected owner/repo#123 or a pull request URL, got "${reference}".`,
    );
  }
  return {
    owner: match[1] as string,
    repo: match[2] as string,
    number: Number.parseInt(match[3] as string, 10),
  };
}

const COMMIT_REFERENCE_PATTERN =
  /^(?:https:\/\/github\.com\/)?([^/\s]+)\/([^/@\s]+)(?:@|\/commit\/)([0-9a-f]{7,40})$/;

export type CaptureReference =
  | { kind: "pull"; owner: string; repo: string; number: number }
  | { kind: "commit"; owner: string; repo: string; sha: string };

export function parseCaptureReference(reference: string): CaptureReference {
  const commit = COMMIT_REFERENCE_PATTERN.exec(reference.trim());
  if (commit) {
    return {
      kind: "commit",
      owner: commit[1] as string,
      repo: commit[2] as string,
      sha: commit[3] as string,
    };
  }
  return { kind: "pull", ...parsePullReference(reference) };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

const stackByExtension: Array<[RegExp, LiveEvaluationFixture["stack"]]> = [
  [/\.swift$/, "swift"],
  [/\.(ts|tsx|js|jsx|mjs|cjs|astro)$/, "typescript"],
  [/\.py$/, "python"],
  [/\.sql$/, "sql"],
];

/** The stack with the most changed files; "other" when nothing matches. */
export function inferStack(paths: string[]): LiveEvaluationFixture["stack"] {
  const counts = new Map<LiveEvaluationFixture["stack"], number>();
  for (const path of paths) {
    const stack = stackByExtension.find(([pattern]) => pattern.test(path))?.[1];
    if (stack) {
      counts.set(stack, (counts.get(stack) ?? 0) + 1);
    }
  }
  return (
    [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ??
    "other"
  );
}

export class EvalCaptureCommand {
  async run(input: EvalCaptureInput): Promise<string> {
    const write = input.write ?? ((line: string) => console.log(line));
    const fetchFn = input.fetchFn ?? fetch;
    const apiBaseUrl = (input.apiBaseUrl ?? "https://api.github.com").replace(
      /\/+$/,
      "",
    );
    const maxBytes = input.maxFileContentBytes ?? 60_000;
    const reference = parseCaptureReference(input.reference);
    const { owner, repo } = reference;
    const headers = {
      authorization: `Bearer ${input.token}`,
      accept: "application/vnd.github+json",
      "user-agent": "nitpickr-eval-capture",
    };
    const get = async <T>(path: string): Promise<T> => {
      const response = await fetchFn(`${apiBaseUrl}${path}`, { headers });
      if (!response.ok) {
        throw new Error(
          `GitHub request failed (${response.status}) for ${path}: ${(await response.text()).slice(0, 300)}`,
        );
      }
      return (await response.json()) as T;
    };

    let title: string;
    let headSha: string;
    let number: number;
    let source: string;
    let slug: string;
    const files: PullFile[] = [];
    if (reference.kind === "commit") {
      const commit = await get<{
        sha: string;
        commit: { message: string };
        files?: PullFile[];
      }>(`/repos/${owner}/${repo}/commits/${reference.sha}`);
      title = commit.commit.message.split("\n")[0]?.trim() || commit.sha;
      headSha = commit.sha;
      // Commits have no PR number; the fixture schema needs a positive one.
      number = 1;
      source = `https://github.com/${owner}/${repo}/commit/${commit.sha}`;
      slug = `${owner}-${repo}-${commit.sha.slice(0, 7)}-${slugify(title)}`;
      files.push(...(commit.files ?? []));
    } else {
      const pull = await get<{ title: string; head: { sha: string } }>(
        `/repos/${owner}/${repo}/pulls/${reference.number}`,
      );
      title = pull.title;
      headSha = pull.head.sha;
      number = reference.number;
      source = `https://github.com/${owner}/${repo}/pull/${number}`;
      slug = `${owner}-${repo}-${number}-${slugify(title)}`;
      for (let page = 1; ; page += 1) {
        const batch = await get<PullFile[]>(
          `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
        );
        files.push(...batch);
        if (batch.length < 100) {
          break;
        }
      }
    }

    const fixtureFiles: LiveEvaluationFixture["input"]["files"] = [];
    for (const file of files) {
      let fileContent: string | null = null;
      if (file.status !== "removed") {
        try {
          const contents = await get<{
            encoding?: string;
            content?: string;
            size?: number;
          }>(
            `/repos/${owner}/${repo}/contents/${encodeURIComponent(file.filename).replace(/%2F/g, "/")}?ref=${headSha}`,
          );
          if (
            contents.encoding === "base64" &&
            typeof contents.content === "string" &&
            (contents.size ?? 0) <= maxBytes
          ) {
            fileContent = Buffer.from(contents.content, "base64").toString(
              "utf8",
            );
          }
        } catch (error) {
          write(
            `  (skipping content for ${file.filename}: ${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
      fixtureFiles.push({
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch ?? null,
        fileContent,
      });
    }

    const fixture: LiveEvaluationFixture = {
      name: slug,
      source,
      // Captured PRs start as clean; annotate expectedFindings (and switch
      // kind to captured_bug) when the PR contains a known defect.
      kind: "captured_clean",
      stack: inferStack(fixtureFiles.map((file) => file.path)),
      expectedVerdicts: [],
      input: {
        changeRequest: { title, number },
        files: fixtureFiles,
        instructionText: "",
        memory: [],
        commentBudget: 10,
        priorReviewRoundCount: 0,
      },
      expectedFindings: [],
    };

    await mkdir(input.outDirectory, { recursive: true });
    const outPath = join(input.outDirectory, `${fixture.name}.json`);
    await writeFile(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
    write(
      `Captured ${files.length} file(s) from ${fixture.source} → ${outPath}`,
    );
    write("Annotate expectedFindings before running the live eval.");
    return outPath;
  }
}
