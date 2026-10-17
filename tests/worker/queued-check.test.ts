import { describe, expect, it } from "vitest";

import { noopLogger } from "../../src/logging/logger.js";
import type { QueueJob } from "../../src/queue/queue-scheduler.js";
import { WorkerRunner } from "../../src/worker/worker-runner.js";

const head = "b".repeat(40);

function job(overrides: Partial<QueueJob["payload"]> = {}): QueueJob {
  return {
    id: "job_q",
    type: "review_requested",
    tenantId: "github-installation:1",
    repositoryId: "github:99",
    changeRequestId: "github:99:42",
    dedupeKey: "k",
    priority: 100,
    status: "running",
    attempts: 0,
    maxAttempts: 3,
    payload: {
      installationId: "1",
      repository: { owner: "o", name: "r" },
      pullNumber: 42,
      mode: "quick",
      headSha: head,
      checkRunId: "queued_1",
      trigger: { type: "pr_synchronized", actorLogin: "ruben" },
      ...overrides,
    },
    createdAt: new Date("2026-03-09T10:00:00.000Z"),
    scheduledAt: new Date("2026-03-09T10:00:00.000Z"),
    startedAt: new Date("2026-03-09T10:00:01.000Z"),
    completedAt: null,
    workerId: "worker_1",
    lastError: null,
  };
}

function runner(
  current: QueueJob,
  input: {
    fetchContext: () => Promise<unknown>;
    latestHeadSha?: string;
    calls: Array<Record<string, unknown>>;
  },
) {
  return new WorkerRunner({
    logger: noopLogger,
    queueScheduler: {
      claimNextJobs: async () => [current],
      cancelSupersededReviewJobs: async () => ({
        canceledCount: 0,
        checkRunIds: [],
      }),
      completeJob: async () => ({ ...current, status: "completed" }),
      failJob: async () => ({ ...current, status: "failed" }),
    },
    githubAdapter: { fetchChangeRequestContext: input.fetchContext },
    instructionBundleLoader: { loadForReview: async () => ({}) },
    memoryService: { getRelevantMemories: async () => [] },
    reviewPlanner: { plan: () => ({}) },
    reviewLifecycle: {
      startReview: async () => "run",
      completeReview: async () => {},
      failReview: async () => {},
      getLatestCompletedReview: async () =>
        input.latestHeadSha ? { headSha: input.latestHeadSha } : null,
    },
    reviewEngine: { review: async () => ({}) },
    publisher: { buildInlineComments: () => [], publish: async () => ({}) },
    statusPublisher: {
      markPending: async () => "x",
      markPublished: async () => {},
      markSkipped: async () => {},
      markFailed: async () => undefined,
      async markClosed(call: Record<string, unknown>) {
        input.calls.push({ type: "closed", ...call });
      },
      async markRequeued(call: Record<string, unknown>) {
        input.calls.push({ type: "requeued", ...call });
      },
    },
  } as never);
}

const context = {
  tenantId: "github-installation:1",
  installationId: "1",
  repositoryId: "github:99",
  repository: { owner: "o", name: "r" },
  changeRequest: {
    id: "github:99:42",
    number: 42,
    title: "t",
    baseSha: "a".repeat(40),
    headSha: head,
    status: "open",
    authorLogin: "ruben",
  },
  files: [],
  comments: [],
};

describe("queued review check", () => {
  it("closes it as already reviewed when a push review is skipped", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await runner(job(), {
      fetchContext: async () => context,
      latestHeadSha: head,
      calls,
    }).runOnce({ workerId: "worker_1", perTenantCap: 1 });
    expect(calls).toEqual([
      expect.objectContaining({
        type: "closed",
        checkRunId: "queued_1",
        conclusion: "neutral",
        title: "Already reviewed",
      }),
    ]);
  });

  it("marks it failed when the job fails for good before the review starts", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await runner(job(), {
      fetchContext: async () => {
        throw new Error("GitHub request failed with status 404: Not Found");
      },
      calls,
    }).runOnce({ workerId: "worker_1", perTenantCap: 1 });
    expect(calls).toEqual([
      expect.objectContaining({
        type: "closed",
        checkRunId: "queued_1",
        conclusion: "failure",
      }),
    ]);
  });

  it("puts it back to queued when the job will retry", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await runner(job(), {
      fetchContext: async () => {
        throw new Error("GitHub request failed with status 502: Bad Gateway");
      },
      calls,
    }).runOnce({ workerId: "worker_1", perTenantCap: 1 });
    expect(calls).toEqual([
      expect.objectContaining({ type: "requeued", checkRunId: "queued_1" }),
    ]);
  });
});
