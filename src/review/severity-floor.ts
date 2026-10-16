// Round-aware severity floor for review findings.
//
// When the same PR has already been reviewed N times by nitpickr, the marginal
// value of low-severity findings drops sharply (we've seen 7-round nit cascades
// in dogfood). To keep the signal-to-noise ratio sane on long-iteration PRs,
// we apply a hard floor below which findings are dropped before publishing.
//
// Schedule (priorReviewRoundCount = number of *prior* completed runs):
//   0 to 3 → drop "low" (nitpicks belong in linters, not review comments)
//   ≥ 4   → drop "low" and "medium"
//
// This module is consumed by both the prompt builder (so the LLM can
// self-restrain and save tokens) and the worker (a hard server-side gate
// applied after the model returns; defense-in-depth).

import { type Severity, severityWeight } from "./evidence-gate.js";
import type { ReviewEngineResult, ReviewFinding } from "./review-engine.js";

export type SeverityFloor = Severity | null;

/**
 * Return the severity strictly *below which* findings should be dropped, or
 * null when no floor applies. A finding with severity equal to the floor is
 * *kept* (the floor is the minimum severity allowed).
 */
export function severityFloorForRound(
  priorReviewRoundCount: number,
): SeverityFloor {
  if (priorReviewRoundCount >= 4) {
    return "high";
  }
  return "medium";
}

export interface SeverityFloorPartition {
  kept: ReviewEngineResult;
  dropped: ReviewFinding[];
}

/**
 * Partition findings against the floor. The `kept` result preserves all
 * non-finding fields (summary, mermaid) unchanged. `dropped` is empty when
 * the floor is null or no findings fall below it.
 */
export function applySeverityFloor(
  result: ReviewEngineResult,
  floor: SeverityFloor,
): SeverityFloorPartition {
  if (floor === null) {
    return { kept: result, dropped: [] };
  }
  const floorWeight = severityWeight(floor);
  const kept: ReviewFinding[] = [];
  const dropped: ReviewFinding[] = [];
  for (const finding of result.findings) {
    if (severityWeight(finding.severity) >= floorWeight) {
      kept.push(finding);
    } else {
      dropped.push(finding);
    }
  }
  return {
    kept: { ...result, findings: kept },
    dropped,
  };
}
