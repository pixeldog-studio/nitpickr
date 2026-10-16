/**
 * When a new finding counts as a repeat of one this repository dismissed.
 * Shared by the worker and the live eval so both use the same numbers.
 */

/**
 * Cosine similarity (nomic-embed-text, finding text vs. stored finding text)
 * at which a new finding repeats a dismissed one. Calibrated on real pairs:
 * repeats scored 0.83-0.90, unrelated findings at most 0.69, and a related
 * but more serious finding 0.80. High and critical findings need a near
 * duplicate so an old nit cannot hide a serious new bug.
 */
export const DISMISSAL_SIMILARITY = 0.82;
export const DISMISSAL_SIMILARITY_SEVERE = 0.92;

/**
 * How close a finding must be to a past dismissal to be dropped. One
 * person's dismissal on one file should not silence a whole class of
 * findings repo-wide, and an old nit must not hide a serious new bug: both
 * other files and high/critical findings need a near duplicate.
 */
export function dismissalThreshold(
  finding: { severity: string; path: string },
  dismissedPath: string | null,
): number {
  const severe = finding.severity === "high" || finding.severity === "critical";
  const samePath = dismissedPath === null || dismissedPath === finding.path;
  return severe || !samePath
    ? DISMISSAL_SIMILARITY_SEVERE
    : DISMISSAL_SIMILARITY;
}
