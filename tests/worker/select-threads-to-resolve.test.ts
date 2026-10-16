import { describe, expect, it } from "vitest";

import type { PriorThread } from "../../src/review/prompt-builder.js";
import { selectThreadsToResolve } from "../../src/worker/worker-runner.js";

function priorThread(id: string, needsVerdict: boolean): PriorThread {
  return {
    id,
    needsVerdict,
    path: "src/a.ts",
    line: 10,
    state: "open",
    title: "Something",
    fingerprint: `fp-${id}`,
  };
}

describe("selectThreadsToResolve", () => {
  const existingThreads = ["thread-1", "thread-2", "thread-3", "thread-4"];
  const priorThreads = [
    priorThread("T1", true),
    priorThread("T2", true),
    priorThread("T3", true),
    priorThread("T4", false),
  ];

  it("resolves only threads with a fixed or obsolete verdict", () => {
    const selected = selectThreadsToResolve({
      priorThreads,
      existingThreads,
      verdicts: [
        { threadId: "T1", verdict: "fixed" },
        { threadId: "T2", verdict: "still_applies" },
        { threadId: "T3", verdict: "obsolete" },
      ],
    });

    expect(selected).toEqual([
      { thread: "thread-1", verdict: "fixed" },
      { thread: "thread-3", verdict: "obsolete" },
    ]);
  });

  it("keeps threads open when the model gives no verdict", () => {
    expect(
      selectThreadsToResolve({ priorThreads, existingThreads, verdicts: [] }),
    ).toEqual([]);
  });

  it("ignores verdicts for threads that did not need one", () => {
    expect(
      selectThreadsToResolve({
        priorThreads,
        existingThreads,
        verdicts: [{ threadId: "T4", verdict: "fixed" }],
      }),
    ).toEqual([]);
  });
});
