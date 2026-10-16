import { targetReviewCommentLine } from "../publisher/review-comment-targeter.js";
import { fingerprintFinding } from "./finding-fingerprint.js";
import { revealInvisible } from "./untrusted-content.js";

export type EvidenceGateReason =
  | "path_not_in_scope"
  | "line_not_in_changed_context"
  | "finding_type_not_publishable"
  | "below_severity_floor"
  | "duplicates_open_thread"
  | "style_category"
  | "evidence_not_in_code"
  | "refuted_by_verifier"
  | "duplicates_nearby_finding"
  | "unconfirmed_below_floor"
  | "suppressed_by_feedback";

export interface ReviewFeedbackSignal {
  fingerprint?: string;
  path?: string;
  category?: string;
  findingType?: string;
  score: number;
  suppress?: boolean;
}

export interface EvidenceGateRejectedFinding<TFinding> {
  finding: TFinding;
  findingFingerprint: string;
  reasons: EvidenceGateReason[];
  /** Free-text detail, e.g. the verifier's refutation reason. */
  detail?: string;
}

interface GateFinding {
  path: string;
  line: number;
  findingType: string;
  severity: "low" | "medium" | "high" | "critical";
  category: string;
  title: string;
  evidence?: string | undefined;
}

interface ScopedFile {
  path: string;
  patch: string | null;
  fileContent?: string | null | undefined;
}

function normalizeCodeLine(line: string): string {
  return revealInvisible(line)
    .replace(/^\s*\d+:\s?/, "") // line numbers the verifier is shown
    .replace(/^[+\- ]/, "") // diff markers
    .replace(/\s+/g, " ")
    .trim();
}

/** A quote line that only marks omitted code: `...`, `…`, `// ...`. */
const ELISION_LINE = /^(?:\/\/|#|--|\/\*)?\s*(?:\.\.\.|…)\s*(?:\*\/)?$/;
const INLINE_ELISION = /\.\.\.|…/;
/** Shorter pieces match too easily to count as evidence. */
const MIN_FRAGMENT_LENGTH = 3;

/**
 * True when every quoted fragment appears in the patch or the file at HEAD,
 * ignoring diff markers, line-number prefixes, whitespace and line breaks,
 * and treating `...`/`…` as an elision. Quotes that match nothing mean the
 * finding describes code that is not there.
 */
export function evidenceAppearsInCode(
  evidence: string,
  file: ScopedFile,
): boolean {
  const lines = [file.patch ?? "", file.fileContent ?? ""]
    .flatMap((text) => text.split("\n"))
    .map(normalizeCodeLine)
    .filter((line) => line.length > 0);
  // Joined with spaces so a quote that merges two source lines still matches.
  const haystack = ` ${lines.join(" ")} `;
  const fragments = evidence
    .replace(/^```[\w-]*\n?|```$/g, "")
    .split("\n")
    .map(normalizeCodeLine)
    .filter((line) => line.length > 0 && !ELISION_LINE.test(line))
    .flatMap((line) => line.split(INLINE_ELISION))
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length >= MIN_FRAGMENT_LENGTH);
  return (
    fragments.length > 0 &&
    fragments.every((fragment) => haystack.includes(fragment))
  );
}

function patchIncludesLine(patch: string, line: number): boolean {
  const matches = [
    ...patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm),
  ];
  if (matches.length === 0) {
    // Some provider patches omit hunk headers for binary or compact diffs.
    // Keep those files eligible and let later comment targeting be the stricter gate.
    return true;
  }

  return matches.some((match) => {
    const start = Number.parseInt(match[1] ?? "0", 10);
    const count = Number.parseInt(match[2] ?? "1", 10);
    const end = start + Math.max(count - 1, 0);
    return line >= start && line <= end;
  });
}

export type Severity = "low" | "medium" | "high" | "critical";

/** Lines on either side of an open thread that count as the same spot. */
export const OPEN_THREAD_LINE_WINDOW = 3;

export function severityWeight(severity: Severity): number {
  switch (severity) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}

function matchesFeedbackSignal(
  finding: GateFinding,
  signal: ReviewFeedbackSignal,
): boolean {
  const fingerprint = fingerprintFinding(finding);
  const exactFingerprintMatch =
    signal.fingerprint !== undefined && signal.fingerprint === fingerprint;
  const pathMatch =
    signal.path !== undefined && signal.path === finding.path.trim();
  const categoryMatch =
    signal.category !== undefined && signal.category === finding.category;
  const findingTypeMatch =
    signal.findingType !== undefined &&
    signal.findingType === finding.findingType;

  return (
    exactFingerprintMatch || (pathMatch && (categoryMatch || findingTypeMatch))
  );
}

function feedbackScoreForFinding(
  finding: GateFinding,
  feedbackSignals: ReviewFeedbackSignal[],
): number {
  return feedbackSignals.reduce((score, signal) => {
    if (matchesFeedbackSignal(finding, signal)) {
      return score + signal.score;
    }

    return score;
  }, 0);
}

