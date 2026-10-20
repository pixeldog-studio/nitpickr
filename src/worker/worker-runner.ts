import { ZodError } from "zod";

import { parseReviewTrigger, type ReviewRun } from "../domain/types.js";
import type { ReviewFeedbackService } from "../feedback/review-feedback-service.js";
import type { InstructionBundle } from "../instructions/instruction-loader.js";
import { withTiming } from "../logging/correlation.js";
import { type Logger, noopLogger } from "../logging/logger.js";
import type { DiscussionAcknowledgmentStore } from "../memory/discussion-acknowledgment-store.js";
import {
  DISMISSAL_SIMILARITY,
  dismissalThreshold,
  dismissedCategory,
} from "../memory/dismissal-policy.js";
import type { MemoryEntry, MemoryService } from "../memory/memory-service.js";
import { captureError } from "../observability/sentry.js";
import type {
  GitHubAdapter,
  GitHubChangeRequestContext,
} from "../providers/github/github-adapter.js";
import type { ReviewPublisher } from "../publisher/review-publisher.js";
import type { ReviewStatusPublisher } from "../publisher/review-status-publisher.js";
import type { QueueJob, QueueScheduler } from "../queue/queue-scheduler.js";
import type {
  ConversationResponder,
  ConversationThread,
} from "../review/conversation-responder.js";
import { fingerprintFinding } from "../review/finding-fingerprint.js";
import type {
  PriorThread,
  PriorThreadState,
  PriorThreadVerdict,
} from "../review/prompt-builder.js";
import type { PromptOptimizationMode } from "../review/prompt-payload-optimizer.js";
import type {
  ReviewEngine,
  ReviewEngineResult,
  ReviewFinding,
} from "../review/review-engine.js";
import type { ReviewLifecycleService } from "../review/review-lifecycle-service.js";
import type { ReviewPlanner } from "../review/review-planner.js";
import {
  parseInlineCommentContext,
  type ReviewerChatCommand,
  type ReviewerChatReply,
  ReviewerChatService,
} from "../review/reviewer-chat-service.js";
import {
  applySeverityFloor,
  severityFloorForRound,
} from "../review/severity-floor.js";
import { neutralizeMarkdown } from "../review/untrusted-content.js";
import { ModelOutputError } from "../shared/model-output.js";

const REVIEW_DURATION_BUDGET_MS = 300_000;

function emptyPromptUsageSnapshot() {
  return {
    chunkCount: 0,
    primaryPatchChars: 0,
    contextPatchChars: 0,
    instructionChars: 0,
    memoryChars: 0,
    estimatedPromptTokens: 0,
  };
}

type ReviewFailureClass =
  | "config_setup"
  | "github_api"
  | "model_output"
  | "publish_failure"
  | "internal_processing";

class ReviewJobError extends Error {
  readonly failureClass: ReviewFailureClass;
  readonly retryable: boolean;

  constructor(
    failureClass: ReviewFailureClass,
    retryable: boolean,
    message: string,
  ) {
    super(message);
    this.failureClass = failureClass;
    this.retryable = retryable;
  }
}

function extractStatusCode(message: string): number | null {
  const match = /status\s+(\d{3})/i.exec(message);
  if (!match?.[1]) {
    return null;
  }

  return Number.parseInt(match[1], 10);
}

function isRetryableHttpError(message: string): boolean {
  const statusCode = extractStatusCode(message);
  return statusCode === 429 || (statusCode !== null && statusCode >= 500);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown worker error.";
}

/** Whether a comment @-mentions the bot (with or without the [bot] suffix). */
function mentionsBot(body: string, botLogin: string): boolean {
  const login = botLogin.replace(/\[bot\]$/i, "").toLowerCase();
  return body.toLowerCase().includes(`@${login}`);
}

/** A failure in plain words for the PR, without stack traces or bodies. */
export function describeReviewFailure(error: unknown): string {
  const message = toErrorMessage(error);
  // Who failed comes first: a GitHub timeout is not a slow model.
  const failureClass =
    error instanceof ReviewJobError ? error.failureClass : null;
  if (failureClass === "github_api") {
    return "a GitHub API request failed";
  }
  if (failureClass === "config_setup") {
    return "nitpickr's setup is incomplete";
  }
  if (failureClass === "publish_failure") {
    return "posting the review to GitHub failed";
  }
  if (/timed out|TimeoutError|aborted due to timeout/i.test(message)) {
    return "the local model took longer than the request limit on part of this PR";
  }
  if (/token cap|length limit/i.test(message)) {
    return "the model's reply kept running past its length limit";
  }
  if (/stopped serving/i.test(message)) {
    return "the local model server stopped serving the model (it usually needs a restart)";
  }
  if (/fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(message)) {
    return "the local model server wasn't reachable";
  }
  return "an unexpected error stopped it";
}

function classifyReviewError(
  stage: "config" | "github" | "review" | "publish",
  error: unknown,
): ReviewJobError {
  if (error instanceof ReviewJobError) {
    return error;
  }

  const message = toErrorMessage(error);
  if (stage === "config") {
    return new ReviewJobError("config_setup", false, message);
  }
  if (stage === "github") {
    return new ReviewJobError(
      "github_api",
      isRetryableHttpError(message),
      message,
    );
  }
  if (stage === "review") {
    // Malformed/empty model output, client timeouts, and schema mismatches
    // are transient for LLM backends (especially local models) — retry them.
    const retryable =
      isRetryableHttpError(message) ||
      error instanceof ModelOutputError ||
      error instanceof ZodError;
    return new ReviewJobError("model_output", retryable, message);
  }

  return new ReviewJobError(
    "publish_failure",
    isRetryableHttpError(message),
    message,
  );
}

function stripSuggestedChanges(result: ReviewEngineResult): ReviewEngineResult {
  return {
    ...result,
    findings: result.findings.map((finding) => ({
      ...finding,
      suggestedChange: undefined,
    })),
  };
}

function prependSummaryReason(
  result: ReviewEngineResult,
  summaryOnlyReason: string | null,
): ReviewEngineResult {
  if (!summaryOnlyReason) {
    return result;
  }

  return {
    ...result,
    summary: `${summaryOnlyReason}\n\n${result.summary}`.trim(),
  };
}

const MEMORY_ROLLUP_LIMIT = 5;

function prependMemoryRollup(
  result: ReviewEngineResult,
  memories: MemoryEntry[],
): ReviewEngineResult {
  if (memories.length === 0) {
    return result;
  }

  const lines = memories
    .slice(0, MEMORY_ROLLUP_LIMIT)
    .map((memory) => `- ${memory.summary}`);
  const rollup = ["**What nitpickr has learned about this repo:**", ...lines]
    .join("\n")
    .trim();

  return {
    ...result,
    summary: `${rollup}\n\n${result.summary}`.trim(),
  };
}

function determineReviewScope(
  trigger: ReturnType<typeof parseReviewTrigger>,
  hasCompletedReview: boolean,
): ReviewRun["scope"] {
  // A push with no earlier review (e.g. the opened job never ran) gets the
  // full-PR review and summary instead of a delta against nothing.
  return trigger.type === "pr_synchronized" && hasCompletedReview
    ? "commit_delta"
    : "full_pr";
}

function isAutomaticTrigger(
  trigger: ReturnType<typeof parseReviewTrigger>,
): boolean {
  return (
    trigger.type === "pr_opened" ||
    trigger.type === "pr_ready_for_review" ||
    trigger.type === "pr_synchronized"
  );
}

function selectPublishableResult(
  result: ReviewEngineResult,
  trigger: ReturnType<typeof parseReviewTrigger>,
): ReviewEngineResult {
  if (!isAutomaticTrigger(trigger)) {
    return result;
  }

  return {
    ...result,
    findings: result.findings.filter(
      (finding) =>
        finding.findingType === "bug" ||
        finding.findingType === "safe_suggestion",
    ),
  };
}

async function enrichPublishedCommentsWithProviderMetadata(
  comments: Array<{
    path: string;
    line: number;
    body: string;
    fingerprint?: string | null;
    providerThreadId?: string | null;
    providerCommentId?: string | null;
    resolvedAt?: string | null;
  }>,
  threads: Array<{
    threadId: string;
    providerCommentId: string;
    path: string;
    line: number;
    fingerprint: string;
    isResolved: boolean;
  }>,
): Promise<
  Array<{
    path: string;
    line: number;
    body: string;
    providerThreadId: string | null;
    providerCommentId: string | null;
    fingerprint: string | null;
    resolvedAt: string | null;
  }>
> {
  return comments.map((comment) => {
    const thread =
      comment.fingerprint === undefined
        ? null
        : (threads.find(
            (candidate) => candidate.fingerprint === comment.fingerprint,
          ) ?? null);

    return {
      path: comment.path,
      line: comment.line,
      body: comment.body,
      providerThreadId: thread?.threadId ?? null,
      providerCommentId: thread?.providerCommentId ?? null,
      fingerprint: comment.fingerprint ?? null,
      resolvedAt: null,
    };
  });
}

const PRIOR_THREAD_TITLE_MAX_LENGTH = 120;
const PRIOR_THREAD_REPLY_MAX_LENGTH = 240;

