import { describe, expect, it } from "vitest";

import { noopLogger } from "../../src/logging/logger.js";
import { learnFromThreads } from "../../src/worker/worker-runner.js";

const thread = (overrides: Record<string, unknown>) => ({
  threadId: "thread_1",
  path: "src/users.ts",
  fingerprint: "src/users.ts:5:correctness:no_timeout",
  isResolved: false,
  isOutdated: false,
  body: "🟠 **fetch has no timeout**\n\nA hung upstream blocks forever.",
  reactionSummary: { negativeCount: 0 },
  ...overrides,
});

function harness(alreadySettled: Set<string>) {
  const outcomes: unknown[] = [];
  const dismissals: Array<{ signal: string; title: string }> = [];
  return {
    outcomes,
    dismissals,
    deps: {
      job: { id: "job_1", tenantId: "t", repositoryId: "r" },
      logger: noopLogger,
      memoryService: {
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
      threads: [thread({ reactionSummary: { negativeCount: 1 } })],
    } as never);
    expect(run.dismissals).toEqual([
      { signal: "thumbs_down", title: "fetch has no timeout" },
    ]);
  });
});
