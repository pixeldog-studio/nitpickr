import { fingerprintFinding } from "../review/finding-fingerprint.js";
import { renderCommandTips } from "../review/reviewer-chat-service.js";
import {
  DIAGNOSTIC_ELLIPSIS_TRUNCATION_MARKER,
  DIAGNOSTIC_MAX_SERIALIZED_LENGTH,
  DIAGNOSTIC_MAX_STRING_LENGTH,
  DIAGNOSTIC_OBJECT_BUDGET,
  DIAGNOSTIC_OBJECT_TRUNCATION_MARKER,
  DIAGNOSTIC_OBJECT_TRUNCATION_MARKER_VARIANTS,
  DIAGNOSTIC_SANITIZED_MAX_LENGTH,
} from "./diagnostic-constants.js";
import { targetReviewCommentLine } from "./review-comment-targeter.js";

export interface PublishedFinding {
  path: string;
  line: number;
  findingType: "bug" | "safe_suggestion" | "question" | "teaching_note";
  severity: "low" | "medium" | "high" | "critical";
  category:
    | "correctness"
    | "performance"
    | "security"
    | "maintainability"
    | "testing"
    | "style";
  title: string;
  body: string;
  fixPrompt: string;
  suggestedChange?: string | undefined;
  failureScenario?: string | undefined;
}

export interface PublishReviewClient {
  listPullRequestReviews(input: {
    installationId: string;
    repository: {
      owner: string;
      name: string;
    };
    pullNumber: number;
  }): Promise<
    Array<{
      reviewId: string;
      body: string;
    }>
  >;
  publishPullRequestReview(input: {
    installationId: string;
    repository: {
      owner: string;
      name: string;
    };
    pullNumber: number;
    body: string;
    comments: Array<{
      path: string;
      line: number;
      side: "RIGHT";
      body: string;
    }>;
  }): Promise<{
    reviewId: string;
  }>;
}

function toProviderReviewComments(comments: PublishedInlineComment[]): Array<{
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}> {
  return comments.map((comment) => ({
    path: comment.path,
    line: comment.line,
    side: comment.side,
    body: comment.body,
  }));
}

export interface PublishedInlineComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
  fingerprint: string;
  providerThreadId?: string | null;
  providerCommentId?: string | null;
  resolvedAt?: string | null;
}

const severityLabel: Record<PublishedFinding["severity"], string> = {
  low: "⚪ Low",
  medium: "🟡 Medium",
  high: "🟠 High",
  critical: "🔴 Critical",
};

const severityDot: Record<PublishedFinding["severity"], string> = {
  low: "⚪",
  medium: "🟡",
  high: "🟠",
  critical: "🔴",
};

/**
 * One line of model-written prose that is safe to drop into the summary:
 * the model echoes PR content, so it must not be able to close the
 * `<details>` block, add headings, embed images or mention people. Code
 * spans are kept as written.
 */
export function neutralizeProse(text: string, maxLength = 400): string {
  const line = text.replace(/\s+/g, " ").trim();
  const clipped =
    line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
  return clipped
    .split(/(`[^`]*`)/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/!\[/g, "!&#91;")
            .replace(/@(?=[\w-])/g, "@\u200b"),
    )
    .join("");
}

/**
 * Findings the verifier could not confirm: still worth knowing about, but
 * not worth interrupting someone with an inline comment.
 */
export function renderSecondLook(findings: PublishedFinding[]): string | null {
  if (findings.length === 0) {
    return null;
  }
  return [
    "<details>",
    `<summary>Worth a second look (${findings.length}, not confirmed)</summary>`,
    "",
    ...findings.map(
      (finding) =>
        `- \`${finding.path}:${finding.line}\` **${neutralizeProse(finding.title, 120)}**: ${neutralizeProse(finding.body)}`,
    ),
    "",
    "</details>",
  ].join("\n");
}

/** One scannable line under the title: severity and what kind of problem. */
export function renderFindingLabel(
  finding: Pick<PublishedFinding, "severity" | "category">,
): string {
  return `${severityLabel[finding.severity]} · ${finding.category}`;
}

function escapeMarkdownTableCell(value: string): string {
  return neutralizeProse(value).replace(/\|/g, "\\|");
}

function renderGitHubSuggestion(suggestedChange: string | undefined): string[] {
  if (!suggestedChange) {
    return [];
  }

  return ["```suggestion", suggestedChange, "```", ""];
}

