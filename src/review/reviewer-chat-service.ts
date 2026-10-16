import type { ReviewFinding, ReviewRun } from "../domain/types.js";
import type { ReviewFeedbackOutcomeEvent } from "../feedback/review-feedback-service.js";

export type ReviewerChatCommand =
  | "why"
  | "teach"
  | "reconsider"
  | "fix"
  | "learn"
  | "status"
  | "help"
  /** Free-form question or reply; answered by the model. */
  | "ask";

export interface ReviewerChatThreadContext {
  providerCommentId: string;
  path: string;
  line: number;
  fingerprint: string;
  title: string;
  body: string;
  fixPrompt: string | null;
}

export interface ReviewerChatReply {
  body: string;
  feedbackEvents: ReviewFeedbackOutcomeEvent[];
  memoryDiscussions: Array<{
    authorLogin: string;
    body: string;
    path: string | null;
  }>;
}

/**
 * How to talk to nitpickr. Shown by `@nitpickr help` and in the first review
 * summary so the commands are discoverable without reading docs.
 */
export function renderCommandTips(botLogin = "nitpickr"): string {
  return [
    `- Reply to any of my comments, or mention \`@${botLogin}\` with a question about this PR.`,
    `- In a comment thread: \`why\` (impact), \`teach\` (principle), \`fix\` (prompt for your coding agent), \`reconsider\` (I re-check it against the code).`,
    `- \`@${botLogin} learn <preference>\` teaches me something about this repo.`,
    `- \`@${botLogin} review\` re-runs a review, \`full review\` reviews the whole PR, \`summary\` summarizes, \`status\` shows where things stand.`,
  ].join("\n");
}

function shortSha(sha: string | null | undefined): string | null {
  if (!sha) {
    return null;
  }

  return sha.trim().slice(0, 7);
}

function defaultThreadMessage(command: ReviewerChatCommand): string {
  switch (command) {
    case "status":
      return "Use this command on a PR comment or mention nitpickr in the PR conversation.";
    case "learn":
      return "Tell me what to learn after the command, for example `learn prefer explicit guards in API handlers`.";
    default:
      return "Use this command in reply to one of nitpickr's review comments so I can scope the answer to a specific finding.";
  }
}

export function parseInlineCommentContext(body: string): {
  title: string;
  body: string;
  fixPrompt: string | null;
} {
  const lines = body.split("\n");
  const titleMatch = /\*\*(.+?)\*\*/.exec(lines[0] ?? "");
  const whereIndex = lines.findIndex((line) => line.startsWith("**Where:**"));
  const bodyLine = lines
    .slice(whereIndex >= 0 ? whereIndex + 1 : 1)
    .find(
      (line) =>
        line.trim().length > 0 &&
        !line.startsWith("```") &&
        !line.startsWith("<!--") &&
        !line.startsWith("<details>") &&
        !line.startsWith("<summary>"),
    );
  const fixPromptMatch = /```text\n([\s\S]*?)\n```/.exec(body);

  return {
    title: titleMatch?.[1]?.trim() ?? "nitpickr finding",
    body: bodyLine?.trim() ?? "This finding needs a closer look.",
    fixPrompt: fixPromptMatch?.[1]?.trim() ?? null,
  };
}

function categoryFromFingerprint(
  fingerprint: string,
): ReviewFinding["category"] {
  const category = fingerprint.split(":")[2];

  switch (category) {
    case "correctness":
    case "performance":
    case "security":
    case "maintainability":
    case "testing":
    case "style":
      return category;
    default:
      return "maintainability";
  }
}

export class ReviewerChatService {
  readonly #botLogin: string;

  constructor(options: { botLogin?: string } = {}) {
    this.#botLogin = options.botLogin ?? "nitpickr";
  }

