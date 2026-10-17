import { describe, expect, it } from "vitest";

import { noopLogger } from "../../src/logging/logger.js";
import {
  dismissalThreshold,
  learnFromThreads,
} from "../../src/worker/worker-runner.js";

const thread = (overrides: Record<string, unknown>) => ({
  threadId: "thread_1",
  path: "src/users.ts",
  fingerprint: "src/users.ts:5:correctness:no_timeout",
  isResolved: false,
  isOutdated: false,
  originalCommitSha: "c".repeat(40),
  body: "🟠 **fetch has no timeout**\n\nA hung upstream blocks forever.",
  reactionSummary: { negativeCount: 0 },
  ...overrides,
});

function harness(
  alreadySettled: Set<string>,
  options: { fileChanged?: boolean; remembered?: boolean } = {},
) {
  const outcomes: unknown[] = [];
  const dismissals: Array<{ signal: string; title: string }> = [];
  return {
    outcomes,
    dismissals,
    deps: {
      job: { id: "job_1", tenantId: "t", repositoryId: "r" },
      logger: noopLogger,
      trustedReactors: ["owner"],
      fileChangedSince: async () => options.fileChanged ?? false,
      memoryService: {
        findSimilarDismissals: async () => [],
        hasDismissalFromThread: async () => options.remembered ?? false,
        recordDismissedFinding: async (entry: {
          signal: string;
          title: string;
        }) => {
          dismissals.push({ signal: entry.signal, title: entry.title });
          return null;
        },
      },
      feedbackService: {
        recordOutcome: async (input: unknown) => {
          outcomes.push(input);
        },
      },
      reviewLifecycle: {
        markPublishedCommentsResolved: async (ids: string[]) => {
          const fresh = ids.filter((id) => !alreadySettled.has(id));
          for (const id of fresh) alreadySettled.add(id);
          return fresh.length;
        },
      },
    },
  };
}

describe("learnFromThreads", () => {
  it("records a human resolve without a code change exactly once", async () => {
    const settled = new Set<string>();
    const run = harness(settled);
    const threads = [thread({ isResolved: true })];

    await learnFromThreads({ ...run.deps, threads } as never);
    await learnFromThreads({ ...run.deps, threads } as never);

    expect(run.outcomes).toHaveLength(1);
    expect(run.dismissals).toEqual([
      { signal: "resolved_without_change", title: "fetch has no timeout" },
    ]);
  });

  it("ignores threads nitpickr resolved itself or that a push changed", async () => {
    const run = harness(new Set(["thread_1"]));
    await learnFromThreads({
      ...run.deps,
      threads: [
        thread({ isResolved: true }),
        thread({ threadId: "thread_2", isResolved: true, isOutdated: true }),
      ],
    } as never);
    expect(run.outcomes).toEqual([]);
    expect(run.dismissals).toEqual([]);
  });

  it("remembers thumbs-down findings", async () => {
    const run = harness(new Set());
    await learnFromThreads({
      ...run.deps,
      threads: [
        thread({
          reactionSummary: { negativeCount: 1, negativeReactors: ["owner"] },
        }),
      ],
    } as never);
    expect(run.dismissals).toEqual([
      { signal: "thumbs_down", title: "fetch has no timeout" },
    ]);
  });
});

describe("learnFromThreads safeguards", () => {
  it("learns nothing when the file changed after the comment (likely fixed)", async () => {
    const settled = new Set<string>();
    const run = harness(settled, { fileChanged: true });
    await learnFromThreads({
      ...run.deps,
      threads: [thread({ isResolved: true })],
    } as never);
    expect(run.outcomes).toEqual([]);
    expect(run.dismissals).toEqual([]);
    expect(settled.has("thread_1")).toBe(true);
  });

  it("learns nothing without the comment's commit", async () => {
    const run = harness(new Set());
    await learnFromThreads({
      ...run.deps,
      threads: [thread({ isResolved: true, originalCommitSha: undefined })],
    } as never);
    expect(run.dismissals).toEqual([]);
  });

  it("ignores a thumbs-down from someone other than the author or owner", async () => {
    const run = harness(new Set());
    await learnFromThreads({
      ...run.deps,
      threads: [
        thread({
          reactionSummary: { negativeCount: 1, negativeReactors: ["stranger"] },
        }),
      ],
    } as never);
    expect(run.dismissals).toEqual([]);
  });

  it("records a thumbs-down only once", async () => {
    const run = harness(new Set(), { remembered: true });
    await learnFromThreads({
      ...run.deps,
      threads: [
        thread({
          reactionSummary: { negativeCount: 1, negativeReactors: ["owner"] },
        }),
      ],
    } as never);
    expect(run.dismissals).toEqual([]);
  });
});

describe("dismissalThreshold", () => {
  const at = (severity: string, path: string, dismissedPath: string | null) =>
    dismissalThreshold(
      { severity, path, category: "correctness" },
      { path: dismissedPath, category: "correctness" },
    );

  it("needs a near duplicate for other files and serious findings", () => {
    const base = at("medium", "a.ts", "a.ts") ?? 0;
    expect(base).toBeLessThan(at("medium", "a.ts", "b.ts") ?? 0);
    expect(base).toBeLessThan(at("high", "a.ts", "a.ts") ?? 0);
  });

  it("lets a same-file dismissal hold when the model re-rates it as high", () => {
    const sameFileHigh = at("high", "a.ts", "a.ts") ?? 0;
    expect(sameFileHigh).toBeGreaterThan(0.8); // a related serious finding scored 0.80
    expect(sameFileHigh).toBeLessThan(0.87); // the re-rated repeat scored 0.86-0.89
    expect(at("high", "a.ts", "b.ts")).toBe(0.92);
  });

  it("treats a dismissal without a file as another file", () => {
    expect(at("medium", "a.ts", null)).toBe(0.92);
  });

  it("never hides critical or security findings, or another kind of finding", () => {
    expect(at("critical", "a.ts", "a.ts")).toBeNull();
    expect(
      dismissalThreshold(
        { severity: "medium", path: "a.ts", category: "security" },
        { path: "a.ts", category: "security" },
      ),
    ).toBeNull();
    expect(
      dismissalThreshold(
        { severity: "medium", path: "a.ts", category: "correctness" },
        { path: "a.ts", category: "maintainability" },
      ),
    ).toBeNull();
  });
});
