/**
 * When a new finding counts as a repeat of one this repository dismissed.
 * Shared by the worker and the live eval so both use the same numbers.
 */

/**
 * Cosine similarity (nomic-embed-text, finding text vs. stored finding text)
 * at which a new finding repeats a dismissed one. Calibrated on real pairs:
 * repeats scored 0.83-0.90, unrelated findings at most 0.69, and a related
 * but more serious finding 0.80.
 */
export const DISMISSAL_SIMILARITY = 0.82;
/** Same file, but the finding is high or critical. */
export const DISMISSAL_SIMILARITY_SAME_FILE_SEVERE = 0.85;
/** Another file: one person's dismissal should not silence a class repo-wide. */
export const DISMISSAL_SIMILARITY_SEVERE = 0.92;

/**
 * How close a finding must be to a past dismissal to be dropped. A related
 * but different serious finding scored 0.80 in calibration, so a high or
 * critical finding on the same file needs 0.85 (the model often re-rates the
 * same dismissed issue as high), and anything on another file needs a near
 * duplicate.
 */
export function dismissalThreshold(
  finding: { severity: string; path: string; category?: string },
  dismissed: { path: string | null; category?: string | null },
): number | null {
  // Similarity alone never hides a critical or a security finding, nor one
  // of a different kind than what was dismissed (a dismissed maintainability
  // note must not silence a correctness bug on the same lines).
  if (finding.severity === "critical" || finding.category === "security") {
    return null;
  }
  if (
    dismissed.category &&
    finding.category &&
    dismissed.category !== finding.category
  ) {
    return null;
  }
  const severe = finding.severity === "high";
  // A dismissal with no file is not "this file": treat it as another file.
  const samePath = dismissed.path !== null && dismissed.path === finding.path;
  if (!samePath) {
    return DISMISSAL_SIMILARITY_SEVERE;
  }
  return severe ? DISMISSAL_SIMILARITY_SAME_FILE_SEVERE : DISMISSAL_SIMILARITY;
}

/** The finding category a dismissal was recorded for, from its tags. */
export function dismissedCategory(tags: string[]): string | null {
  const tag = tags.find((entry) => entry.startsWith("category:"));
  return tag ? tag.slice("category:".length) : null;
}
