import { describe, expect, it } from "vitest";

import { maybeTrimSentenceCount } from "../../src/review/review-engine.js";

describe("maybeTrimSentenceCount", () => {
  it("keeps the first sentences", () => {
    expect(maybeTrimSentenceCount("One. Two! Three? Four.", 2)).toBe(
      "One. Two!",
    );
  });

  it("does not split inside inline code or dotted tokens", () => {
    expect(
      maybeTrimSentenceCount(
        "The job's `headSha` ('a'.repeat(40)) differs from v1.2 here. Second. Third.",
        2,
      ),
    ).toBe(
      "The job's `headSha` ('a'.repeat(40)) differs from v1.2 here. Second.",
    );
  });

  it("returns short text unchanged", () => {
    expect(maybeTrimSentenceCount("No terminal punctuation", 2)).toBe(
      "No terminal punctuation",
    );
  });
});
