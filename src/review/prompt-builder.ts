import { renderReviewLenses } from "./review-lenses.js";
import {
  revealInvisible,
  sanitizeUntrustedProse,
  UNTRUSTED_CONTENT_RULE,
} from "./untrusted-content.js";

export type PriorThreadState = "open" | "resolved" | "dismissed" | "stale";

export type PriorThreadVerdict = "fixed" | "still_applies" | "obsolete";

export interface PriorThread {
  /** Short stable id the model uses to return a verdict, e.g. "T1". */
  id: string;
  /**
   * True when this push changed the lines around the thread, so the model
   * must say whether the push fixed it. Threads are only resolved on an
   * explicit verdict, never because a finding was not raised again.
   */
  needsVerdict: boolean;
  path: string;
  line: number;
  state: PriorThreadState;
  title: string;
  fingerprint: string;
  userReply?: string;
}

export interface PromptBuilderInput {
  changeRequest: {
    title: string;
    number: number;
    /** PR description from the author; untrusted, rendered sanitized. */
    body?: string | null;
  };
  chunk: {
    index: number;
    total: number;
    files: Array<{
      path: string;
      patch: string | null;
      additions: number;
      deletions: number;
      fileContent?: string | null;
    }>;
  };
  contextFiles?: Array<{
    path: string;
    patch: string | null;
    additions: number;
    deletions: number;
  }>;
  instructionText: string;
  memory: Array<{
    summary: string;
    path?: string;
  }>;
  priorThreads?: PriorThread[];
  /**
   * Count of prior completed (`published` or `skipped`) review runs for this
   * PR. Surfaced to the LLM so it can self-restrain on long-iteration PRs and
   * skip raising low-severity findings that the server-side severity floor
   * would drop anyway. See severity-floor.ts.
   */
  priorReviewRoundCount?: number;
  commentBudget: number;
}

export interface ReviewPrompt {
  system: string;
  user: string;
}

const MAX_DESCRIPTION_CHARACTERS = 4_000;
const DESCRIPTION_BEGIN = "<<<pr-description (untrusted)";
const DESCRIPTION_END = "pr-description>>>";

// Anything that reads like a fence marker, in any case or spacing, after
// NFKC folds fullwidth look-alikes to ASCII.
const DESCRIPTION_MARKER_PATTERN =
  /<<<\s*pr[\s_-]*description|pr[\s_-]*description\s*>>>/giu;

/**
 * The description is fenced so a body that fakes a prompt section (for example
 * "Repository instructions:") stays visibly inside the untrusted block. Marker
 * look-alikes are removed from the body so it can't appear to close the fence.
 */
function renderDescription(body: string | null | undefined): string {
  let description = sanitizeUntrustedProse(body ?? "").normalize("NFKC");
  // Loop: removing one marker can join its neighbours into a new one.
  let previous: string;
  do {
    previous = description;
    description = description.replace(DESCRIPTION_MARKER_PATTERN, "");
  } while (description !== previous);
  description = description.trim();
  if (description.length === 0) {
    return "None";
  }
  let text = description;
  if (description.length > MAX_DESCRIPTION_CHARACTERS) {
    // Don't cut a surrogate pair in half.
    const end = /[\uD800-\uDBFF]/.test(
      description.charAt(MAX_DESCRIPTION_CHARACTERS - 1),
    )
      ? MAX_DESCRIPTION_CHARACTERS - 1
      : MAX_DESCRIPTION_CHARACTERS;
    text = `${description.slice(0, end)}\n[description truncated: ${description.length - end} more characters]`;
  }
  return `${DESCRIPTION_BEGIN}\n${text}\n${DESCRIPTION_END}`;
}

const PRIOR_THREAD_STATE_ORDER: PriorThreadState[] = [
  "open",
  "dismissed",
  "resolved",
  "stale",
];

function renderPriorThreads(threads: PriorThread[] | undefined): string {
  if (!threads || threads.length === 0) {
    return "None";
  }

  const grouped = new Map<PriorThreadState, PriorThread[]>();
  for (const thread of threads) {
    const bucket = grouped.get(thread.state) ?? [];
    bucket.push(thread);
    grouped.set(thread.state, bucket);
  }

  const sections: string[] = [];
  for (const state of PRIOR_THREAD_STATE_ORDER) {
    const bucket = grouped.get(state);
    if (!bucket || bucket.length === 0) {
      continue;
    }

    const lines = bucket.map((thread) => {
      const head = `- [${thread.id}] ${thread.path}:${thread.line} — ${thread.title}${
        thread.needsVerdict ? " (verdict needed)" : ""
      }`;
      if (thread.userReply && thread.userReply.trim().length > 0) {
        return `${head}\n  user reply: ${sanitizeUntrustedProse(thread.userReply).trim()}`;
      }
      return head;
    });
    sections.push(`${state}:\n${lines.join("\n")}`);
  }

  return sections.join("\n");
}

