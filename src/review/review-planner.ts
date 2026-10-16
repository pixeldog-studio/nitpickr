import type { RepositoryConfig } from "../config/repository-config-loader.js";
import type { ReviewRun } from "../domain/types.js";

export interface ReviewPlannerFile {
  path: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface ReviewPlan {
  files: ReviewPlannerFile[];
  summaryOnly: boolean;
  commentBudget: number;
  allowSuggestedChanges: boolean;
  skipReason: string | null;
  summaryOnlyReason: string | null;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  let escaped = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    const nextCharacter = pattern[index + 1];

    if (character === "*" && nextCharacter === "*") {
      escaped += ".*";
      index += 1;
      continue;
    }

    if (character === "*") {
      escaped += "[^/]*";
      continue;
    }

    escaped += escapeRegex(character);
  }

  return new RegExp(`^${escaped}$`);
}

/**
 * Lockfiles, snapshots and minified bundles are generated: reviewing them
 * costs model time and produces findings nobody can act on.
 */
const GENERATED_FILE = new RegExp(
  [
    "(^|/)(pnpm-lock\\.yaml|package-lock\\.json|yarn\\.lock|bun\\.lockb|Package\\.resolved|Podfile\\.lock|Gemfile\\.lock|Cargo\\.lock|poetry\\.lock|uv\\.lock|composer\\.lock)$",
    "\\.min\\.(js|css)$",
    "\\.snap$",
  ].join("|"),
);

export function isGeneratedFile(path: string): boolean {
  return GENERATED_FILE.test(path);
}

function matchesAnyPattern(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegex(pattern).test(path));
}

export class ReviewPlanner {
  plan(input: {
    mode: ReviewRun["mode"];
    config: RepositoryConfig;
    files: ReviewPlannerFile[];
  }): ReviewPlan {
    const filteredFiles = input.files
      .filter(
        (file) =>
          !isGeneratedFile(file.path) &&
          !matchesAnyPattern(file.path, input.config.review.ignorePaths),
      )
      .slice(0, input.config.review.maxFiles);

    if (filteredFiles.length === 0) {
      return {
        files: [],
        summaryOnly: true,
        commentBudget: 0,
        allowSuggestedChanges: input.config.review.allowSuggestedChanges,
        skipReason:
          "No reviewable files matched the current repository configuration.",
        summaryOnlyReason: null,
      };
    }

    const summaryOnly =
      input.mode === "summary" ||
      filteredFiles.length >= input.config.review.summaryOnlyThreshold;
    const commentBudget =
      summaryOnly || input.mode === "summary"
        ? 0
        : input.mode === "full"
          ? input.config.review.maxComments
          : input.config.review.maxAutoComments;
    const summaryOnlyReason =
      input.mode === "summary"
        ? "Summary-only review requested."
        : filteredFiles.length >= input.config.review.summaryOnlyThreshold
          ? `Summary-only review: ${filteredFiles.length} files exceeded the inline review threshold of ${input.config.review.summaryOnlyThreshold}.`
          : null;

    return {
      files: filteredFiles,
      summaryOnly,
      commentBudget,
      allowSuggestedChanges: input.config.review.allowSuggestedChanges,
      skipReason: null,
      summaryOnlyReason,
    };
  }
}