function summarizeThreadTitle(body: string): string {
  const flattened = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/[*_~>#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (flattened.length <= PRIOR_THREAD_TITLE_MAX_LENGTH) {
    return flattened;
  }
  return `${flattened.slice(0, PRIOR_THREAD_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

function summarizeThreadReply(body: string): string {
  const flattened = body.replace(/\s+/g, " ").trim();
  if (flattened.length <= PRIOR_THREAD_REPLY_MAX_LENGTH) {
    return flattened;
  }
  return `${flattened.slice(0, PRIOR_THREAD_REPLY_MAX_LENGTH - 1).trimEnd()}…`;
}

function formatAcknowledgmentReply(input: {
  acknowledgments: string[];
  savedEntries: Array<{ summary: string; supersededBy: string | null }>;
}): string {
  const lines: string[] = [];
  const intro =
    input.acknowledgments.find(
      (text) => typeof text === "string" && text.trim().length > 0,
    ) ?? "Thanks — noted.";
  lines.push(intro);

  if (input.savedEntries.length > 0) {
    lines.push("");
    lines.push("**What I'll remember:**");
    for (const entry of input.savedEntries) {
      lines.push(`- ${entry.summary}`);
    }
  }

  return lines.join("\n");
}

const MAX_FILE_CONTENT_BYTES = 200_000;
const FILE_CONTENT_FETCH_CONCURRENCY = 6;

async function fetchPrimaryFileContents(input: {
  files: Array<{ path: string; patch: string | null }>;
  headSha: string;
  installationId: string;
  repository: { owner: string; name: string };
  getFileContent: (request: {
    installationId: string;
    repository: { owner: string; name: string };
    path: string;
    ref: string;
  }) => Promise<string | null>;
  logger: Logger;
}): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  const queue = [...input.files];
  const workers: Array<Promise<void>> = [];

  const runNext = async (): Promise<void> => {
    while (queue.length > 0) {
      const file = queue.shift();
      if (!file) {
        return;
      }
      try {
        const content = await input.getFileContent({
          installationId: input.installationId,
          repository: input.repository,
          path: file.path,
          ref: input.headSha,
        });
        if (content === null) {
          continue;
        }
        if (Buffer.byteLength(content, "utf8") > MAX_FILE_CONTENT_BYTES) {
          input.logger.debug(
            "Skipping full file content because it exceeds the size cap.",
            { path: file.path, sha: input.headSha },
          );
          continue;
        }
        contents.set(file.path, content);
      } catch (error) {
        input.logger.warn("Failed to fetch full file content for review.", {
          path: file.path,
          sha: input.headSha,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const concurrency = Math.min(
    FILE_CONTENT_FETCH_CONCURRENCY,
    Math.max(1, input.files.length),
  );
  for (let workerIndex = 0; workerIndex < concurrency; workerIndex += 1) {
    workers.push(runNext());
  }
  await Promise.all(workers);
  return contents;
}

function extractPatchLineRanges(patch: string | null): Set<number> {
  const lines = new Set<number>();
  if (!patch) {
    return lines;
  }
  const hunkRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let match: RegExpExecArray | null = hunkRegex.exec(patch);
  while (match !== null) {
    const start = Number.parseInt(match[1] ?? "0", 10);
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    if (Number.isFinite(start) && Number.isFinite(count)) {
      for (let offset = 0; offset < count; offset += 1) {
        lines.add(start + offset);
      }
    }
    match = hunkRegex.exec(patch);
  }
  return lines;
}

/** Lines around a thread that, when changed, ask the model for a verdict. */
const PRIOR_THREAD_VERDICT_LINE_WINDOW = 3;

function buildPriorThreads(input: {
  scope: ReviewRun["scope"];
  existingThreads: Array<{
    threadId: string;
    providerCommentId: string;
    path: string;
    line: number;
    fingerprint: string;
    isResolved: boolean;
    isOutdated?: boolean;
    body: string;
    reactionSummary: { positiveCount: number; negativeCount: number };
  }>;
  reviewedFiles: Array<{ path: string; patch: string | null }>;
  discussionComments: Array<{
    authorLogin: string;
    body: string;
    path: string | null;
    line: number | null;
    createdAt: string;
  }>;
}): PriorThread[] {
  const reviewedPathSet = new Set(input.reviewedFiles.map((f) => f.path));
  const changedLinesByPath = new Map<string, Set<number>>();
  for (const file of input.reviewedFiles) {
    changedLinesByPath.set(file.path, extractPatchLineRanges(file.patch));
  }

  const userRepliesByKey = new Map<
    string,
    { body: string; createdAt: string }
  >();
  for (const comment of input.discussionComments) {
    if (
      comment.path === null ||
      comment.line === null ||
      comment.body.trim().length === 0
    ) {
      continue;
    }
    if (comment.authorLogin.toLowerCase().endsWith("[bot]")) {
      continue;
    }
    const key = `${comment.path}:${comment.line}`;
    const existing = userRepliesByKey.get(key);
    if (!existing || existing.createdAt < comment.createdAt) {
      userRepliesByKey.set(key, {
        body: comment.body,
        createdAt: comment.createdAt,
      });
    }
  }

  return input.existingThreads.map((thread, index) => {
    const changedLines = changedLinesByPath.get(thread.path);
    let changedNearThread = false;
    for (
      let line = thread.line - PRIOR_THREAD_VERDICT_LINE_WINDOW;
      line <= thread.line + PRIOR_THREAD_VERDICT_LINE_WINDOW;
      line += 1
    ) {
      if (changedLines?.has(line)) {
        changedNearThread = true;
        break;
      }
    }
    let state: PriorThreadState;
    if (thread.isResolved) {
      state = "resolved";
    } else if (
      reviewedPathSet.has(thread.path) &&
      !(changedLinesByPath.get(thread.path)?.has(thread.line) ?? false)
    ) {
      state = "stale";
    } else if (thread.reactionSummary.negativeCount > 0) {
      state = "dismissed";
    } else {
      state = "open";
    }

    const reply = userRepliesByKey.get(`${thread.path}:${thread.line}`);
    const priorThread: PriorThread = {
      id: `T${index + 1}`,
      // Only a push (commit delta) can show whether a thread was fixed; a
      // full-PR patch compares against the base, not the earlier review.
      // An outdated thread means a push rewrote its line: the most common
      // shape of a fix, so it needs a verdict too.
      needsVerdict:
        input.scope === "commit_delta" &&
        !thread.isResolved &&
        reviewedPathSet.has(thread.path) &&
        (changedNearThread || thread.isOutdated === true),
      path: thread.path,
      line: thread.line,
      state,
      title: summarizeThreadTitle(thread.body),
      fingerprint: thread.fingerprint,
    };
    if (reply) {
      priorThread.userReply = summarizeThreadReply(reply.body);
    }
    return priorThread;
  });
}

/**
 * Threads to resolve after a review round. A thread is resolved only when the
 * model returned an explicit `fixed` or `obsolete` verdict for a thread that
 * needed one; a finding simply not being raised again is not evidence of a
 * fix. `priorThreads` must be built from `existingThreads` (same order).
 */
export function selectThreadsToResolve<TThread>(input: {
  priorThreads: PriorThread[];
  existingThreads: TThread[];
  verdicts: Array<{ threadId: string; verdict: PriorThreadVerdict }>;
}): Array<{ thread: TThread; verdict: "fixed" | "obsolete" }> {
  const verdictByThreadId = new Map(
    input.verdicts.map((entry) => [entry.threadId, entry.verdict]),
  );
  return input.priorThreads.flatMap((priorThread, index) => {
    const verdict = verdictByThreadId.get(priorThread.id);
    const thread = input.existingThreads[index];
    if (
      !priorThread.needsVerdict ||
      thread === undefined ||
      (verdict !== "fixed" && verdict !== "obsolete")
    ) {
      return [];
    }
    return [{ thread, verdict }];
  });
}

function categoryFromFingerprint(
  fingerprint: string,
): ReviewEngineResult["findings"][number]["category"] {
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

type ReviewStatusPhase = "pending" | "published" | "skipped" | "failed";

const noopStatusPublisher: Pick<
  ReviewStatusPublisher,
  "markFailed" | "markPending" | "markPublished" | "markSkipped"
> &
  Partial<
    Pick<
      ReviewStatusPublisher,
      "markSuperseded" | "markClosed" | "markRequeued"
    >
  > = {
  async markFailed() {
    return undefined;
  },
  async markPending() {
    return "noop-check-run";
  },
  async markPublished() {},
  async markSkipped() {},
};

type QueuedCheckOutcome =
  | { kind: "retry"; summary: string }
  | {
      kind: "close";
      conclusion: "success" | "neutral" | "failure";
      title: string;
      summary: string;
    };

/** The check the API created when the job was queued, and whether it's done. */
interface QueuedCheck {
  checkRunId: string | null;
  settled: boolean;
  /** Why the job ended without a review, when it did. */
  endedEarly: QueuedCheckOutcome | null;
}

function parseReviewJobPayload(payload: QueueJob["payload"]): {
  correlationId: string | null;
  installationId: string;
  repository: {
    owner: string;
    name: string;
  };
  pullNumber: number;
  mode: ReviewRun["mode"];
  trigger: ReturnType<typeof parseReviewTrigger>;
  /** Commit the job was queued for; null for comment commands. */
  headSha: string | null;
  /** The queued check the API created for this job, if any. */
  checkRunId: string | null;
  /** The commit that check is on. */
  checkRunSha: string | null;
} {
  const installationId = payload.installationId;
  const repository = payload.repository as Record<string, unknown> | undefined;
  const pullNumber = payload.pullNumber;
  const mode = payload.mode;
  const correlationId =
    typeof payload.correlationId === "string" &&
    payload.correlationId.trim().length > 0
      ? payload.correlationId
      : null;

  if (
    typeof installationId !== "string" ||
    installationId.trim().length === 0
  ) {
    throw new Error("review job installationId must not be empty.");
  }
  if (
    typeof repository !== "object" ||
    repository === null ||
    typeof repository.owner !== "string" ||
    repository.owner.trim().length === 0 ||
    typeof repository.name !== "string" ||
    repository.name.trim().length === 0
  ) {
    throw new Error("review job repository must be present.");
  }
  if (
    typeof pullNumber !== "number" ||
    !Number.isInteger(pullNumber) ||
    pullNumber <= 0
  ) {
    throw new Error("review job pullNumber must be positive.");
  }
  if (mode !== "quick" && mode !== "full" && mode !== "summary") {
    throw new Error("review job mode is invalid.");
  }

  return {
    correlationId,
    installationId,
    repository: {
      owner: repository.owner,
      name: repository.name,
    },
    pullNumber,
    mode,
    trigger: parseReviewTrigger(payload.trigger),
    headSha:
      typeof payload.headSha === "string" && payload.headSha.length > 0
        ? payload.headSha
        : null,
    checkRunId:
      typeof payload.checkRunId === "string" && payload.checkRunId.length > 0
        ? payload.checkRunId
        : null,
    checkRunSha:
      typeof payload.checkRunSha === "string" && payload.checkRunSha.length > 0
        ? payload.checkRunSha
        : null,
  };
}

function parseMemoryJobPayload(payload: QueueJob["payload"]): {
  discussions: Array<{
    authorLogin: string;
    body: string;
    path: string | null;
  }>;
  acknowledgment: {
    installationId: string;
    repository: { owner: string; name: string };
    pullNumber: number;
    providerCommentId: string;
    sourceKind: "issue_comment" | "review_comment";
    commentNumericId: number;
  } | null;
} {
  const discussions = payload.discussions;

  if (!Array.isArray(discussions)) {
    throw new Error("memory job discussions must be an array.");
  }

  const ackRaw = payload.acknowledgment as Record<string, unknown> | undefined;
  let acknowledgment: ReturnType<
    typeof parseMemoryJobPayload
  >["acknowledgment"] = null;
  if (ackRaw && typeof ackRaw === "object") {
    const repo = ackRaw.repository as Record<string, unknown> | undefined;
    if (
      typeof ackRaw.installationId === "string" &&
      ackRaw.installationId.trim().length > 0 &&
      repo &&
      typeof repo.owner === "string" &&
      typeof repo.name === "string" &&
      typeof ackRaw.pullNumber === "number" &&
      Number.isInteger(ackRaw.pullNumber) &&
      typeof ackRaw.providerCommentId === "string" &&
      ackRaw.providerCommentId.length > 0 &&
      (ackRaw.sourceKind === "issue_comment" ||
        ackRaw.sourceKind === "review_comment") &&
      typeof ackRaw.commentNumericId === "number" &&
      Number.isInteger(ackRaw.commentNumericId)
    ) {
      acknowledgment = {
        installationId: ackRaw.installationId,
        repository: { owner: repo.owner, name: repo.name },
        pullNumber: ackRaw.pullNumber,
        providerCommentId: ackRaw.providerCommentId,
        sourceKind: ackRaw.sourceKind,
        commentNumericId: ackRaw.commentNumericId,
      };
    }
  }

  return {
    discussions: discussions.map((discussion) => {
      if (
        typeof discussion !== "object" ||
        discussion === null ||
        typeof discussion.authorLogin !== "string" ||
        discussion.authorLogin.trim().length === 0 ||
        typeof discussion.body !== "string" ||
        discussion.body.trim().length === 0
      ) {
        throw new Error("memory job discussion is invalid.");
      }

      return {
        authorLogin: discussion.authorLogin,
        body: discussion.body,
        path:
          typeof discussion.path === "string"
            ? discussion.path
            : (discussion.path ?? null),
      };
    }),
    acknowledgment,
  };
}

function parseInteractionJobPayload(payload: QueueJob["payload"]): {
  correlationId: string | null;
  installationId: string;
  repository: {
    owner: string;
    name: string;
  };
  pullNumber: number;
  actorLogin: string;
  command: ReviewerChatCommand;
  replyTargetCommentId: number | null;
  source:
    | {
        kind: "issue_comment";
        commentId: number;
        body: string;
        argumentText: string | null;
      }
    | {
        kind: "review_comment";
        commentId: number;
        body: string;
        argumentText: string | null;
        path: string | null;
        line: number | null;
      };
} {
  const installationId = payload.installationId;
  const repository = payload.repository as Record<string, unknown> | undefined;
  const pullNumber = payload.pullNumber;
  const actorLogin = payload.actorLogin;
  const command = payload.command;
  const source = payload.source as Record<string, unknown> | undefined;
  const correlationId =
    typeof payload.correlationId === "string" &&
    payload.correlationId.trim().length > 0
      ? payload.correlationId
      : null;

  if (
    typeof installationId !== "string" ||
    installationId.trim().length === 0
  ) {
    throw new Error("interaction job installationId must not be empty.");
  }
  if (
    typeof repository !== "object" ||
    repository === null ||
    typeof repository.owner !== "string" ||
    repository.owner.trim().length === 0 ||
    typeof repository.name !== "string" ||
    repository.name.trim().length === 0
  ) {
    throw new Error("interaction job repository must be present.");
  }
  if (
    typeof pullNumber !== "number" ||
    !Number.isInteger(pullNumber) ||
    pullNumber <= 0
  ) {
    throw new Error("interaction job pullNumber must be positive.");
  }
  if (typeof actorLogin !== "string" || actorLogin.trim().length === 0) {
    throw new Error("interaction job actorLogin must not be empty.");
  }
  if (
    command !== "why" &&
    command !== "teach" &&
    command !== "reconsider" &&
    command !== "fix" &&
    command !== "learn" &&
    command !== "status" &&
    command !== "help" &&
    command !== "ask"
  ) {
    throw new Error("interaction job command is invalid.");
  }
  if (
    typeof source !== "object" ||
    source === null ||
    typeof source.kind !== "string"
  ) {
    throw new Error("interaction job source must be present.");
  }

  if (source.kind === "issue_comment") {
    if (
      typeof source.commentId !== "number" ||
      !Number.isInteger(source.commentId) ||
      source.commentId <= 0 ||
      typeof source.body !== "string"
    ) {
      throw new Error("interaction issue comment source is invalid.");
    }

    return {
      correlationId,
      installationId,
      repository: {
        owner: repository.owner,
        name: repository.name,
      },
      pullNumber,
      actorLogin,
      command,
      replyTargetCommentId:
        typeof payload.replyTargetCommentId === "number" &&
        Number.isInteger(payload.replyTargetCommentId) &&
        payload.replyTargetCommentId > 0
          ? payload.replyTargetCommentId
          : null,
      source: {
        kind: "issue_comment",
        commentId: source.commentId,
        body: source.body,
        argumentText:
          typeof source.argumentText === "string" ? source.argumentText : null,
      },
    };
  }

  if (
    source.kind === "review_comment" &&
    typeof source.commentId === "number" &&
    Number.isInteger(source.commentId) &&
    source.commentId > 0 &&
    typeof source.body === "string"
  ) {
    return {
      correlationId,
      installationId,
      repository: {
        owner: repository.owner,
        name: repository.name,
      },
      pullNumber,
      actorLogin,
      command,
      replyTargetCommentId:
        typeof payload.replyTargetCommentId === "number" &&
        Number.isInteger(payload.replyTargetCommentId) &&
        payload.replyTargetCommentId > 0
          ? payload.replyTargetCommentId
          : null,
      source: {
        kind: "review_comment",
        commentId: source.commentId,
        body: source.body,
        argumentText:
          typeof source.argumentText === "string" ? source.argumentText : null,
        path: typeof source.path === "string" ? source.path : null,
        line:
          typeof source.line === "number" &&
          Number.isInteger(source.line) &&
          source.line > 0
            ? source.line
            : null,
      },
    };
  }

  throw new Error("interaction job source is invalid.");
}

export interface InstructionBundleLoader {
  loadForReview(
    context: GitHubChangeRequestContext,
  ): Promise<InstructionBundle>;
}

export interface WorkerRunnerDependencies {
  logger?: Logger;
  /** `owner/name` entries; jobs for other repositories are skipped. */
  repositoryAllowlist?: string[] | null;
  promptOptimizationMode?: PromptOptimizationMode;
  queueScheduler: Pick<
    QueueScheduler,
    "claimNextJobs" | "cancelSupersededReviewJobs" | "completeJob" | "failJob"
  >;
  githubAdapter: Pick<GitHubAdapter, "fetchChangeRequestContext"> &
    Partial<
      Pick<
        GitHubAdapter,
        | "comparePullRequestRange"
        | "createIssueComment"
        | "createIssueCommentReaction"
        | "getFileContent"
        | "listNitpickrReviewThreads"
        | "replyToReviewComment"
        | "resolveReviewThread"
      >
    >;
  instructionBundleLoader: InstructionBundleLoader;
  memoryService: Pick<
    MemoryService,
    "getRelevantMemories" | "ingestDiscussion"
  > &
    Partial<
      Pick<
        MemoryService,
        | "selectMemoriesForReview"
        | "recordDismissedFinding"
        | "findSimilarDismissals"
      >
    >;
  discussionAcknowledgmentStore?: DiscussionAcknowledgmentStore;
  now?: () => Date;
  feedbackService?: Pick<
    ReviewFeedbackService,
    "getSignals" | "recordOutcome" | "syncCommentReactions"
  >;
  reviewPlanner: Pick<ReviewPlanner, "plan">;
  reviewerChatService?: Pick<ReviewerChatService, "respond">;
  /** Handle shown in command help, e.g. the GitHub App's login. */
  botLogin?: string;
  /** Model-backed answers for ask/why/teach and verifier-backed reconsider. */
  conversationResponder?: Pick<ConversationResponder, "answer" | "reconsider">;
  reviewLifecycle: Pick<
    ReviewLifecycleService,
    "startReview" | "completeReview" | "failReview"
  > &
    Partial<
      Pick<
        ReviewLifecycleService,
        | "getLatestCompletedReview"
        | "markPublishedCommentsResolved"
        | "countCompletedReviews"
      >
    >;
  reviewEngine: Pick<ReviewEngine, "review"> &
    Partial<Pick<ReviewEngine, "reviewWithDiagnostics">>;
  publisher: Pick<ReviewPublisher, "buildInlineComments" | "publish">;
  statusPublisher?: Pick<
    ReviewStatusPublisher,
    "markFailed" | "markPending" | "markPublished" | "markSkipped"
  > &
    Partial<
      Pick<
        ReviewStatusPublisher,
        "markSuperseded" | "markClosed" | "markRequeued"
      >
    >;
}

export interface LearnableThread {
  threadId: string;
  path: string;
  fingerprint: string;
  isResolved: boolean;
  isOutdated?: boolean;
  /** Commit the comment was made on; needed to tell whether code changed. */
  originalCommitSha?: string;
  body: string;
  reactionSummary: {
    negativeCount: number;
    /** Logins behind the negative reactions, when the provider lists them. */
    negativeReactors?: string[];
  };
}

/**
 * Learn from how people treated earlier nitpickr threads: a thread a human
 * resolved without changing its lines, or one that got a thumbs-down, is a
 * finding this repo does not want. Each settled thread is recorded once
 * (published_comments.resolved_at marks it as processed; threads nitpickr
 * resolved itself are already marked).
 */
export async function learnFromThreads(input: {
  job: Pick<QueueJob, "id" | "tenantId" | "repositoryId">;
  threads: LearnableThread[];
  logger: Logger;
  memoryService: Partial<
    Pick<
      MemoryService,
      | "recordDismissedFinding"
      | "findSimilarDismissals"
      | "hasDismissalFromThread"
    >
  >;
  /**
   * Whether `path` changed between `sinceSha` and the PR head. A thread a
   * human resolved after changing the file was probably fixed, not dismissed.
   * Without it (or without the thread's commit) nothing is learned.
   */
  fileChangedSince?: (path: string, sinceSha: string) => Promise<boolean>;
  feedbackService?: Pick<ReviewFeedbackService, "recordOutcome">;
  reviewLifecycle: {
    markPublishedCommentsResolved?: (ids: string[]) => Promise<number>;
  };
  /** Logins whose reactions count (see trustedNegativeReactions). */
  trustedReactors: string[];
}): Promise<void> {
  const { job, threads, logger } = input;
  const record = input.memoryService.recordDismissedFinding?.bind(
    input.memoryService,
  );
  for (const thread of threads) {
    try {
      const parsed = parseInlineCommentContext(thread.body);
      if (thread.isResolved && thread.isOutdated !== true) {
        const newlySettled =
          (await input.reviewLifecycle.markPublishedCommentsResolved?.([
            thread.threadId,
          ])) ?? 0;
        const unchanged =
          newlySettled > 0 &&
          thread.originalCommitSha !== undefined &&
          input.fileChangedSince !== undefined &&
          !(await input.fileChangedSince(
            thread.path,
            thread.originalCommitSha,
          ));
        if (unchanged) {
          await input.feedbackService?.recordOutcome({
            tenantId: job.tenantId,
            repositoryId: job.repositoryId,
            events: [
              {
                fingerprint: thread.fingerprint,
                path: thread.path,
                category: categoryFromFingerprint(thread.fingerprint),
                kind: "resolved_without_code_change",
              },
            ],
          });
          await record?.({
            tenantId: job.tenantId,
            repositoryId: job.repositoryId,
            path: thread.path,
            title: parsed.title,
            body: parsed.body,
            signal: "resolved_without_change",
            category: categoryFromFingerprint(thread.fingerprint),
            sourceThreadId: thread.threadId,
          });
          logger.info("learning.resolved_without_code_change", {
            jobId: job.id,
            threadId: thread.threadId,
          });
          continue;
        }
      }
      const trustedThumbsDown = trustedNegativeReactions(
        thread.reactionSummary.negativeReactors,
        input.trustedReactors,
      );
      // Once per thread: a thumbs-down stays on it, so without this every
      // review would re-record it and creep its confidence up.
      const alreadyRemembered =
        trustedThumbsDown > 0 &&
        ((await input.memoryService.hasDismissalFromThread?.({
          tenantId: job.tenantId,
          repositoryId: job.repositoryId,
          threadId: thread.threadId,
        })) ??
          false);
      if (trustedThumbsDown > 0 && !alreadyRemembered) {
        await record?.({
          tenantId: job.tenantId,
          repositoryId: job.repositoryId,
          path: thread.path,
          title: parsed.title,
          body: parsed.body,
          signal: "thumbs_down",
          category: categoryFromFingerprint(thread.fingerprint),
          sourceThreadId: thread.threadId,
        });
      }
    } catch (error) {
      logger.warn("learning.thread_failed", {
        jobId: job.id,
        threadId: thread.threadId,
        error: toErrorMessage(error),
      });
    }
  }
}

/** How a memory reads in the review prompt; dismissals say what they are. */
export function memoryPromptText(entry: Pick<MemoryEntry, "kind" | "summary">) {
  return entry.kind === "dismissed_finding" || entry.kind === "false_positive"
    ? `Dismissed before, do not raise again: ${entry.summary}`
    : entry.summary;
}

export { dismissalThreshold };

/**
 * Who may teach a repo with a reaction: the PR author and the repository
 * owner. Anyone signed in can react on a public repo, and one 👎 from a
 * stranger must not silence findings for everyone.
 */
export function trustedNegativeReactions(
  reactors: string[] | undefined,
  trusted: string[],
): number {
  const allowed = new Set(trusted.map((login) => login.toLowerCase()));
  return (reactors ?? []).filter((login) => allowed.has(login.toLowerCase()))
    .length;
}

export class WorkerRunner {
  readonly #logger: Logger;
  readonly #promptOptimizationMode: PromptOptimizationMode;
  readonly #queueScheduler: WorkerRunnerDependencies["queueScheduler"];
  readonly #githubAdapter: WorkerRunnerDependencies["githubAdapter"];
  readonly #instructionBundleLoader: WorkerRunnerDependencies["instructionBundleLoader"];
  readonly #memoryService: WorkerRunnerDependencies["memoryService"];
  readonly #feedbackService: WorkerRunnerDependencies["feedbackService"];
  readonly #reviewPlanner: WorkerRunnerDependencies["reviewPlanner"];
  readonly #reviewerChatService: Pick<ReviewerChatService, "respond">;
  readonly #botLogin: string;
  readonly #conversationResponder: Pick<
    ConversationResponder,
    "answer" | "reconsider"
  > | null;
  readonly #reviewLifecycle: WorkerRunnerDependencies["reviewLifecycle"];
  readonly #reviewEngine: WorkerRunnerDependencies["reviewEngine"];
  readonly #publisher: WorkerRunnerDependencies["publisher"];
  readonly #statusPublisher: Pick<
    ReviewStatusPublisher,
    "markFailed" | "markPending" | "markPublished" | "markSkipped"
  > &
    Partial<
      Pick<
        ReviewStatusPublisher,
        "markSuperseded" | "markClosed" | "markRequeued"
      >
    >;
  readonly #discussionAcknowledgmentStore: DiscussionAcknowledgmentStore | null;
  readonly #now: () => Date;
  readonly #repositoryAllowlist: Set<string> | null;

  constructor(input: WorkerRunnerDependencies) {
    this.#logger = (input.logger ?? noopLogger).child({
      component: "worker-runner",
    });
    this.#promptOptimizationMode = input.promptOptimizationMode ?? "balanced";
    this.#queueScheduler = input.queueScheduler;
    this.#githubAdapter = input.githubAdapter;
    this.#instructionBundleLoader = input.instructionBundleLoader;
    this.#memoryService = input.memoryService;
    this.#feedbackService = input.feedbackService;
    this.#reviewPlanner = input.reviewPlanner;
    this.#reviewerChatService =
      input.reviewerChatService ??
      new ReviewerChatService(
        input.botLogin ? { botLogin: input.botLogin } : {},
      );
    this.#conversationResponder = input.conversationResponder ?? null;
    this.#botLogin = input.botLogin ?? "nitpickr";
    this.#reviewLifecycle = input.reviewLifecycle;
    this.#reviewEngine = input.reviewEngine;
    this.#publisher = input.publisher;
    this.#statusPublisher = input.statusPublisher ?? noopStatusPublisher;
    this.#discussionAcknowledgmentStore =
      input.discussionAcknowledgmentStore ?? null;
    this.#now = input.now ?? (() => new Date());
    this.#repositoryAllowlist = input.repositoryAllowlist
      ? new Set(input.repositoryAllowlist.map((entry) => entry.toLowerCase()))
      : null;
  }

  /** Full name of a job's repository when it falls outside the allowlist. */
  #disallowedRepository(job: QueueJob): string | null {
    const repository = job.payload?.repository as
      | { owner?: unknown; name?: unknown }
      | undefined;
    if (
      !this.#repositoryAllowlist ||
      typeof repository?.owner !== "string" ||
      typeof repository.name !== "string"
    ) {
      return null;
    }
    const fullName = `${repository.owner}/${repository.name}`;
    return this.#repositoryAllowlist.has(fullName.toLowerCase())
      ? null
      : fullName;
  }

  async runOnce(input: {
    workerId: string;
    perTenantCap: number;
  }): Promise<boolean> {
    const jobs = await this.#queueScheduler.claimNextJobs({
      limit: 1,
      perTenantCap: input.perTenantCap,
      workerId: input.workerId,
    });

    const job = jobs[0];
    if (!job) {
      this.#logger.debug("No jobs available for worker iteration.", {
        workerId: input.workerId,
      });
      return false;
    }

    const payloadCorrelationId =
      typeof job.payload?.correlationId === "string" &&
      job.payload.correlationId.trim().length > 0
        ? job.payload.correlationId
        : null;
    const jobLogger = this.#logger.child({
      workerId: input.workerId,
      jobId: job.id,
      jobType: job.type,
      tenantId: job.tenantId,
      repositoryId: job.repositoryId,
      ...(payloadCorrelationId ? { correlationId: payloadCorrelationId } : {}),
    });

    const jobStartedAt = process.hrtime.bigint();
    jobLogger.info("Claimed worker job.", {});

    // Backstop for jobs queued before the allowlist changed; the webhook
    // service already refuses new events from other repositories.
    const disallowedRepository = this.#disallowedRepository(job);
    if (disallowedRepository) {
      jobLogger.warn("Skipped job for repository outside the allowlist.", {
        repository: disallowedRepository,
      });
      await this.#queueScheduler.completeJob(job.id, {
        workerId: input.workerId,
      });
      return true;
    }

    try {
      if (job.type === "memory_ingest") {
        await this.#processMemoryJob(job, jobLogger);
      } else if (job.type === "interaction_requested") {
        await this.#processInteractionJob(job, jobLogger);
      } else {
        await this.#processReviewJob(job, jobLogger);
      }

      await this.#queueScheduler.completeJob(job.id, {
        workerId: input.workerId,
      });
      jobLogger.info("Completed worker job.", {
        durationMs: Number(
          (process.hrtime.bigint() - jobStartedAt) / 1_000_000n,
        ),
      });
      return true;
    } catch (error) {
      const failureClass =
        error instanceof ReviewJobError
          ? error.failureClass
          : "internal_processing";
      const retryable =
        error instanceof ReviewJobError ? error.retryable : false;
      jobLogger.error("Worker job failed.", {
        durationMs: Number(
          (process.hrtime.bigint() - jobStartedAt) / 1_000_000n,
        ),
        failureClass,
        retryable,
        error: toErrorMessage(error),
      });
      captureError(error, {
        tags: {
          jobType: job.type,
          failureClass,
        },
        extra: {
          jobId: job.id,
          tenantId: job.tenantId,
          repositoryId: job.repositoryId,
          correlationId: payloadCorrelationId ?? undefined,
        },
      });
      await this.#queueScheduler.failJob(
        job.id,
        toErrorMessage(error),
        {
          retryable,
        },
        { workerId: input.workerId },
      );
      return true;
    }
  }

  /**
   * Runs a review and guarantees the check created when it was queued ends
   * in a truthful state on every exit: back to queued when the job will
   * retry, failed when it won't, or closed with the reason it ended early.
   */
  async #processReviewJob(job: QueueJob, jobLogger: Logger): Promise<void> {
    const queuedCheck: QueuedCheck = {
      checkRunId:
        typeof job.payload.checkRunId === "string" &&
        job.payload.checkRunId.length > 0
          ? job.payload.checkRunId
          : null,
      settled: false,
      endedEarly: null,
    };
    try {
      await this.#runReviewJob(job, jobLogger, queuedCheck);
    } catch (error) {
      const retryable =
        error instanceof ReviewJobError ? error.retryable : false;
      const willRetry = retryable && job.attempts + 1 < job.maxAttempts;
      const reason = describeReviewFailure(error);
      await this.#settleQueuedCheck(
        job,
        queuedCheck,
        willRetry
          ? { kind: "retry", summary: `Retrying: ${reason}.` }
          : {
              kind: "close",
              conclusion: "failure",
              title: "nitpickr review failed",
              summary: `${reason}.`,
            },
        jobLogger,
      );
      if (!willRetry) {
        await this.#announceReviewFailure(job, reason, jobLogger);
      }
      throw error;
    }
    await this.#settleQueuedCheck(
      job,
      queuedCheck,
      queuedCheck.endedEarly ?? {
        kind: "close",
        conclusion: "neutral",
        title: "nitpickr review ended",
        summary: "nitpickr finished this job without a review result.",
      },
      jobLogger,
    );
  }

  /**
   * Say on the PR when a review gives up: a failed check alone is easy to
   * miss, and silence reads as "nitpickr is still working" or "all good".
   */
  async #announceReviewFailure(
    job: QueueJob,
    reason: string,
    logger: Logger,
  ): Promise<void> {
    const payload = job.payload;
    const repository = payload.repository as
      | { owner: string; name: string }
      | undefined;
    if (
      !this.#githubAdapter.createIssueComment ||
      repository === undefined ||
      typeof payload.installationId !== "string" ||
      typeof payload.pullNumber !== "number"
    ) {
      return;
    }
    const sha =
      typeof payload.headSha === "string" ? payload.headSha.slice(0, 7) : null;
    try {
      await this.#githubAdapter.createIssueComment({
        installationId: payload.installationId,
        repository,
        pullNumber: payload.pullNumber,
        body: `**nitpickr** couldn't finish ${
          sha ? `reviewing \`${sha}\`` : "this review"
        }: ${reason}. Comment \`@${this.#botLogin.replace(/\[bot\]$/i, "")} review\` to try again.`,
      });
    } catch (error) {
      logger.warn("Failed to announce a failed review.", {
        jobId: job.id,
        error: toErrorMessage(error),
      });
    }
  }

  async #settleQueuedCheck(
    job: QueueJob,
    queuedCheck: QueuedCheck,
    outcome: QueuedCheckOutcome,
    logger: Logger,
  ): Promise<void> {
    const checkRunId = queuedCheck.checkRunId;
    const repository = job.payload.repository as
      | { owner: string; name: string }
      | undefined;
    const installationId = job.payload.installationId;
    if (
      checkRunId === null ||
      queuedCheck.settled ||
      repository === undefined ||
      typeof installationId !== "string"
    ) {
      return;
    }
    try {
      if (outcome.kind === "retry") {
        await this.#statusPublisher.markRequeued?.({
          installationId,
          repository,
          checkRunId,
          summary: outcome.summary,
        });
      } else {
        await this.#statusPublisher.markClosed?.({
          installationId,
          repository,
          checkRunId,
          conclusion: outcome.conclusion,
          title: outcome.title,
          summary: outcome.summary,
        });
      }
      queuedCheck.settled = true;
    } catch (error) {
      logger.warn("Failed to settle the queued review check.", {
        jobId: job.id,
        checkRunId,
        error: toErrorMessage(error),
      });
    }
  }

  async #runReviewJob(
    job: QueueJob,
    jobLogger: Logger,
    queuedCheck: QueuedCheck,
  ): Promise<void> {
    let payload: ReturnType<typeof parseReviewJobPayload>;
    try {
      payload = parseReviewJobPayload(job.payload);
    } catch (error) {
      throw classifyReviewError("config", error);
    }
    const logger = jobLogger;

    let reviewRunId: string | null = null;
    let checkRunId: string | null = null;
    let statusChecksEnabled = false;
    let changeRequestContext: GitHubChangeRequestContext | null = null;
    let resolvedThreadCount = 0;

    try {
      let context: GitHubChangeRequestContext;
      try {
        context = await withTiming(
          logger,
          "fetch_change_request_context",
          () =>
            this.#githubAdapter.fetchChangeRequestContext({
              installationId: payload.installationId,
              repository: payload.repository,
              pullNumber: payload.pullNumber,
              tenantId: job.tenantId,
              repositoryId: job.repositoryId,
            }),
          { pullNumber: payload.pullNumber },
        );
      } catch (error) {
        throw classifyReviewError("github", error);
      }
      changeRequestContext = context;
      if (context.changeRequest.status === "closed") {
        // Merged into any branch or closed: a review helps nobody now.
        logger.info("Skipping review of a closed pull request.", {
          jobId: job.id,
          pullNumber: payload.pullNumber,
        });
        queuedCheck.endedEarly = {
          kind: "close",
          conclusion: "neutral",
          title: "Pull request closed",
          summary:
            "nitpickr skips reviews of pull requests that were merged or closed.",
        };
        return;
      }
      const latestCompletedReview = this.#reviewLifecycle
        .getLatestCompletedReview
        ? await this.#reviewLifecycle.getLatestCompletedReview(
            context.changeRequest.id,
          )
        : null;
      if (
        payload.trigger.type === "pr_synchronized" &&
        ((payload.headSha !== null &&
          payload.headSha !== context.changeRequest.headSha) ||
          latestCompletedReview?.headSha === context.changeRequest.headSha)
      ) {
        // A newer push queued its own job, or this head was already
        // reviewed (e.g. by the opened job). Full reviews are never skipped:
        // they review the current head instead.
        logger.info("Skipping push review that is outdated or already done.", {
          jobId: job.id,
          queuedHeadSha: payload.headSha,
          currentHeadSha: context.changeRequest.headSha,
        });
        queuedCheck.endedEarly =
          payload.headSha !== null &&
          payload.headSha !== context.changeRequest.headSha
            ? {
                kind: "close",
                conclusion: "neutral",
                title: "Superseded by a newer push",
                summary:
                  "nitpickr reviews the latest commit instead of this one.",
              }
            : {
                kind: "close",
                conclusion: "neutral",
                title: "Already reviewed",
                summary: "nitpickr already reviewed this commit.",
              };
        return;
      }
      const reviewScope = determineReviewScope(
        payload.trigger,
        latestCompletedReview !== null,
      );
      const priorReviewRoundCount = this.#reviewLifecycle.countCompletedReviews
        ? await this.#reviewLifecycle.countCompletedReviews(
            context.changeRequest.id,
          )
        : 0;
      const comparedFromSha =
        latestCompletedReview &&
        latestCompletedReview.headSha !== context.changeRequest.headSha
          ? latestCompletedReview.headSha
          : null;
      const comparePullRequestRange =
        this.#githubAdapter.comparePullRequestRange?.bind(this.#githubAdapter);
      const reviewFiles =
        reviewScope === "commit_delta" &&
        comparedFromSha &&
        comparePullRequestRange
          ? await (async () => {
              try {
                return await comparePullRequestRange({
                  installationId: payload.installationId,
                  repository: payload.repository,
                  baseSha: comparedFromSha,
                  headSha: context.changeRequest.headSha,
                });
              } catch (error) {
                throw classifyReviewError("github", error);
              }
            })()
          : context.files;

      const superseded = await this.#queueScheduler.cancelSupersededReviewJobs({
        repositoryId: job.repositoryId,
        changeRequestId:
          job.changeRequestId ?? `${job.repositoryId}:${payload.pullNumber}`,
        headSha: context.changeRequest.headSha,
        createdBefore: job.createdAt,
      });
      if (superseded.canceledCount > 0) {
        logger.info("Superseded queued review jobs for newer head SHA.", {
          jobId: job.id,
          repositoryId: job.repositoryId,
          changeRequestId:
            job.changeRequestId ?? `${job.repositoryId}:${payload.pullNumber}`,
          supersededCount: superseded.canceledCount,
        });
      }
      // Their queued checks would otherwise sit at "queued" forever; so
      // would this job's own, if a newer push moved the PR head meanwhile.
      const staleCheckRunIds = [
        ...superseded.checkRunIds,
        ...(payload.checkRunId &&
        (payload.checkRunSha ?? payload.headSha) !== null &&
        (payload.checkRunSha ?? payload.headSha) !==
          context.changeRequest.headSha
          ? [payload.checkRunId]
          : []),
      ];
      for (const staleCheckRunId of staleCheckRunIds) {
        try {
          await this.#statusPublisher.markSuperseded?.({
            installationId: payload.installationId,
            repository: payload.repository,
            checkRunId: staleCheckRunId,
          });
          if (staleCheckRunId === queuedCheck.checkRunId) {
            queuedCheck.settled = true;
          }
        } catch (error) {
          logger.warn("Failed to mark a superseded review check.", {
            jobId: job.id,
            checkRunId: staleCheckRunId,
            error: toErrorMessage(error),
          });
        }
      }
      const queuedCheckRunId =
        payload.checkRunId && !staleCheckRunIds.includes(payload.checkRunId)
          ? payload.checkRunId
          : null;
      if (queuedCheckRunId) {
        // A failure before the repo config loads must still close the
        // queued check instead of leaving it "queued" forever.
        checkRunId = queuedCheckRunId;
        statusChecksEnabled = true;
      }

      let instructionBundle: InstructionBundle;
      try {
        instructionBundle = await withTiming(
          logger,
          "load_instruction_bundle",
          () => this.#instructionBundleLoader.loadForReview(context),
        );
      } catch (error) {
        throw classifyReviewError("github", error);
      }
      statusChecksEnabled = instructionBundle.config.statusChecks.enabled;
      if (!statusChecksEnabled && checkRunId) {
        try {
          await this.#statusPublisher.markSkipped({
            installationId: payload.installationId,
            repository: payload.repository,
            sha: context.changeRequest.headSha,
            reviewRunId: `queued:${job.id}`,
            checkRunId,
            description: "Status checks are turned off for this repository.",
          });
          queuedCheck.settled = true;
        } catch (error) {
          logger.warn("Failed to close the queued review check.", {
            jobId: job.id,
            error: toErrorMessage(error),
          });
        }
        checkRunId = null;
      }
      const reviewPlan = this.#reviewPlanner.plan({
        mode: payload.mode,
        config: instructionBundle.config,
        files: reviewFiles.map((file) => ({
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch,
        })),
      });

      logger.info("Planned review job.", {
        jobId: job.id,
        repositoryId: job.repositoryId,
        mode: payload.mode,
        scope: reviewScope,
        optimizationMode: this.#promptOptimizationMode,
        comparedFromSha,
        reviewableFileCount: reviewPlan.files.length,
        summaryOnly: reviewPlan.summaryOnly,
      });

      const startedReviewRunId = await this.#reviewLifecycle.startReview({
        tenantId: job.tenantId,
        repositoryId: job.repositoryId,
        changeRequest: context.changeRequest,
        trigger: payload.trigger,
        mode: payload.mode,
        scope: reviewScope,
        comparedFromSha,
        budgets: {
          maxFiles: reviewPlan.files.length,
          maxHunks: instructionBundle.config.review.maxHunks,
          maxTokens: instructionBundle.config.review.maxTokens,
          maxComments: reviewPlan.commentBudget,
          maxDurationMs: REVIEW_DURATION_BUDGET_MS,
        },
        discussionSnapshot: context.comments.map((comment) => ({
          authorLogin: comment.authorLogin,
          body: comment.body,
          path: comment.path,
          line: comment.line,
          providerCreatedAt: comment.createdAt,
        })),
      });
      reviewRunId = startedReviewRunId;

      if (statusChecksEnabled) {
        const pendingCheckRunId = await this.#publishReviewStatus(
          "pending",
          {
            jobId: job.id,
            reviewRunId: startedReviewRunId,
            repositoryId: job.repositoryId,
            sha: context.changeRequest.headSha,
          },
          () =>
            this.#statusPublisher.markPending({
              installationId: payload.installationId,
              repository: payload.repository,
              sha: context.changeRequest.headSha,
              reviewRunId: startedReviewRunId,
              description: "nitpickr review is running.",
              ...(queuedCheckRunId ? { checkRunId: queuedCheckRunId } : {}),
            }),
        );
        if (pendingCheckRunId) {
          checkRunId = pendingCheckRunId;
          logger.info("Published pending review status.", {
            jobId: job.id,
            reviewRunId: startedReviewRunId,
            checkRunId,
            repositoryId: job.repositoryId,
            sha: context.changeRequest.headSha,
          });
        } else if (queuedCheckRunId === null) {
          statusChecksEnabled = false;
        }
        // With a queued check, keep updating it: the final PATCH may still
        // land, and the job's settle step closes it otherwise.
      }

      const memoryCharBudget = Math.max(reviewPlan.commentBudget * 200, 1_000);
      const reviewContext = [
        context.changeRequest.title,
        ...reviewPlan.files.map((file) => file.path),
      ]
        .join("\n")
        .slice(0, 2_000);
      const memories = await withTiming(logger, "select_memories", () =>
        this.#memoryService.selectMemoriesForReview
          ? this.#memoryService.selectMemoriesForReview({
              tenantId: job.tenantId,
              repositoryId: job.repositoryId,
              reviewedPaths: reviewPlan.files.map((file) => file.path),
              reviewContext,
              charBudget: memoryCharBudget,
            })
          : this.#memoryService.getRelevantMemories({
              tenantId: job.tenantId,
              repositoryId: job.repositoryId,
              paths: reviewPlan.files.map((file) => file.path),
              limit: Math.max(reviewPlan.commentBudget, 1),
            }),
      );
      const existingNitpickrThreads = this.#githubAdapter
        .listNitpickrReviewThreads
        ? await this.#githubAdapter.listNitpickrReviewThreads({
            installationId: payload.installationId,
            repository: payload.repository,
            pullNumber: payload.pullNumber,
          })
        : [];
      const compareRange = this.#githubAdapter.comparePullRequestRange?.bind(
        this.#githubAdapter,
      );
      await this.#learnFromThreads({
        job,
        threads: existingNitpickrThreads,
        logger,
        trustedReactors: [
          context.changeRequest.authorLogin,
          payload.repository.owner,
        ],
        ...(compareRange
          ? {
              fileChangedSince: async (path: string, sinceSha: string) =>
                (
                  await compareRange({
                    installationId: payload.installationId,
                    repository: payload.repository,
                    baseSha: sinceSha,
                    headSha: context.changeRequest.headSha,
                  })
                ).some((file) => file.path === path),
            }
          : {}),
      });
      if (this.#feedbackService && existingNitpickrThreads.length > 0) {
        await this.#feedbackService.syncCommentReactions({
          tenantId: job.tenantId,
          repositoryId: job.repositoryId,
          comments: existingNitpickrThreads.map((thread) => ({
            providerCommentId: thread.providerCommentId,
            fingerprint: thread.fingerprint,
            path: thread.path,
            category: categoryFromFingerprint(thread.fingerprint),
            positiveCount: thread.reactionSummary.positiveCount,
            negativeCount: thread.reactionSummary.negativeCount,
          })),
        });
      }
      const feedbackSignals = this.#feedbackService
        ? await this.#feedbackService.getSignals({
            tenantId: job.tenantId,
            repositoryId: job.repositoryId,
            paths: reviewPlan.files.map((file) => file.path),
            limit: Math.max(reviewPlan.commentBudget * 2, 10),
          })
        : [];

      const priorThreads = buildPriorThreads({
        scope: reviewScope,
        existingThreads: existingNitpickrThreads,
        reviewedFiles: reviewPlan.files.map((file) => ({
          path: file.path,
          patch: file.patch,
        })),
        discussionComments: context.comments,
      });

      const fileContentsByPath = this.#githubAdapter.getFileContent
        ? await withTiming(
            logger,
            "fetch_primary_file_contents",
            () =>
              fetchPrimaryFileContents({
                files: reviewPlan.files.map((file) => ({
                  path: file.path,
                  patch: file.patch,
                })),
                headSha: context.changeRequest.headSha,
                installationId: payload.installationId,
                repository: payload.repository,
                getFileContent: (
                  this.#githubAdapter.getFileContent as NonNullable<
                    GitHubAdapter["getFileContent"]
                  >
                ).bind(this.#githubAdapter),
                logger,
              }),
            { fileCount: reviewPlan.files.length },
          )
        : new Map<string, string>();

      const diagnostics =
        reviewPlan.files.length === 0
          ? {
              result: {
                summary:
                  reviewPlan.skipReason ??
                  "No reviewable files matched the current repository configuration.",
                mermaid:
                  "flowchart TD\nA[Pull Request] --> B[No Reviewable Files]",
                findings: [],
              },
              rejectedFindings: [],
              promptUsage: {
                beforeCompaction: emptyPromptUsageSnapshot(),
                afterCompaction: emptyPromptUsageSnapshot(),
              },
            }
          : await (async () => {
              try {
                const reviewInput = {
                  changeRequest: {
                    title: context.changeRequest.title,
                    number: context.changeRequest.number,
                    body: context.pullRequestBody ?? null,
                  },
                  files: reviewPlan.files.map((file) => {
                    const fileContent = fileContentsByPath.get(file.path);
                    return fileContent === undefined
                      ? file
                      : { ...file, fileContent };
                  }),
                  scope: reviewScope,
                  optimizationMode: this.#promptOptimizationMode,
                  // Memories go to the prompt once, in the memory section;
                  // they no longer eat into the 4k instruction budget.
                  instructionText: instructionBundle.combinedText,
                  memory: memories.map((entry) =>
                    entry.path
                      ? {
                          summary: memoryPromptText(entry),
                          path: entry.path,
                        }
                      : {
                          summary: memoryPromptText(entry),
                        },
                  ),
                  commentBudget: reviewPlan.commentBudget,
                  priorReviewRoundCount,
                  ...(this.#memoryService.findSimilarDismissals
                    ? {
                        dismissalCheck: (finding: ReviewFinding) =>
                          this.#dismissalFor(job, finding),
                      }
                    : {}),
                  severityFloor: severityFloorForRound(priorReviewRoundCount),
                  ...(feedbackSignals.length === 0 ? {} : { feedbackSignals }),
                  ...(priorThreads.length === 0 ? {} : { priorThreads }),
                  ...(isAutomaticTrigger(payload.trigger)
                    ? {
                        publishableFindingTypes: [
                          "bug" as const,
                          "safe_suggestion" as const,
                        ],
                      }
                    : {}),
                  ...(reviewScope === "commit_delta"
                    ? {
                        contextFiles: context.files.map((file) => ({
                          path: file.path,
                          additions: file.additions,
                          deletions: file.deletions,
                          patch: file.patch,
                        })),
                      }
                    : {}),
                };

                return await withTiming(
                  logger,
                  "review_engine_run",
                  async () => {
                    if (this.#reviewEngine.reviewWithDiagnostics) {
                      return await this.#reviewEngine.reviewWithDiagnostics(
                        reviewInput,
                      );
                    }
                    return {
                      result: await this.#reviewEngine.review(reviewInput),
                      rejectedFindings: [],
                      promptUsage: {
                        beforeCompaction: emptyPromptUsageSnapshot(),
                        afterCompaction: emptyPromptUsageSnapshot(),
                      },
                    };
                  },
                  {
                    fileCount: reviewPlan.files.length,
                    scope: reviewScope,
                  },
                );
              } catch (error) {
                throw classifyReviewError("review", error);
              }
            })();
      const rawResult = diagnostics.result;
      const enrichedResult = prependMemoryRollup(
        prependSummaryReason(
          reviewPlan.allowSuggestedChanges
            ? rawResult
            : stripSuggestedChanges(rawResult),
          reviewPlan.summaryOnlyReason,
        ),
        memories,
      );
      const severityFloor = severityFloorForRound(priorReviewRoundCount);
      const { kept: result, dropped: droppedBySeverityFloor } =
        applySeverityFloor(enrichedResult, severityFloor);
      if (droppedBySeverityFloor.length > 0) {
        logger.info("severity_floor.applied", {
          priorReviewRoundCount,
          floor: severityFloor,
          droppedFindingCount: droppedBySeverityFloor.length,
          droppedSeverities: droppedBySeverityFloor.map(
            (finding) => finding.severity,
          ),
        });
      }
      const publishableResult = this.#reviewEngine.reviewWithDiagnostics
        ? result
        : selectPublishableResult(result, payload.trigger);

      if (diagnostics.rejectedFindings.length > 0) {
        logger.info("Suppressed findings after evidence gating.", {
          jobId: job.id,
          reviewRunId: startedReviewRunId,
          suppressedFindingCount: diagnostics.rejectedFindings.length,
        });
      }

      logger.info("Review prompt usage before compaction.", {
        jobId: job.id,
        reviewRunId: startedReviewRunId,
        scope: reviewScope,
        optimizationMode: this.#promptOptimizationMode,
        ...diagnostics.promptUsage.beforeCompaction,
      });
      logger.info("Review prompt usage after compaction.", {
        jobId: job.id,
        reviewRunId: startedReviewRunId,
        scope: reviewScope,
        optimizationMode: this.#promptOptimizationMode,
        ...diagnostics.promptUsage.afterCompaction,
      });

      if (reviewPlan.files.length === 0) {
        logger.info(
          "Skipping inline review; no reviewable files remained after planning.",
          {
            jobId: job.id,
            repositoryId: job.repositoryId,
          },
        );
      } else {
        logger.info("Generated review result.", {
          jobId: job.id,
          reviewRunId: startedReviewRunId,
          findingCount: publishableResult.findings.length,
        });
      }

      const draftPublishedComments = this.#publisher.buildInlineComments(
        publishableResult.findings,
        {
          files: reviewPlan.files.map((file) => ({
            path: file.path,
            patch: file.patch,
          })),
        },
      );
      const anchoredFingerprints = new Set(
        draftPublishedComments.map((comment) => comment.fingerprint),
      );
      const unanchoredFindings = publishableResult.findings.filter(
        (finding) => !anchoredFingerprints.has(fingerprintFinding(finding)),
      );
      if (unanchoredFindings.length > 0) {
        logger.warn(
          "Dropped findings that could not be anchored to the diff.",
          {
            jobId: job.id,
            reviewRunId: startedReviewRunId,
            droppedCount: unanchoredFindings.length,
            dropped: unanchoredFindings.map(
              (finding) => `${finding.path}:${finding.line}`,
            ),
          },
        );
      }
      const threadsToResolve = selectThreadsToResolve({
        priorThreads,
        existingThreads: existingNitpickrThreads,
        verdicts: rawResult.priorThreadVerdicts ?? [],
      });
      const resolvedThreads: typeof threadsToResolve = [];
      for (const entry of threadsToResolve) {
        try {
          if (this.#githubAdapter.resolveReviewThread) {
            await this.#githubAdapter.resolveReviewThread({
              installationId: payload.installationId,
              threadId: entry.thread.threadId,
            });
            resolvedThreads.push(entry);
          }
        } catch (error) {
          logger.warn("Failed to resolve nitpickr review thread.", {
            jobId: job.id,
            reviewRunId: startedReviewRunId,
            threadId: entry.thread.threadId,
            verdict: entry.verdict,
            error: toErrorMessage(error),
          });
        }
      }
      resolvedThreadCount = resolvedThreads.length;
      if (resolvedThreadCount > 0) {
        await this.#reviewLifecycle.markPublishedCommentsResolved?.(
          resolvedThreads.map((entry) => entry.thread.threadId),
        );
        const fixedEvents = resolvedThreads
          .filter((entry) => entry.verdict === "fixed")
          .map((entry) => ({
            fingerprint: entry.thread.fingerprint,
            path: entry.thread.path,
            category: categoryFromFingerprint(entry.thread.fingerprint),
            kind: "fixed_after_comment" as const,
          }));
        if (this.#feedbackService && fixedEvents.length > 0) {
          await this.#feedbackService.recordOutcome({
            tenantId: job.tenantId,
            repositoryId: job.repositoryId,
            events: fixedEvents,
          });
        }
      }
      const resolvedThreadIds = new Set(
        resolvedThreads.map((entry) => entry.thread.threadId),
      );
      const openPriorThreadCount = existingNitpickrThreads.filter(
        (thread) =>
          !thread.isResolved && !resolvedThreadIds.has(thread.threadId),
      ).length;
      const publishedReview = await withTiming(
        logger,
        "publish_review",
        async () => {
          try {
            return await this.#publisher.publish({
              reviewRunId: startedReviewRunId,
              installationId: payload.installationId,
              repository: payload.repository,
              pullNumber: payload.pullNumber,
              publishMode:
                reviewScope === "commit_delta"
                  ? "commit_summary"
                  : "pr_summary",
              reviewedCommitSha: context.changeRequest.headSha,
              commitSummaryCounts: {
                resolvedThreads: resolvedThreadCount,
              },
              openPriorThreadCount,
              result: publishableResult as ReviewEngineResult,
              files: reviewPlan.files.map((file) => ({
                path: file.path,
                patch: file.patch,
              })),
            });
          } catch (error) {
            throw classifyReviewError("publish", error);
          }
        },
        { findingCount: publishableResult.findings.length },
      );
      const nitpickrThreads = this.#githubAdapter.listNitpickrReviewThreads
        ? await this.#githubAdapter.listNitpickrReviewThreads({
            installationId: payload.installationId,
            repository: payload.repository,
            pullNumber: payload.pullNumber,
          })
        : [];
      const publishedComments =
        await enrichPublishedCommentsWithProviderMetadata(
          draftPublishedComments,
          nitpickrThreads,
        );

      await this.#reviewLifecycle.completeReview({
        reviewRunId: startedReviewRunId,
        repositoryId: job.repositoryId,
        status: reviewPlan.files.length === 0 ? "skipped" : "published",
        publishedReviewId: publishedReview.reviewId,
        result,
        publishedComments,
      });
      if (statusChecksEnabled) {
        const description =
          reviewPlan.files.length === 0
            ? "nitpickr skipped inline review for this change."
            : reviewPlan.summaryOnly
              ? "nitpickr published a summary-only review."
              : publishableResult.findings.length === 0 &&
                  openPriorThreadCount === 0 &&
                  (publishableResult.secondLook?.length ?? 0) === 0
                ? "No further comments."
                : "nitpickr review completed successfully.";
        queuedCheck.endedEarly =
          reviewPlan.files.length === 0
            ? {
                kind: "close",
                conclusion: "neutral",
                title: "nitpickr review skipped",
                summary: description,
              }
            : {
                kind: "close",
                conclusion: "success",
                title: "nitpickr review completed",
                summary: description,
              };
        if (reviewPlan.files.length === 0) {
          const published = await this.#publishReviewStatus(
            "skipped",
            {
              jobId: job.id,
              reviewRunId: startedReviewRunId,
              checkRunId,
              repositoryId: job.repositoryId,
              sha: context.changeRequest.headSha,
            },
            () =>
              this.#statusPublisher.markSkipped({
                checkRunId: checkRunId ?? "missing-check-run",
                installationId: payload.installationId,
                repository: payload.repository,
                sha: context.changeRequest.headSha,
                reviewRunId: startedReviewRunId,
                description,
                summary: result.summary,
              }),
          );
          if (published !== null && checkRunId === queuedCheck.checkRunId) {
            queuedCheck.settled = true;
          }
          if (published !== null) {
            logger.info("Published final review status.", {
              jobId: job.id,
              reviewRunId: startedReviewRunId,
              checkRunId,
              repositoryId: job.repositoryId,
              sha: context.changeRequest.headSha,
              summaryOnly: reviewPlan.summaryOnly,
            });
          }
        } else {
          const published = await this.#publishReviewStatus(
            "published",
            {
              jobId: job.id,
              reviewRunId: startedReviewRunId,
              checkRunId,
              repositoryId: job.repositoryId,
              sha: context.changeRequest.headSha,
            },
            () =>
              this.#statusPublisher.markPublished({
                checkRunId: checkRunId ?? "missing-check-run",
                installationId: payload.installationId,
                repository: payload.repository,
                sha: context.changeRequest.headSha,
                reviewRunId: startedReviewRunId,
                description,
                summary: result.summary,
              }),
          );
          if (published !== null && checkRunId === queuedCheck.checkRunId) {
            queuedCheck.settled = true;
          }
          if (published !== null) {
            logger.info("Published final review status.", {
              jobId: job.id,
              reviewRunId: startedReviewRunId,
              checkRunId,
              repositoryId: job.repositoryId,
              sha: context.changeRequest.headSha,
              summaryOnly: reviewPlan.summaryOnly,
            });
          }
        }
      }
      logger.info("Published review result.", {
        jobId: job.id,
        reviewRunId: startedReviewRunId,
        publishedReviewId: publishedReview.reviewId,
        findingCount: publishableResult.findings.length,
      });
    } catch (error) {
      if (reviewRunId !== null) {
        await this.#reviewLifecycle.failReview({
          reviewRunId,
          errorMessage:
            error instanceof ReviewJobError
              ? `${error.failureClass}: ${error.message}`
              : toErrorMessage(error),
        });
      }
      // The queued check is reused by the retry: the settle step puts it
      // back to queued. Any other check is completed here.
      const retryReusesCheck =
        error instanceof ReviewJobError &&
        error.retryable &&
        job.attempts + 1 < job.maxAttempts &&
        checkRunId !== null &&
        checkRunId === queuedCheck.checkRunId;
      if (
        statusChecksEnabled &&
        changeRequestContext !== null &&
        error instanceof ReviewJobError &&
        !retryReusesCheck
      ) {
        const failureContext = changeRequestContext;
        const published = await this.#publishReviewStatus(
          "failed",
          {
            jobId: job.id,
            reviewRunId,
            checkRunId,
            repositoryId: job.repositoryId,
            sha: failureContext.changeRequest.headSha,
            failureClass: error.failureClass,
            retryable: error.retryable,
          },
          () =>
            this.#statusPublisher.markFailed({
              installationId: payload.installationId,
              repository: payload.repository,
              sha: failureContext.changeRequest.headSha,
              reviewRunId: reviewRunId ?? `failed:${job.id}`,
              description: `nitpickr ${error.failureClass.replace(/_/g, " ")}.`,
              summary: error.message,
              // "Retry scheduled" only while attempts remain.
              retryable: error.retryable && job.attempts + 1 < job.maxAttempts,
              ...(checkRunId ? { checkRunId } : {}),
            }),
        );
        if (published !== null && checkRunId === queuedCheck.checkRunId) {
          queuedCheck.settled = true;
        }
        if (published !== null) {
          logger.info("Published failed review status.", {
            jobId: job.id,
            reviewRunId,
            checkRunId,
            repositoryId: job.repositoryId,
            sha: failureContext.changeRequest.headSha,
            failureClass: error.failureClass,
            retryable: error.retryable,
          });
        }
      }

      throw error;
    }
  }

  async #processInteractionJob(
    job: QueueJob,
    jobLogger: Logger,
  ): Promise<void> {
    const logger = jobLogger;
    const payload = parseInteractionJobPayload(job.payload);
    const latestReview = this.#reviewLifecycle.getLatestCompletedReview
      ? await this.#reviewLifecycle.getLatestCompletedReview(
          job.changeRequestId ?? `${job.repositoryId}:${payload.pullNumber}`,
        )
      : null;
    const nitpickrThreads = this.#githubAdapter.listNitpickrReviewThreads
      ? await this.#githubAdapter.listNitpickrReviewThreads({
          installationId: payload.installationId,
          repository: payload.repository,
          pullNumber: payload.pullNumber,
        })
      : [];
    const referencedThread =
      payload.replyTargetCommentId === null
        ? null
        : (nitpickrThreads.find(
            (thread) =>
              thread.providerCommentId === String(payload.replyTargetCommentId),
          ) ?? null);
    const threadContext =
      referencedThread === null
        ? null
        : (() => {
            const parsed = parseInlineCommentContext(referencedThread.body);
            return {
              providerCommentId: referencedThread.providerCommentId,
              path: referencedThread.path,
              line: referencedThread.line,
              fingerprint: referencedThread.fingerprint,
              title: parsed.title,
              body: parsed.body,
              fixPrompt: parsed.fixPrompt,
            };
          })();

    if (
      payload.source.kind === "review_comment" &&
      referencedThread === null &&
      !mentionsBot(payload.source.body, this.#botLogin)
    ) {
      // Replies in threads nitpickr did not start are people talking to
      // each other, whatever words they use, unless they mention nitpickr.
      logger.info("Ignoring reply in a thread nitpickr did not start.", {
        jobId: job.id,
        replyTargetCommentId: payload.replyTargetCommentId,
      });
      return;
    }

    const modelReply =
      this.#conversationResponder === null
        ? null
        : await this.#respondWithModel({
            job,
            payload,
            responder: this.#conversationResponder,
            thread: threadContext,
            threadId: referencedThread?.threadId ?? null,
            logger,
          });
    const templateReply = async () =>
      this.#reviewerChatService.respond({
        command: payload.command,
        actorLogin: payload.actorLogin,
        argumentText: payload.source.argumentText,
        latestReview,
        thread: threadContext,
      });
    const reply =
      modelReply === null
        ? await templateReply()
        : "fallbackNote" in modelReply
          ? await templateReply().then((template) => ({
              ...template,
              body: `${template.body}\n\n_(${modelReply.fallbackNote})_`,
            }))
          : modelReply;

    // Post first: if posting fails the job retries, and recording feedback
    // or memory before that would count it twice.
    try {
      await this.#postInteractionReply(payload, reply.body);
    } catch (error) {
      const message = toErrorMessage(error);
      // 5xx, rate limits and dropped connections are worth another try;
      // a 4xx (deleted comment, no permission) is not.
      throw new ReviewJobError(
        "github_api",
        isRetryableHttpError(message) ||
          /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message),
        message,
      );
    }

    // The reply is already posted, so a bookkeeping failure must not fail
    // (and retry) the job: that would post the reply again.
    try {
      if (reply.memoryDiscussions.length > 0) {
        await this.#memoryService.ingestDiscussion({
          tenantId: job.tenantId,
          repositoryId: job.repositoryId,
          discussions: reply.memoryDiscussions,
        });
      }
      if (this.#feedbackService && reply.feedbackEvents.length > 0) {
        await this.#feedbackService.recordOutcome({
          tenantId: job.tenantId,
          repositoryId: job.repositoryId,
          events: reply.feedbackEvents,
        });
      }
    } catch (error) {
      logger.warn("Failed to record feedback for an interaction reply.", {
        jobId: job.id,
        error: toErrorMessage(error),
      });
    }

    logger.info("Processed reviewer interaction job.", {
      jobId: job.id,
      repositoryId: job.repositoryId,
      command: payload.command,
      sourceKind: payload.source.kind,
    });
  }

  async #postInteractionReply(
    payload: ReturnType<typeof parseInteractionJobPayload>,
    body: string,
  ): Promise<void> {
    if (payload.source.kind === "issue_comment") {
      if (!this.#githubAdapter.createIssueComment) {
        throw new Error("GitHub issue comment replies are unavailable.");
      }
      await this.#githubAdapter.createIssueComment({
        installationId: payload.installationId,
        repository: payload.repository,
        pullNumber: payload.pullNumber,
        body,
      });
    } else {
      if (!this.#githubAdapter.replyToReviewComment) {
        throw new Error("GitHub review comment replies are unavailable.");
      }
      await this.#githubAdapter.replyToReviewComment({
        installationId: payload.installationId,
        repository: payload.repository,
        pullNumber: payload.pullNumber,
        commentId: payload.replyTargetCommentId ?? payload.source.commentId,
        body,
      });
    }
  }

  /**
   * Answer ask/why/teach with the model, grounded in the PR, and re-verify a
   * finding for reconsider. Returns null for commands the template service
   * handles (status, learn, fix, help) or when the model call fails.
   */
  async #respondWithModel(input: {
    job: QueueJob;
    payload: ReturnType<typeof parseInteractionJobPayload>;
    responder: Pick<ConversationResponder, "answer" | "reconsider">;
    thread: (ConversationThread & { fingerprint: string }) | null;
    threadId: string | null;
    logger: Logger;
  }): Promise<ReviewerChatReply | { fallbackNote: string } | null> {
    const { job, payload, responder, thread, logger } = input;
    const command = payload.command;
    if (
      command !== "ask" &&
      command !== "why" &&
      command !== "teach" &&
      command !== "reconsider"
    ) {
      return null;
    }
    if (command === "reconsider" && thread === null) {
      return null;
    }

    try {
      const context = await this.#githubAdapter.fetchChangeRequestContext({
        installationId: payload.installationId,
        repository: payload.repository,
        pullNumber: payload.pullNumber,
        tenantId: job.tenantId,
        repositoryId: job.repositoryId,
      });
      const threadFileContent =
        thread && this.#githubAdapter.getFileContent
          ? await this.#githubAdapter.getFileContent({
              installationId: payload.installationId,
              repository: payload.repository,
              path: thread.path,
              ref: context.changeRequest.headSha,
            })
          : null;

      if (command === "reconsider" && thread !== null) {
        const result = await responder.reconsider(thread, {
          path: thread.path,
          patch:
            context.files.find((file) => file.path === thread.path)?.patch ??
            null,
          fileContent: threadFileContent,
        });
        if (
          result.resolve &&
          input.threadId &&
          this.#githubAdapter.resolveReviewThread
        ) {
          await this.#githubAdapter.resolveReviewThread({
            installationId: payload.installationId,
            threadId: input.threadId,
          });
          // Bookkeeping only: a failure here must not turn the reply into
          // the template fallback for a thread that is already resolved.
          try {
            await this.#reviewLifecycle.markPublishedCommentsResolved?.([
              input.threadId,
            ]);
          } catch (error) {
            logger.warn("Failed to mark reconsidered thread resolved.", {
              jobId: job.id,
              error: toErrorMessage(error),
            });
          }
        }
        if (result.resolve) {
          await this.#memoryService.recordDismissedFinding?.({
            tenantId: job.tenantId,
            repositoryId: job.repositoryId,
            path: thread.path,
            title: thread.title,
            body: thread.body,
            signal: "reconsider_refuted",
          });
        }
        logger.info("Reconsidered finding with the verifier.", {
          jobId: job.id,
          verdict: result.verdict,
          resolved: result.resolve,
        });
        return {
          body: result.body,
          feedbackEvents: result.resolve
            ? [
                {
                  fingerprint: thread.fingerprint,
                  path: thread.path,
                  category: categoryFromFingerprint(thread.fingerprint),
                  kind: "ignored",
                },
              ]
            : [],
          memoryDiscussions: [],
        };
      }

      const instructions = await this.#instructionBundleLoader
        .loadForReview(context)
        .then((bundle) => bundle.combinedText)
        .catch(() => "");
      // The adapter strips the mention and quoted text; never fall back to
      // the raw body, which would feed "@bot ..." into the prompt and memory.
      const question = payload.source.argumentText?.trim() ?? "";
      const memories = this.#memoryService.selectMemoriesForReview
        ? await this.#memoryService.selectMemoriesForReview({
            tenantId: job.tenantId,
            repositoryId: job.repositoryId,
            reviewedPaths: thread
              ? [thread.path]
              : context.files.map((file) => file.path),
            reviewContext: `${context.changeRequest.title}\n${question}`.slice(
              0,
              2_000,
            ),
            charBudget: 1_500,
          })
        : [];
      const answer = await responder.answer({
        // reconsider returned above, so only conversational commands remain.
        framing: command as "ask" | "why" | "teach",
        question,
        askerLogin: payload.actorLogin,
        pullRequest: {
          title: context.changeRequest.title,
          number: context.changeRequest.number,
        },
        thread,
        threadFile:
          thread && threadFileContent
            ? { path: thread.path, content: threadFileContent }
            : null,
        changedFiles: context.files.map((file) => ({
          path: file.path,
          patch: file.patch,
        })),
        instructions,
        memories: memories.map((entry) =>
          entry.path ? `${entry.path}: ${entry.summary}` : entry.summary,
        ),
      });
      // What people tell nitpickr in conversation is a learning candidate;
      // the memory classifier decides what, if anything, to keep.
      const learned =
        question.length > 0
          ? await this.#memoryService
              .ingestDiscussion({
                tenantId: job.tenantId,
                repositoryId: job.repositoryId,
                classifierOnly: true,
                discussions: [
                  {
                    authorLogin: payload.actorLogin,
                    body: question,
                    path: thread?.path ?? null,
                  },
                ],
              })
              .catch(() => ({ acknowledgments: [], savedEntries: [] }))
          : { acknowledgments: [], savedEntries: [] };
      // Summaries are model-written from the user's text: neutralize them
      // like answers before they are posted under nitpickr's name.
      const remembered = learned.savedEntries.map((entry) =>
        neutralizeMarkdown(entry.summary.replace(/\s+/g, " ").trim()),
      );
      return {
        body:
          remembered.length === 0
            ? answer
            : `${answer}\n\nI'll remember for this repo: ${remembered.join("; ")}`,
        feedbackEvents: [],
        memoryDiscussions: [],
      };
    } catch (error) {
      logger.warn("Model-backed reply failed.", {
        jobId: job.id,
        command,
        error: toErrorMessage(error),
      });
      const reason = describeReviewFailure(error);
      // why/teach have a useful answer without the model: the finding's own
      // explanation. Give it, and say the model couldn't add more.
      if ((command === "why" || command === "teach") && thread !== null) {
        return { fallbackNote: `I couldn't add more just now: ${reason}.` };
      }
      // Say what happened instead of a template that pretends the command
      // isn't supported.
      return {
        body: `I couldn't answer that just now: ${reason}. Ask again in a few minutes.`,
        feedbackEvents: [],
        memoryDiscussions: [],
      };
    }
  }

  async #learnFromThreads(input: {
    job: QueueJob;
    threads: LearnableThread[];
    logger: Logger;
    trustedReactors: string[];
    fileChangedSince?: (path: string, sinceSha: string) => Promise<boolean>;
  }): Promise<void> {
    await learnFromThreads({
      ...input,
      memoryService: this.#memoryService,
      ...(this.#feedbackService
        ? { feedbackService: this.#feedbackService }
        : {}),
      reviewLifecycle: this.#reviewLifecycle,
    });
  }

  async #dismissalFor(
    job: QueueJob,
    finding: ReviewFinding,
  ): Promise<string | null> {
    const matches =
      (await this.#memoryService.findSimilarDismissals?.({
        tenantId: job.tenantId,
        repositoryId: job.repositoryId,
        text: `${finding.title}. ${finding.body}`,
        minSimilarity: DISMISSAL_SIMILARITY,
      })) ?? [];
    const match = matches.find((candidate) => {
      const threshold = dismissalThreshold(finding, {
        path: candidate.entry.path,
        category: dismissedCategory(candidate.entry.tags),
      });
      return threshold !== null && candidate.similarity >= threshold;
    });
    return match
      ? `${match.entry.summary} (similarity ${match.similarity.toFixed(2)})`
      : null;
  }

  async #processMemoryJob(job: QueueJob, jobLogger: Logger): Promise<void> {
    const logger = jobLogger;
    const payload = parseMemoryJobPayload(job.payload);
    const ack = payload.acknowledgment;
    const ackStore = this.#discussionAcknowledgmentStore;

    if (ack && ackStore) {
      const already = await ackStore.wasAcknowledged({
        repositoryId: job.repositoryId,
        providerCommentId: ack.providerCommentId,
      });
      if (already) {
        logger.info(
          "Skipping memory ingestion — discussion already acknowledged.",
          {
            jobId: job.id,
            providerCommentId: ack.providerCommentId,
          },
        );
        return;
      }
    }

    if (ack && this.#githubAdapter.createIssueCommentReaction) {
      try {
        await this.#githubAdapter.createIssueCommentReaction({
          installationId: ack.installationId,
          repository: ack.repository,
          commentId: ack.commentNumericId,
          content: "eyes",
        });
      } catch (error) {
        logger.warn("Failed to post 👀 reaction on user discussion comment.", {
          jobId: job.id,
          providerCommentId: ack.providerCommentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const ingestion = await this.#memoryService.ingestDiscussion({
      tenantId: job.tenantId,
      repositoryId: job.repositoryId,
      discussions: payload.discussions,
    });

    if (ack) {
      const replyBody = formatAcknowledgmentReply(ingestion);
      try {
        if (
          ack.sourceKind === "issue_comment" &&
          this.#githubAdapter.createIssueComment
        ) {
          await this.#githubAdapter.createIssueComment({
            installationId: ack.installationId,
            repository: ack.repository,
            pullNumber: ack.pullNumber,
            body: replyBody,
          });
        } else if (
          ack.sourceKind === "review_comment" &&
          this.#githubAdapter.replyToReviewComment
        ) {
          await this.#githubAdapter.replyToReviewComment({
            installationId: ack.installationId,
            repository: ack.repository,
            pullNumber: ack.pullNumber,
            commentId: ack.commentNumericId,
            body: replyBody,
          });
        }
      } catch (error) {
        logger.warn("Failed to post acknowledgment reply.", {
          jobId: job.id,
          providerCommentId: ack.providerCommentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (ackStore) {
        await ackStore.markAcknowledged({
          repositoryId: job.repositoryId,
          providerCommentId: ack.providerCommentId,
          acknowledgedAt: this.#now().toISOString(),
        });
      }
    }

    logger.info("Processed memory ingestion job.", {
      jobId: job.id,
      discussionCount: payload.discussions.length,
      savedEntries: ingestion.savedEntries.length,
      acknowledged: ack !== null,
    });
  }

  async #publishReviewStatus<T>(
    phase: ReviewStatusPhase,
    fields: Record<string, unknown>,
    publish: () => Promise<T>,
    logger: Logger = this.#logger,
  ): Promise<T | null> {
    try {
      return await publish();
    } catch (error) {
      logger.warn("Review status update failed.", {
        ...fields,
        statusPhase: phase,
        error: toErrorMessage(error),
      });
      return null;
    }
  }
}