/** The headline after "nitpickr ·" in the first review. */
export function summarizeFindingCount(
  findings: Array<Pick<PublishedFinding, "severity">>,
  secondLookCount = 0,
): string {
  if (findings.length === 0 && secondLookCount > 0) {
    return `no confirmed issues; ${secondLookCount} unconfirmed ${
      secondLookCount === 1 ? "item" : "items"
    } below.`;
  }
  if (findings.length === 0) {
    return "nothing worth flagging in this PR.";
  }
  const blocking = findings.some(
    (finding) => finding.severity === "high" || finding.severity === "critical",
  );
  const noun = findings.length === 1 ? "thing" : "things";
  return blocking
    ? `${findings.length} ${noun} to fix before merging.`
    : `${findings.length} ${noun} worth a look.`;
}

function buildReviewRunMarker(reviewRunId: string): string {
  return `<!-- nitpickr:review-run:${reviewRunId} -->`;
}

function buildSummaryMarker(): string {
  return "<!-- nitpickr:summary -->";
}

function parseStatusCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string") {
    if (!/^\d+$/.test(value.trim())) {
      return null;
    }

    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }

  return null;
}

function pushText(values: string[], value: unknown): void {
  if (typeof value !== "string") {
    return;
  }

  const trimmed = value.trim();
  if (trimmed.length > 0) {
    values.push(trimmed);
  }
}

function collectErrorTextsFromPayload(payload: unknown): {
  statusCode: number | null;
  texts: string[];
} {
  if (typeof payload !== "object" || payload === null) {
    return {
      statusCode: null,
      texts: [],
    };
  }

  const record = payload as Record<string, unknown>;
  const texts: string[] = [];
  pushText(texts, record.message);

  const errors = record.errors;
  if (typeof errors === "string") {
    pushText(texts, errors);
  } else if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (typeof entry === "string") {
        pushText(texts, entry);
        continue;
      }

      if (typeof entry === "object" && entry !== null) {
        const errorRecord = entry as Record<string, unknown>;
        pushText(texts, errorRecord.message);
      }
    }
  }

  return {
    statusCode: parseStatusCode(record.status),
    texts,
  };
}

function toDiagnosticErrorSourceText(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    const visited = new WeakSet<object>();
    let remainingObjectBudget = DIAGNOSTIC_OBJECT_BUDGET;

    try {
      const serialized = JSON.stringify(value, (_key, entry) => {
        if (typeof entry === "bigint") {
          return entry.toString();
        }

        if (typeof entry === "string") {
          return entry.length > DIAGNOSTIC_MAX_STRING_LENGTH
            ? `${entry.slice(0, DIAGNOSTIC_MAX_STRING_LENGTH)}${DIAGNOSTIC_ELLIPSIS_TRUNCATION_MARKER}`
            : entry;
        }

        if (entry === null || typeof entry !== "object") {
          return entry;
        }

        if (visited.has(entry)) {
          return "[Circular]";
        }
        visited.add(entry);

        if (remainingObjectBudget <= 0) {
          return DIAGNOSTIC_OBJECT_TRUNCATION_MARKER;
        }
        remainingObjectBudget -= 1;

        return entry;
      });

      if (typeof serialized === "string") {
        return serialized.length <= DIAGNOSTIC_MAX_SERIALIZED_LENGTH
          ? serialized
          : `${serialized.slice(0, DIAGNOSTIC_MAX_SERIALIZED_LENGTH)}${DIAGNOSTIC_ELLIPSIS_TRUNCATION_MARKER}`;
      }
    } catch {
      // Fall back to String(...) below.
    }
  }

  return String(value);
}

export function sanitizeDiagnosticErrorMessage(value: unknown): string {
  const raw = toDiagnosticErrorSourceText(value);
  const sanitized = raw
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();

  if (sanitized.length === 0) {
    return "unavailable";
  }

  if (sanitized.length <= DIAGNOSTIC_SANITIZED_MAX_LENGTH) {
    return sanitized;
  }

  for (const marker of [
    DIAGNOSTIC_ELLIPSIS_TRUNCATION_MARKER,
    ...DIAGNOSTIC_OBJECT_TRUNCATION_MARKER_VARIANTS,
  ]) {
    if (!sanitized.includes(marker)) {
      continue;
    }

    const prefixLength = DIAGNOSTIC_SANITIZED_MAX_LENGTH - marker.length;
    if (prefixLength <= 0) {
      return marker.slice(0, DIAGNOSTIC_SANITIZED_MAX_LENGTH);
    }
    return `${sanitized.slice(0, prefixLength)}${marker}`;
  }

  return sanitized.slice(0, DIAGNOSTIC_SANITIZED_MAX_LENGTH);
}