  async respond(input: {
    command: ReviewerChatCommand;
    actorLogin: string;
    argumentText?: string | null;
    latestReview?:
      | (ReviewRun & {
          createdAt: string;
          updatedAt: string;
          completedAt: string | null;
        })
      | null;
    thread?: ReviewerChatThreadContext | null;
  }): Promise<ReviewerChatReply> {
    switch (input.command) {
      case "help":
        return {
          body: renderCommandTips(this.#botLogin),
          feedbackEvents: [],
          memoryDiscussions: [],
        };
      case "ask":
        // Model-backed in the worker; this is the fallback when no model
        // responder is configured.
        return {
          body:
            "I can't answer free-form questions right now. These commands work:\n\n" +
            renderCommandTips(this.#botLogin),
          feedbackEvents: [],
          memoryDiscussions: [],
        };
      case "status":
        return {
          body: this.#buildStatusReply(input.latestReview ?? null),
          feedbackEvents: [],
          memoryDiscussions: [],
        };
      case "learn":
        if (!input.argumentText || input.argumentText.trim().length === 0) {
          return {
            body: defaultThreadMessage("learn"),
            feedbackEvents: [],
            memoryDiscussions: [],
          };
        }

        return {
          body: "Noted. I'll remember that preference for future reviews in this repo.",
          feedbackEvents: [],
          memoryDiscussions: [
            {
              authorLogin: input.actorLogin,
              body: input.argumentText.trim(),
              path: input.thread?.path ?? null,
            },
          ],
        };
      case "reconsider":
        if (!input.thread) {
          return {
            body: defaultThreadMessage("reconsider"),
            feedbackEvents: [],
            memoryDiscussions: [],
          };
        }

        return {
          body: [
            "**Reconsideration noted**",
            "",
            "I'll down-rank similar findings in this repo unless later evidence makes the issue clearer.",
          ].join("\n"),
          feedbackEvents: [
            {
              fingerprint: input.thread.fingerprint,
              path: input.thread.path,
              category: categoryFromFingerprint(input.thread.fingerprint),
              kind: "ignored",
            },
          ],
          memoryDiscussions: [],
        };
      case "why":
        if (!input.thread) {
          return {
            body: defaultThreadMessage("why"),
            feedbackEvents: [],
            memoryDiscussions: [],
          };
        }

        return {
          body: [
            "**Why this matters**",
            "",
            `**Finding:** ${input.thread.title}`,
            `**Where:** \`${input.thread.path}:${input.thread.line}\``,
            "",
            input.thread.body,
          ].join("\n"),
          feedbackEvents: [],
          memoryDiscussions: [],
        };
      case "teach":
        if (!input.thread) {
          return {
            body: defaultThreadMessage("teach"),
            feedbackEvents: [],
            memoryDiscussions: [],
          };
        }

        return {
          body: [
            "**Implementation note**",
            "",
            `**Finding:** ${input.thread.title}`,
            `**Where:** \`${input.thread.path}:${input.thread.line}\``,
            "",
            input.thread.body,
            "",
            input.thread.fixPrompt
              ? `**Suggested implementation direction:** ${input.thread.fixPrompt}`
              : "Use the surrounding code path to implement the smallest change that removes the failure mode.",
          ].join("\n"),
          feedbackEvents: [],
          memoryDiscussions: [],
        };
      case "fix":
        if (!input.thread) {
          return {
            body: defaultThreadMessage("fix"),
            feedbackEvents: [],
            memoryDiscussions: [],
          };
        }

        return {
          body: [
            "**Fix prompt**",
            "",
            `Use this on \`${input.thread.path}:${input.thread.line}\`:`,
            "",
            "```text",
            input.thread.fixPrompt ??
              `In \`${input.thread.path}\` around line ${input.thread.line}, address: ${input.thread.title}.`,
            "```",
          ].join("\n"),
          feedbackEvents: [],
          memoryDiscussions: [],
        };
    }
  }

  #buildStatusReply(
    latestReview:
      | (ReviewRun & {
          createdAt: string;
          updatedAt: string;
          completedAt: string | null;
        })
      | null,
  ): string {
    if (!latestReview) {
      return [
        "**nitpickr status**",
        "",
        "I haven't published a review on this pull request yet.",
      ].join("\n");
    }

    return [
      "**nitpickr status**",
      "",
      `Latest review state: \`${latestReview.status}\``,
      `Scope: \`${latestReview.scope}\``,
      shortSha(latestReview.headSha)
        ? `Head: \`${shortSha(latestReview.headSha)}\``
        : null,
      latestReview.completedAt
        ? `Completed: ${latestReview.completedAt}`
        : "This review is still running.",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }
}