function isSuppressedByFeedback(
  finding: GateFinding,
  feedbackSignals: ReviewFeedbackSignal[],
): boolean {
  return feedbackSignals.some(
    (signal) =>
      (signal.suppress ?? false) && matchesFeedbackSignal(finding, signal),
  );
}

function compareFindingsWithFeedback(
  left: GateFinding,
  right: GateFinding,
  feedbackSignals: ReviewFeedbackSignal[],
): number {
  const feedbackDifference =
    feedbackScoreForFinding(right, feedbackSignals) -
    feedbackScoreForFinding(left, feedbackSignals);
  if (feedbackDifference !== 0) {
    return feedbackDifference;
  }

  const severityDifference =
    severityWeight(right.severity) - severityWeight(left.severity);
  if (severityDifference !== 0) {
    return severityDifference;
  }

  const pathComparison = left.path.localeCompare(right.path);
  if (pathComparison !== 0) {
    return pathComparison;
  }

  if (left.line !== right.line) {
    return left.line - right.line;
  }

  const categoryComparison = left.category.localeCompare(right.category);
  if (categoryComparison !== 0) {
    return categoryComparison;
  }

  return left.title.localeCompare(right.title);
}

export function gateAndRankFindings<TFinding extends GateFinding>(input: {
  findings: TFinding[];
  files: ScopedFile[];
  feedbackSignals?: ReviewFeedbackSignal[];
  publishableFindingTypes?: string[];
  /** Findings below this severity are rejected; null/undefined keeps all. */
  minimumSeverity?: Severity | null;
  /**
   * Locations of nitpickr threads that are still open on the PR. A finding
   * this close to one repeats it: models re-raise open threads even when told
   * not to, which is how one PR ended up with contradicting comments.
   */
  openThreads?: Array<{ path: string; line: number; category?: string }>;
  /** Reject findings whose quoted evidence is missing or not in the code. */
  requireEvidence?: boolean;
}): {
  acceptedFindings: TFinding[];
  rejectedFindings: EvidenceGateRejectedFinding<TFinding>[];
} {
  const scopedFiles = new Map(input.files.map((file) => [file.path, file]));
  const feedbackSignals = input.feedbackSignals ?? [];
  const rejectedFindings: EvidenceGateRejectedFinding<TFinding>[] = [];
  const acceptedFindings: TFinding[] = [];

  for (const finding of input.findings) {
    const reasons: EvidenceGateReason[] = [];
    const scopedFile = scopedFiles.get(finding.path);
    const patch = scopedFile === undefined ? undefined : scopedFile.patch;

    if (patch === undefined) {
      reasons.push("path_not_in_scope");
    } else if (
      patch !== null &&
      !patchIncludesLine(patch, finding.line) &&
      targetReviewCommentLine({
        requestedLine: finding.line,
        patch,
      }) === null
    ) {
      reasons.push("line_not_in_changed_context");
    }

    if (
      input.publishableFindingTypes !== undefined &&
      !input.publishableFindingTypes.includes(finding.findingType)
    ) {
      reasons.push("finding_type_not_publishable");
    }

    if (
      input.minimumSeverity != null &&
      severityWeight(finding.severity) < severityWeight(input.minimumSeverity)
    ) {
      reasons.push("below_severity_floor");
    }

    if (
      (input.openThreads ?? []).some(
        (thread) =>
          thread.path === finding.path &&
          (thread.category === undefined ||
            thread.category === finding.category) &&
          Math.abs(thread.line - finding.line) <= OPEN_THREAD_LINE_WINDOW,
      )
    ) {
      reasons.push("duplicates_open_thread");
    }

    if (finding.category === "style") {
      reasons.push("style_category");
    }

    if (
      input.requireEvidence &&
      scopedFile !== undefined &&
      (finding.evidence === undefined ||
        !evidenceAppearsInCode(finding.evidence, scopedFile))
    ) {
      reasons.push("evidence_not_in_code");
    }

    if (isSuppressedByFeedback(finding, feedbackSignals)) {
      reasons.push("suppressed_by_feedback");
    }

    if (reasons.length > 0) {
      rejectedFindings.push({
        finding,
        findingFingerprint: fingerprintFinding(finding),
        reasons,
      });
      continue;
    }

    acceptedFindings.push(finding);
  }

  const deduped = new Map<string, TFinding>();
  for (const finding of acceptedFindings) {
    const key = fingerprintFinding(finding);
    const current = deduped.get(key);
    if (
      !current ||
      compareFindingsWithFeedback(finding, current, feedbackSignals) < 0
    ) {
      deduped.set(key, finding);
    }
  }

  return {
    acceptedFindings: [...deduped.values()].sort((left, right) =>
      compareFindingsWithFeedback(left, right, feedbackSignals),
    ),
    rejectedFindings: rejectedFindings.sort((left, right) =>
      left.findingFingerprint.localeCompare(right.findingFingerprint),
    ),
  };
}