function parseJsonPayloadFromText(text: string): unknown | null {
  const tryParseObject = (candidate: string): unknown | null => {
    if (!candidate.startsWith("{")) {
      return null;
    }

    try {
      const parsed = JSON.parse(candidate) as unknown;
      return typeof parsed === "object" && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  };

  // Function-scoped sentinel to avoid duplicate logs during a single scan.
  let parseErrorLogged = false;
  const safeTryParseObject = (candidate: string): unknown | null => {
    try {
      return tryParseObject(candidate);
    } catch (error) {
      if (!parseErrorLogged) {
        parseErrorLogged = true;
        console.debug("parseJsonPayloadFromText parse error", {
          errorMessage: sanitizeDiagnosticErrorMessage(error),
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
      return null;
    }
  };

  const direct = safeTryParseObject(text.trim());
  if (direct !== null) {
    return direct;
  }

  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === "{") {
      if (depth === 0) {
        objectStart = index;
      }
      depth += 1;
      continue;
    }

    if (character !== "}" || depth === 0) {
      continue;
    }

    depth -= 1;
    if (depth === 0 && objectStart >= 0) {
      const candidate = text.slice(objectStart, index + 1).trim();
      const parsed = safeTryParseObject(candidate);
      if (parsed !== null) {
        return parsed;
      }

      objectStart = -1;
    }
  }

  return null;
}

function isInlineCommentResolutionError(error: unknown): boolean {
  const candidateTexts: string[] = [];
  let statusIs422 = false;

  const inspect = (value: unknown): void => {
    if (value instanceof Error) {
      pushText(candidateTexts, value.message);
      const parsedPayload = parseJsonPayloadFromText(value.message);
      if (parsedPayload) {
        const extracted = collectErrorTextsFromPayload(parsedPayload);
        if (extracted.statusCode === 422) {
          statusIs422 = true;
        }
        candidateTexts.push(...extracted.texts);
      }

      const cause = (value as Error & { cause?: unknown }).cause;
      if (cause !== undefined) {
        inspect(cause);
      }
      return;
    }

    if (typeof value === "string") {
      pushText(candidateTexts, value);
      const parsedPayload = parseJsonPayloadFromText(value);
      if (parsedPayload) {
        const extracted = collectErrorTextsFromPayload(parsedPayload);
        if (extracted.statusCode === 422) {
          statusIs422 = true;
        }
        candidateTexts.push(...extracted.texts);
      }
      return;
    }

    const extracted = collectErrorTextsFromPayload(value);
    if (extracted.statusCode === 422) {
      statusIs422 = true;
    }
    candidateTexts.push(...extracted.texts);
  };

  inspect(error);

  if (!statusIs422) {
    statusIs422 = candidateTexts.some((text) =>
      /status\s*:?\s*422/i.test(text),
    );
  }

  if (!statusIs422) {
    return false;
  }

  const message = candidateTexts.join("\n").toLowerCase();

  return (
    message.includes("path could not be resolved") ||
    message.includes("line could not be resolved")
  );
}

/**
 * The line that tells the author where the PR stands once a round has no new
 * findings: either nothing is left, or which earlier threads still are.
 */
export function buildEndStateLine(
  openThreads: number,
  secondLookCount = 0,
): string {
  if (openThreads === 0 && secondLookCount > 0) {
    return `**No confirmed issues.** ${secondLookCount} unconfirmed ${
      secondLookCount === 1 ? "item is" : "items are"
    } listed below; check ${secondLookCount === 1 ? "it" : "them"} before merging.`;
  }
  if (openThreads === 0) {
    return "**No further comments.** Every nitpickr thread on this PR is resolved; it's over to a human reviewer.";
  }
  return `No new findings. ${openThreads} earlier ${
    openThreads === 1 ? "thread is" : "threads are"
  } still open.`;
}

function shortSha(sha: string | undefined): string | null {
  if (!sha) {
    return null;
  }

  const trimmed = sha.trim();
  if (trimmed.length < 7) {
    return null;
  }

  return trimmed.slice(0, 7);
}

export class ReviewPublisher {
  readonly #client: PublishReviewClient;
  readonly #botLogin: string;

  /** `botLogin` is the handle shown in the "talk to nitpickr" tips. */
  constructor(
    client: PublishReviewClient,
    options: { botLogin?: string } = {},
  ) {
    this.#client = client;
    this.#botLogin = options.botLogin ?? "nitpickr";
  }

  buildSummaryBody(input: {
    reviewRunId: string;
    summary: string;
    mermaid: string;
    findings: PublishedFinding[];
    /** False when no files were reviewed (all ignored or none matched). */
    reviewed?: boolean;
    /** Unconfirmed findings listed under the summary. */
    secondLookCount?: number;
  }): string {
    const findingTable =
      input.findings.length === 0
        ? null
        : [
            "| | Where | Finding |",
            "| --- | --- | --- |",
            ...input.findings.map(
              (finding) =>
                `| ${severityDot[finding.severity]} | \`${finding.path}:${finding.line}\` | ${escapeMarkdownTableCell(finding.title)} |`,
            ),
          ].join("\n");

    return [
      buildSummaryMarker(),
      buildReviewRunMarker(input.reviewRunId),
      "",
      `**nitpickr** · ${
        input.reviewed === false
          ? "nothing to review here."
          : summarizeFindingCount(input.findings, input.secondLookCount ?? 0)
      }`,
      "",
      input.summary.trim(),
      ...(findingTable === null ? [] : ["", findingTable]),
      "",
      "<details>",
      "<summary>Change flow</summary>",
      "",
      "```mermaid",
      input.mermaid.trim(),
      "```",
      "",
      "</details>",
      "",
      "<details>",
      "<summary>Talk to nitpickr</summary>",
      "",
      renderCommandTips(this.#botLogin),
      "",
      "</details>",
    ].join("\n");
  }

  buildFollowUpBody(reviewRunId: string, statusLine?: string | null): string {
    return statusLine
      ? [buildReviewRunMarker(reviewRunId), "", statusLine].join("\n")
      : buildReviewRunMarker(reviewRunId);
  }

  buildCommitSummaryBody(input: {
    reviewRunId: string;
    summary: string;
    reviewedCommitSha?: string;
    counts: {
      newFindings: number;
      resolvedThreads: number;
      openThreads: number;
      secondLook?: number;
    };
  }): string {
    const commitLabel = shortSha(input.reviewedCommitSha);
    const headline =
      input.counts.newFindings > 0
        ? `${input.counts.newFindings} new ${
            input.counts.newFindings === 1 ? "finding" : "findings"
          } in this push.`
        : buildEndStateLine(
            input.counts.openThreads,
            input.counts.secondLook ?? 0,
          );

    return [
      buildReviewRunMarker(input.reviewRunId),
      "",
      `**nitpickr**${commitLabel ? ` · \`${commitLabel}\`` : ""} · ${headline}`,
      "",
      input.summary.trim(),
      input.counts.resolvedThreads > 0
        ? `\nResolved ${input.counts.resolvedThreads} ${
            input.counts.resolvedThreads === 1 ? "thread" : "threads"
          } this push fixed.`
        : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  buildInlineComments(
    findings: PublishedFinding[],
    input: {
      files?: Array<{
        path: string;
        patch: string | null;
      }>;
      maxLineDistance?: number;
    } = {},
  ): PublishedInlineComment[] {
    const patchByPath = new Map(
      (input.files ?? []).map((file) => [file.path, file.patch]),
    );

    return findings.flatMap((finding) => {
      const patch = patchByPath.get(finding.path) ?? null;
      const line =
        input.files === undefined
          ? finding.line
          : targetReviewCommentLine(
              input.maxLineDistance === undefined
                ? {
                    requestedLine: finding.line,
                    patch,
                  }
                : {
                    requestedLine: finding.line,
                    patch,
                    maxLineDistance: input.maxLineDistance,
                  },
            );

      if (line === null) {
        return [];
      }

      return [
        {
          path: finding.path,
          line,
          side: "RIGHT",
          fingerprint: fingerprintFinding(finding),
          body: [
            `**${finding.title}**`,
            renderFindingLabel(finding),
            "",
            `${finding.body}`,
            "",
            ...renderGitHubSuggestion(finding.suggestedChange),
            `<!-- nitpickr:fingerprint:${fingerprintFinding(finding)} -->`,
            "<details>",
            "<summary>Prompt for your coding agent</summary>",
            "",
            "```text",
            finding.failureScenario
              ? `${finding.fixPrompt}\n\nFailure scenario: ${finding.failureScenario}`
              : finding.fixPrompt,
            "```",
            "",
            "</details>",
          ].join("\n"),
        },
      ];
    });
  }

  async publish(input: {
    reviewRunId: string;
    installationId: string;
    repository: {
      owner: string;
      name: string;
    };
    pullNumber: number;
    publishMode: "pr_summary" | "commit_summary";
    reviewedCommitSha?: string;
    /**
     * Counts only the caller knows. Finding counts are derived here from the
     * inline comments actually posted: findings whose line cannot be anchored
     * to the diff are dropped and must not be reported as new.
     */
    commitSummaryCounts?: {
      resolvedThreads: number;
    };
    /** Earlier nitpickr threads still unresolved after this round. */
    openPriorThreadCount?: number;
    result: {
      summary: string;
      mermaid: string;
      findings: PublishedFinding[];
      /** Lower-confidence findings listed in the review body, not inline. */
      secondLook?: PublishedFinding[];
    };
    files?: Array<{
      path: string;
      patch: string | null;
    }>;
  }): Promise<{ reviewId: string }> {
    if (input.repository.owner.trim().length === 0) {
      throw new Error("repository owner must not be empty.");
    }
    if (input.repository.name.trim().length === 0) {
      throw new Error("repository name must not be empty.");
    }
    if (input.pullNumber <= 0) {
      throw new Error("pullNumber must be positive.");
    }

    const existingReviews = await this.#client.listPullRequestReviews({
      installationId: input.installationId,
      repository: input.repository,
      pullNumber: input.pullNumber,
    });

    const existingReview = existingReviews.find((review) =>
      review.body.includes(buildReviewRunMarker(input.reviewRunId)),
    );

    if (existingReview) {
      return {
        reviewId: existingReview.reviewId,
      };
    }

    const existingSummaryReview = existingReviews.find((review) =>
      review.body.includes(buildSummaryMarker()),
    );
    const comments =
      input.files === undefined
        ? this.buildInlineComments(input.result.findings)
        : this.buildInlineComments(input.result.findings, {
            files: input.files,
          });

    const openThreads = input.openPriorThreadCount ?? 0;
    const postedFingerprints = new Set(
      comments.map((comment) => comment.fingerprint),
    );
    const body =
      input.publishMode === "commit_summary"
        ? this.buildCommitSummaryBody({
            reviewRunId: input.reviewRunId,
            summary: input.result.summary,
            counts: {
              newFindings: comments.length,
              resolvedThreads: input.commitSummaryCounts?.resolvedThreads ?? 0,
              openThreads,
              secondLook: input.result.secondLook?.length ?? 0,
            },
            ...(input.reviewedCommitSha
              ? { reviewedCommitSha: input.reviewedCommitSha }
              : {}),
          })
        : existingSummaryReview
          ? this.buildFollowUpBody(
              input.reviewRunId,
              comments.length === 0
                ? buildEndStateLine(
                    openThreads,
                    input.result.secondLook?.length ?? 0,
                  )
                : null,
            )
          : this.buildSummaryBody({
              reviewRunId: input.reviewRunId,
              summary: input.result.summary,
              mermaid: input.result.mermaid,
              // Only findings that became inline comments: the headline and
              // table must match what the author actually sees.
              findings: input.result.findings.filter((finding) =>
                postedFingerprints.has(fingerprintFinding(finding)),
              ),
              reviewed: input.files === undefined || input.files.length > 0,
              secondLookCount: input.result.secondLook?.length ?? 0,
            });

    const secondLook = renderSecondLook(input.result.secondLook ?? []);
    const fullBody = secondLook === null ? body : `${body}\n\n${secondLook}`;
    const providerComments = toProviderReviewComments(comments);

    try {
      return await this.#client.publishPullRequestReview({
        installationId: input.installationId,
        repository: input.repository,
        pullNumber: input.pullNumber,
        body: fullBody,
        comments: providerComments,
      });
    } catch (error) {
      if (
        providerComments.length > 0 &&
        isInlineCommentResolutionError(error)
      ) {
        return this.#client.publishPullRequestReview({
          installationId: input.installationId,
          repository: input.repository,
          pullNumber: input.pullNumber,
          body: fullBody,
          comments: [],
        });
      }

      throw error;
    }
  }
}
