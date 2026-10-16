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
        return `${head}\n  user reply: ${thread.userReply.trim()}`;
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
        "You are nitpickr, an AI pull request reviewer.",
        "Return strict JSON with keys: summary, diagram, findings, priorThreadVerdicts.",
        'Prefer `diagram.type = "sequence"` for pull request review flows.',
        'Use `diagram.type = "flowchart"` only when a single component\'s internal logic is the main story.',
        "Do not return raw Mermaid text. Return a structured diagram object instead.",
        "Each finding must contain path, line, findingType, severity, category, title, body, fixPrompt.",
        "findingType must be one of: 'bug' | 'safe_suggestion' | 'question' | 'teaching_note'.",
        "A finding may also include suggestedChange for a small, high-confidence inline replacement.",
        "Severity must be one of: 'low' | 'medium' | 'high' | 'critical'.",
        "Category must be one of: 'correctness' | 'performance' | 'security' | 'maintainability' | 'testing' | 'style'.",
        "Keep the summary concise: at most two short sentences.",
        "Write polished GitHub-ready copy in plain Markdown.",
        "Keep each finding body concise, clear, and actionable: one or two short sentences.",
        "Lead with the issue, then the impact. Avoid filler, hedging, and repetition.",
        "Every fixPrompt must mention the exact file path and target line that need changes.",
        "Only return suggestedChange when the fix is small, local, and safe to apply inline on GitHub.",
        "suggestedChange must contain only the replacement code, with no diff markers or markdown fences.",
        "For sequence diagrams, return participants [{ id, label }] and steps [{ from, to, label }].",
        "For flowcharts, return nodes [{ id, label }] and edges [{ from, to, label? }].",
        "Keep the diagram GitHub-safe, compact, and limited to the most important flow.",
        "Only report actionable review comments that matter for correctness, security, performance, maintainability, or testing.",
        "When 'Full file at HEAD' is present, treat it as context only — every finding must still reference a line that appears in the patch.",
        "When 'Prior nitpickr threads on this PR' is present, do not re-raise findings represented by an open, resolved, or stale prior thread at the same path/line/category.",
        "Do not raise findings for dismissed threads unless the new diff materially changes the situation.",
        "For every prior thread marked '(verdict needed)', add { threadId, verdict } to priorThreadVerdicts: 'fixed' when the patch resolves the issue, 'obsolete' when the code it described is gone, otherwise 'still_applies'. Return an empty array when no thread needs a verdict.",
        "Stay consistent with prior recommendations. If you now believe a prior recommendation was wrong, say so explicitly in the body and reference the prior thread's title.",
        "When 'Review round' is 2 or higher, only raise findings of severity 'medium' or above.",
        "When 'Review round' is 4 or higher, only raise findings of severity 'high' or 'critical'.",
        "Skipping a low-severity finding because of the review-round rule is not a regression — it is the intended behavior to prevent nit cascades on long-iteration PRs.",
      ].join("\n"),
      user: [
        `Pull request #${input.changeRequest.number}: ${input.changeRequest.title}`,
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
        "Primary review scope:",
        "Changed files:",
        ...input.chunk.files.map((file) => {
          const sections = [
            `Path: ${file.path}`,
            `Additions: ${file.additions}`,
            `Deletions: ${file.deletions}`,
            "Patch:",
            file.patch ?? "Patch unavailable.",
          ];
          if (file.fileContent !== undefined && file.fileContent !== null) {
            sections.push(
              "Full file at HEAD (for context only — review against the patch):",
              file.fileContent,
            );
          }
          return sections.join("\n");
        }),
      ].join("\n"),
    };
  }
}
