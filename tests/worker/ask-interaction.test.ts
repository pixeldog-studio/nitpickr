import { describe, expect, it } from "vitest";

import { noopLogger } from "../../src/logging/logger.js";
import type { QueueJob } from "../../src/queue/queue-scheduler.js";
import { WorkerRunner } from "../../src/worker/worker-runner.js";

function askJob(): QueueJob {
  return {
    id: "job_ask",
    type: "interaction_requested",
    tenantId: "github-installation:1",
    repositoryId: "github:99",
    changeRequestId: "github:99:42",
    dedupeKey: "github:99:42:ask:5001",
    priority: 80,
    status: "running",
    attempts: 0,
    maxAttempts: 3,
    payload: {
      installationId: "1",
      repository: { owner: "rubenspessoa", name: "nitpickr" },
      pullNumber: 42,
      actorLogin: "ruben",
      command: "ask",
      source: {
        kind: "issue_comment",
        commentId: 5001,
        body: "@nitpickrai why is the retry capped at 3?",
        argumentText: "why is the retry capped at 3?",
      },
    },
    createdAt: new Date("2026-03-09T10:00:00.000Z"),
    scheduledAt: new Date("2026-03-09T10:00:00.000Z"),
    startedAt: new Date("2026-03-09T10:00:01.000Z"),
    completedAt: null,
    workerId: "worker_1",
    lastError: null,
  };
}

describe("ask interactions", () => {
  it("answers with the model and posts the reply", async () => {
    const posted: string[] = [];
    const failed: string[] = [];
    const job = askJob();
    const runner = new WorkerRunner({
      logger: noopLogger,
      queueScheduler: {
        claimNextJobs: async () => [job],
        cancelSupersededReviewJobs: async () => 0,
        completeJob: async () => ({ ...job, status: "completed" }),
        failJob: async (_id: string, error: string) => {
          failed.push(error);
          return { ...job, status: "failed" };
        },
      },
      githubAdapter: {
        async fetchChangeRequestContext() {
          return {
            tenantId: job.tenantId,
            installationId: "1",
            repositoryId: job.repositoryId,
            repository: { owner: "rubenspessoa", name: "nitpickr" },
            changeRequest: {
              id: "github:99:42",
              tenantId: job.tenantId,
              installationId: "1",
              repositoryId: job.repositoryId,
              provider: "github" as const,
              number: 42,
              title: "Retry webhooks",
              baseSha: "a".repeat(40),
              headSha: "b".repeat(40),
              status: "open" as const,
              authorLogin: "ruben",
            },
            files: [],
            comments: [],
          };
        },
        async createIssueComment(input: { body: string }) {
          posted.push(input.body);
        },
      },
      instructionBundleLoader: {
        async loadForReview() {
          return { config: {} as never, documents: [], combinedText: "" };
        },
      },
      memoryService: {
        async getRelevantMemories() {
          return [];
        },
        async ingestDiscussion() {
          return { acknowledgments: [], savedEntries: [] };
        },
      },
      reviewPlanner: { plan: () => ({}) as never },
      reviewLifecycle: {
        startReview: async () => "run",
        completeReview: async () => {},
        failReview: async () => {},
      },
      reviewEngine: { review: async () => ({}) as never },
      publisher: {
        buildInlineComments: () => [],
        publish: async () => ({ reviewId: "r" }),
      },
      conversationResponder: {
        answer: async (context: { question: string }) =>
          `Three attempts keep a webhook burst from piling up (asked: ${context.question})`,
        reconsider: async () => ({
          body: "",
          resolve: false,
          verdict: "uncertain",
        }),
      },
    } as never);

    await runner.runOnce({ workerId: "worker_1", perTenantCap: 1 });

    expect(failed).toEqual([]);
    expect(posted).toEqual([
      "Three attempts keep a webhook burst from piling up (asked: why is the retry capped at 3?)",
    ]);
  });
});
