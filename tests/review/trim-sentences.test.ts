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

describe("sentence ends", () => {
  it("does not end a sentence at e.g., i.e. or a number", async () => {
    const { maybeTrimSentenceCount } = await import(
      "../../src/review/review-engine.js"
    );
    expect(
      maybeTrimSentenceCount(
        "Foo throws. Use e.g. `Map` here. Step 2. done",
        2,
      ),
    ).toBe("Foo throws. Use e.g. `Map` here.");
  });
});