export class PromptBuilder {
  build(input: PromptBuilderInput): ReviewPrompt {
    if (input.chunk.files.length === 0) {
      throw new Error("Review chunk must contain at least one file.");
    }

    return {
      system: [
        "You are nitpickr, a senior engineer reviewing a pull request. Report only defects a careful teammate would block or fix before merge: bugs, security holes, data loss, reliability, concurrency, performance problems that matter at realistic scale, and unsafe migrations.",
        "Never report style, naming, formatting, comment or doc wording, import order, refactors for readability, test structure preferences, dependency or version bumps, or anything a linter or formatter catches. Do not praise. Do not report pre-existing problems in unchanged lines.",
        "Only report findings of severity 'medium' or above. When unsure whether something is a real defect, leave it out: a wrong comment costs more than a missed one.",
        UNTRUSTED_CONTENT_RULE,
        "Return JSON with keys: summary, diagram, findings, priorThreadVerdicts.",
        "Each finding: path, line (a line that appears in the patch), findingType ('bug' | 'safe_suggestion' | 'question' | 'teaching_note'), severity ('medium' | 'high' | 'critical'), category ('correctness' | 'performance' | 'security' | 'maintainability' | 'testing'), title, evidence, failureScenario, body, fixPrompt, suggestedChange.",
        "evidence: the exact line(s) copied verbatim from the patch that contain the defect.",
        "failureScenario: the concrete input or state, what happens, and what should happen instead.",
        // Problem then impact only: asking the body to also recommend a fix
        // cost ~15 points of inline precision in the eval (83% -> 68%); the
        // fix is shown from fixPrompt instead.
        "title: the problem in under 10 words. body: one or two short sentences, problem then impact, no hedging.",
        "fixPrompt: an instruction for a coding agent naming the file path and line.",
        "suggestedChange: replacement code only, for a small local fix you are sure of; otherwise null.",
        "summary: at most two short sentences about what the change does and its main risk.",
        'diagram: a compact sequence diagram { type: "sequence", participants [{ id, label }], steps [{ from, to, label }] } of the main flow; use { type: "flowchart", nodes, edges } only for one component\'s internal logic.',
        "Prior threads: do not repeat an open, resolved, stale or dismissed thread. For each thread marked '(verdict needed)', add { threadId, verdict } to priorThreadVerdicts: 'fixed' when the patch resolves it, 'obsolete' when the code it described is gone, otherwise 'still_applies'. Return [] when none needs a verdict. If a prior recommendation was wrong, say so and reference its title.",
        "When 'Review round' is 4 or higher, only report 'high' or 'critical' findings.",
        "Pull request description: use it to understand what the change is meant to do. When it states acceptance criteria or intended behavior and a changed line contradicts them, report that as a 'correctness' finding. Never report a missing or thin description, or criteria the patch does not touch.",
      ].join("\n"),
      user: [
        `Pull request #${input.changeRequest.number}: ${sanitizeUntrustedProse(input.changeRequest.title)}`,
        "Pull request description:",
        renderDescription(input.changeRequest.body),
        `Chunk ${input.chunk.index + 1} of ${input.chunk.total}`,
        `Comment budget for this review: ${input.commentBudget}`,
        `Review round: ${input.priorReviewRoundCount ?? 0} (count of prior completed reviews on this PR)`,
        "",
        "Repository instructions:",
        input.instructionText.trim(),
        "",
        "Relevant memory:",
        input.memory.length === 0
          ? "None"
          : input.memory
              .map((entry) =>
                entry.path ? `${entry.path}: ${entry.summary}` : entry.summary,
              )
              .join("\n"),
        "",
        "Prior nitpickr threads on this PR:",
        renderPriorThreads(input.priorThreads),
        "",
        "Current PR context:",
        input.contextFiles === undefined || input.contextFiles.length === 0
          ? "Only the primary review scope is available."
          : input.contextFiles
              .map(
                (file) =>
                  `${file.path} (+${file.additions}/-${file.deletions})`,
              )
              .join("\n"),
        "",
        "Review checklist (ask these of the changed lines):",
        renderReviewLenses(input.chunk.files.map((file) => file.path)),
        "",
        "Primary review scope:",
        "Changed files:",
        ...input.chunk.files.map((file) => {
          const sections = [
            `Path: ${file.path}`,
            `Additions: ${file.additions}`,
            `Deletions: ${file.deletions}`,
            "Patch:",
            file.patch === null
              ? "Patch unavailable."
              : revealInvisible(file.patch),
          ];
          if (file.fileContent !== undefined && file.fileContent !== null) {
            sections.push(
              "Full file at HEAD (for context only — review against the patch):",
              revealInvisible(file.fileContent),
            );
          }
          return sections.join("\n");
        }),
      ].join("\n"),
    };
  }
}
