import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { GitHubWebhookService } from "../../src/api/github-webhook-service.js";
import { createApiServer } from "../../src/api/server.js";
import {
  WebhookEventService,
  type WebhookEventStore,
} from "../../src/api/webhook-event-service.js";
import { defaultRepositoryConfig } from "../../src/config/repository-config-loader.js";
import {
  type MemoryEntry,
  MemoryService,
  type MemoryStore,
} from "../../src/memory/memory-service.js";
import {
  GitHubAdapter,
  type GitHubApiClient,
  type GitHubChangeRequestContext,
} from "../../src/providers/github/github-adapter.js";
import {
  type PublishReviewClient,
  ReviewPublisher,
} from "../../src/publisher/review-publisher.js";
import type {
  JobStore,
  QueueJob,
  QueueJobInput,
} from "../../src/queue/queue-scheduler.js";
import { QueueScheduler } from "../../src/queue/queue-scheduler.js";
import {
  ReviewEngine,
  type ReviewModel,
} from "../../src/review/review-engine.js";
import {
  type PersistedDiscussionEvent,
  type PersistedPublishedComment,
  type PersistedReviewFinding,
  type PersistedReviewRun,
  ReviewLifecycleService,
  type ReviewLifecycleStore,
} from "../../src/review/review-lifecycle-service.js";
import { ReviewPlanner } from "../../src/review/review-planner.js";
import { WorkerRunner } from "../../src/worker/worker-runner.js";

class InMemoryJobStore implements JobStore {
  readonly jobs = new Map<string, QueueJob>();

  async getJob(jobId: string): Promise<QueueJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async findActiveByDedupeKey(dedupeKey: string): Promise<QueueJob | null> {
    for (const job of this.jobs.values()) {
      if (
        job.dedupeKey === dedupeKey &&
        (job.status === "queued" || job.status === "running")
      ) {
        return job;
      }
    }

    return null;
  }

  async createJob(input: QueueJobInput): Promise<QueueJob> {
    const job: QueueJob = {
      ...input,
      startedAt: null,
      completedAt: null,
      workerId: null,
      lastError: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async listQueuedJobs(limit: number, dueBy: Date): Promise<QueueJob[]> {
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.status === "queued" &&
          job.scheduledAt.getTime() <= dueBy.getTime(),
      )
      .sort((left, right) => {
        if (left.priority !== right.priority) {
          return right.priority - left.priority;
        }

        return left.createdAt.getTime() - right.createdAt.getTime();
      })
      .slice(0, limit);
  }

  async listRunningJobs(): Promise<QueueJob[]> {
    return [...this.jobs.values()].filter((job) => job.status === "running");
  }

  async markJobsRunning(
    jobIds: string[],
    workerId: string,
    startedAt: Date,
  ): Promise<QueueJob[]> {
    const jobs: QueueJob[] = [];
    for (const jobId of jobIds) {
      const current = this.jobs.get(jobId);
      if (current?.status !== "queued") {
        continue;
      }

      const updated: QueueJob = {
        ...current,
        status: "running",
        workerId,
        startedAt,
      };
      this.jobs.set(jobId, updated);
      jobs.push(updated);
    }

    return jobs;
  }

  async updateJob(jobId: string, patch: Partial<QueueJob>): Promise<QueueJob> {
    const current = this.jobs.get(jobId);
    if (!current) {
      throw new Error(`Unknown job ${jobId}`);
    }

    const updated: QueueJob = {
      ...current,
      ...patch,
    };
    this.jobs.set(jobId, updated);
    return updated;
  }

  async cancelSupersededReviewJobs(input: {
    repositoryId: string;
    changeRequestId: string;
    headSha: string;
  }): Promise<{ canceledCount: number; checkRunIds: string[] }> {
    let canceled = 0;

    for (const [jobId, job] of this.jobs.entries()) {
      if (
        job.type === "review_requested" &&
        job.status === "queued" &&
        job.repositoryId === input.repositoryId &&
        job.changeRequestId === input.changeRequestId &&
        (job.payload.headSha ?? "") !== input.headSha
      ) {
        this.jobs.set(jobId, {
          ...job,
          status: "canceled",
          completedAt: new Date("2026-03-09T10:00:00.000Z"),
        });
        canceled += 1;
      }
    }

    return { canceledCount: canceled, checkRunIds: [] };
  }

  async setJobCheckRun(): Promise<boolean> {
    return true;
  }

  async requeueWorkerJobs(): Promise<number> {
    return 0;
  }

  async cancelQueuedReviewJobs(): Promise<{
    canceledCount: number;
    checkRunIds: string[];
  }> {
    return { canceledCount: 0, checkRunIds: [] };
  }

  async requeueStaleRunningJobs(): Promise<number> {
    return 0;
  }
}

class InMemoryMemoryStore implements MemoryStore {
  readonly entries: MemoryEntry[] = [];

  async save(entries: MemoryEntry[]): Promise<void> {
    this.entries.push(...entries);
  }

  async listByRepository(input: {
    tenantId: string;
    repositoryId: string;
  }): Promise<MemoryEntry[]> {
    return this.entries.filter(
      (entry) =>
        entry.tenantId === input.tenantId &&
        entry.repositoryId === input.repositoryId,
    );
  }
}

class InMemoryWebhookEventStore implements WebhookEventStore {
  readonly events = new Map<
    string,
    {
      deliveryId: string;
      provider: "github";
      eventName: string;
      status: "received" | "ignored" | "queued" | "processed" | "failed";
    }
  >();

  async getByDeliveryId(deliveryId: string) {
    return this.events.get(deliveryId) ?? null;
  }

  async createEvent(input: {
    deliveryId: string;
    provider: "github";
    eventName: string;
    status: "received" | "ignored" | "queued" | "processed" | "failed";
    payload: unknown;
  }): Promise<void> {
    this.events.set(input.deliveryId, {
      deliveryId: input.deliveryId,
      provider: input.provider,
      eventName: input.eventName,
      status: input.status,
    });
  }

  async updateEvent(input: {
    deliveryId: string;
    status: "received" | "ignored" | "queued" | "processed" | "failed";
  }): Promise<void> {
    const current = this.events.get(input.deliveryId);
    if (!current) {
      throw new Error(`Unknown delivery ${input.deliveryId}`);
    }

    this.events.set(input.deliveryId, {
      ...current,
      status: input.status,
    });
  }
}

class InMemoryReviewLifecycleStore implements ReviewLifecycleStore {
  readonly changeRequests = new Map<
    string,
    GitHubChangeRequestContext["changeRequest"]
  >();
  readonly reviewRuns = new Map<string, PersistedReviewRun>();
  readonly findings: PersistedReviewFinding[] = [];
  readonly comments: PersistedPublishedComment[] = [];
  readonly discussionEvents: PersistedDiscussionEvent[] = [];
  readonly resolvedThreadBatches: string[][] = [];

  async upsertChangeRequest(
    changeRequest: GitHubChangeRequestContext["changeRequest"],
  ): Promise<void> {
    this.changeRequests.set(changeRequest.id, changeRequest);
  }

  async createReviewRun(reviewRun: PersistedReviewRun): Promise<void> {
    this.reviewRuns.set(reviewRun.id, reviewRun);
  }

  async findLatestCompletedReviewRun(
    changeRequestId: string,
  ): Promise<PersistedReviewRun | null> {
    return (
      [...this.reviewRuns.values()]
        .filter(
          (reviewRun) =>
            reviewRun.changeRequestId === changeRequestId &&
            (reviewRun.status === "published" ||
              reviewRun.status === "skipped"),
        )
        .sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        )[0] ?? null
    );
  }

  async countCompletedReviewRuns(changeRequestId: string): Promise<number> {
    return [...this.reviewRuns.values()].filter(
      (reviewRun) =>
        reviewRun.changeRequestId === changeRequestId &&
        (reviewRun.status === "published" || reviewRun.status === "skipped"),
    ).length;
  }

  async markPublishedCommentsResolved(input: {
    providerThreadIds: string[];
    resolvedAt: string;
  }): Promise<number> {
    this.resolvedThreadBatches.push(input.providerThreadIds);
    let resolvedCount = 0;

    this.comments.forEach((comment, index) => {
      if (
        comment.providerThreadId !== null &&
        input.providerThreadIds.includes(comment.providerThreadId) &&
        comment.resolvedAt === null
      ) {
        this.comments[index] = {
          ...comment,
          resolvedAt: input.resolvedAt,
        };
        resolvedCount += 1;
      }
    });

    return resolvedCount;
  }

  async supersedePreviousRuns(): Promise<number> {
    return 0;
  }

  async completeReviewRun(input: {
    reviewRunId: string;
    status: "published" | "skipped";
    publishedReviewId: string;
    summary: string;
    mermaid: string;
    findings: PersistedReviewFinding[];
    publishedComments: PersistedPublishedComment[];
    completedAt: string;
  }): Promise<void> {
    const current = this.reviewRuns.get(input.reviewRunId);
    if (!current) {
      throw new Error(`Unknown review run ${input.reviewRunId}`);
    }

    this.reviewRuns.set(input.reviewRunId, {
      ...current,
      status: input.status,
      updatedAt: input.completedAt,
      completedAt: input.completedAt,
    });
    this.findings.push(...input.findings);
    this.comments.push(...input.publishedComments);
  }

  async failReviewRun(input: {
    reviewRunId: string;
    errorMessage: string;
    completedAt: string;
  }): Promise<void> {
    const current = this.reviewRuns.get(input.reviewRunId);
    if (!current) {
      throw new Error(`Unknown review run ${input.reviewRunId}`);
    }

    this.reviewRuns.set(input.reviewRunId, {
      ...current,
      status: "failed",
      updatedAt: input.completedAt,
      completedAt: input.completedAt,
    });
  }

  async saveDiscussionEvents(
    events: PersistedDiscussionEvent[],
  ): Promise<void> {
    this.discussionEvents.push(...events);
  }
}

class FakeGitHubApi implements GitHubApiClient {
  readonly reactions: Array<{
    installationId: string;
    owner: string;
    repo: string;
    commentId: number;
    content: "eyes";
  }> = [];
  pullRequestTitle = "Improve queue fairness";
  files: Array<{
    filename: string;
    status: "added" | "modified" | "removed" | "renamed";
    additions: number;
    deletions: number;
    patch?: string;
    previous_filename?: string;
  }> = [];
  issueComments: Array<{
    id: number;
    body: string;
    user: {
      login: string;
    };
    created_at: string;
  }> = [];
  reviewComments: Array<{
    id: number;
    body: string;
    user: {
      login: string;
    };
    path?: string;
    line?: number;
    created_at: string;
  }> = [];
  comparedFiles: Array<{
    filename: string;
    status: "added" | "modified" | "removed" | "renamed";
    additions: number;
    deletions: number;
    patch?: string;
    previous_filename?: string;
  }> = [];
  nitpickrThreads: Array<{
    threadId: string;
    providerCommentId: string;
    path: string;
    line: number;
    fingerprint: string;
    isResolved: boolean;
    body: string;
    reactionSummary: {
      positiveCount: number;
      negativeCount: number;
    };
  }> = [];
  resolvedThreadIds: string[] = [];

  async getPullRequest() {
    return {
      id: 101,
      number: 42,
      title: this.pullRequestTitle,
      state: "open" as const,
      draft: false,
      user: {
        login: "ruben",
      },
      base: {
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ref: "main",
      },
      head: {
        sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ref: "feature",
      },
    };
  }

  async listPullRequestFiles() {
    return this.files;
  }

  async listIssueComments() {
    return this.issueComments;
  }

  async listReviewComments() {
    return this.reviewComments;
  }

  async comparePullRequestRange() {
    return this.comparedFiles.length > 0 ? this.comparedFiles : this.files;
  }

  async getFileContent(): Promise<string | null> {
    return null;
  }

  async listNitpickrReviewThreads() {
    return this.nitpickrThreads;
  }

  async resolveReviewThread(input: {
    installationId: string;
    threadId: string;
  }) {
    this.resolvedThreadIds.push(input.threadId);
    this.nitpickrThreads = this.nitpickrThreads.map((thread) =>
      thread.threadId === input.threadId
        ? {
            ...thread,
            isResolved: true,
          }
        : thread,
    );
  }

  async createIssueCommentReaction(input: {
    installationId: string;
    owner: string;
    repo: string;
    commentId: number;
    content: "eyes";
  }) {
    this.reactions.push(input);
  }

  async createIssueComment() {}

  async replyToReviewComment() {}
}

class CapturingReviewModel implements ReviewModel {
  readonly prompts: Array<{ system: string; user: string }> = [];
  nextResponse: unknown = {
    summary: "nitpickr found one issue.",
    mermaid: "flowchart TD\nA[Webhook] --> B[Review]",
    findings: [
      {
        path: "src/api/server.ts",
        line: 13,
        findingType: "bug",
        severity: "medium",
        category: "maintainability",
        title: "Clarify request parsing",
        body: "Explicitly guard JSON parsing failures in the webhook entrypoint.",
        fixPrompt:
          "Add a try/catch around request body parsing and return a 400 on invalid JSON.",
      },
    ],
  };

  async generateStructuredReview(input: {
    system: string;
    user: string;
  }): Promise<unknown> {
    this.prompts.push(input);
    return this.nextResponse;
  }
}

class CapturingPublishClient implements PublishReviewClient {
  async listPullRequestReviews(): Promise<
    Array<{
      reviewId: string;
      body: string;
    }>
  > {
    return [];
  }

  readonly reviews: Array<{
    installationId: string;
    repository: {
      owner: string;
      name: string;
    };
    pullNumber: number;
    body: string;
    comments: Array<{
      path: string;
      line: number;
      side: "RIGHT";
      body: string;
    }>;
  }> = [];

  async publishPullRequestReview(input: {
    installationId: string;
    repository: {
      owner: string;
      name: string;
    };
    pullNumber: number;
    body: string;
    comments: Array<{
      path: string;
      line: number;
      side: "RIGHT";
      body: string;
    }>;
  }): Promise<{ reviewId: string }> {
    this.reviews.push(input);
    return {
      reviewId: `review_${this.reviews.length}`,
    };
  }
}

function createSignature(secret: string, body: string): string {
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${digest}`;
}

function createHarness() {
  const jobStore = new InMemoryJobStore();
  const queueScheduler = new QueueScheduler(jobStore, {
    now: () => new Date("2026-03-09T10:00:00.000Z"),
    createId: (() => {
      let sequence = 0;
      return () => `job_${++sequence}`;
    })(),
  });
  const githubApi = new FakeGitHubApi();
  const githubAdapter = new GitHubAdapter({
    apiClient: githubApi,
    appConfig: {
      appId: 123456,
      privateKey: "test-private-key",
      webhookSecret: "webhook-secret",
      webhookUrl: "https://nitpickr.example.com/webhooks/github",
    },
  });
  const webhookEventStore = new InMemoryWebhookEventStore();
  const webhookEventService = new WebhookEventService(webhookEventStore);
  const webhookService = new GitHubWebhookService(
    githubAdapter,
    queueScheduler,
    webhookEventService,
    undefined,
  );
  const server = createApiServer({
    githubWebhookService: webhookService,
  });
  const memoryStore = new InMemoryMemoryStore();
  const memoryService = new MemoryService(memoryStore);
  const reviewLifecycleStore = new InMemoryReviewLifecycleStore();
  const reviewLifecycle = new ReviewLifecycleService(reviewLifecycleStore, {
    now: () => new Date("2026-03-09T10:05:00.000Z"),
    createId: (() => {
      let sequence = 0;
      return () => `entity_${++sequence}`;
    })(),
  });
  const reviewModel = new CapturingReviewModel();
  const reviewEngine = new ReviewEngine(reviewModel, {
    requireEvidence: false,
    maxPatchCharactersPerChunk: 2000,
  });
  const publishClient = new CapturingPublishClient();
  const publisher = new ReviewPublisher(publishClient);
  const reviewPlanner = new ReviewPlanner();
  const instructionBundleLoader = {
    async loadForReview() {
      return {
        config: {
          ...defaultRepositoryConfig,
          source: null,
        },
        documents: [],
        combinedText: "Focus on API correctness and webhook safety.",
      };
    },
  };
  const worker = new WorkerRunner({
    queueScheduler,
    githubAdapter,
    instructionBundleLoader,
    memoryService,
    reviewPlanner,
    reviewLifecycle,
    reviewEngine,
    publisher,
  });

  return {
    server,
    jobStore,
    githubApi,
    memoryStore,
    reviewLifecycleStore,
    reviewModel,
    publishClient,
    worker,
  };
}

const servers: Array<ReturnType<typeof createApiServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("review flow integration", () => {
  it("processes a pull_request webhook through the real review pipeline", async () => {
    const harness = createHarness();
    servers.push(harness.server);

    harness.githubApi.files = [
      {
        filename: "src/api/server.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: [
          "@@ -10,2 +10,3 @@",
          " context",
          "-old",
          "+new alpha",
          "+new beta",
        ].join("\n"),
      },
    ];
    harness.githubApi.issueComments = [
      {
        id: 10,
        body: "Prefer explicit error handling around JSON parsing.",
        user: {
          login: "maintainer",
        },
        created_at: "2026-03-09T09:58:00.000Z",
      },
    ];
    harness.memoryStore.entries.push({
      id: "memory_1",
      tenantId: "github-installation:123456",
      repositoryId: "github:99",
      kind: "preferred_pattern",
      summary: "Prefer explicit webhook error handling.",
      path: "src/api",
      tags: [],
      globs: [],
      confidence: 0.9,
      usageCount: 0,
      lastUsedAt: null,
      embedding: null,
      supersededBy: null,
      source: "discussion",
      createdAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-03-01T10:00:00.000Z",
    });

    const payload = JSON.stringify({
      action: "opened",
      installation: {
        id: 123456,
      },
      repository: {
        id: 99,
        name: "nitpickr",
        owner: {
          login: "example-owner",
        },
        default_branch: "main",
      },
      pull_request: {
        id: 101,
        number: 42,
        title: "Improve queue fairness",
        state: "open",
        draft: false,
        user: {
          login: "ruben",
        },
        base: {
          sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ref: "main",
        },
        head: {
          sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          ref: "feature",
        },
      },
    });

    const response = await harness.server.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": createSignature("webhook-secret", payload),
      },
    });

    expect(response.statusCode).toBe(202);

    const processed = await harness.worker.runOnce({
      workerId: "worker_1",
      perTenantCap: 1,
    });

    expect(processed).toBe(true);
    expect(harness.publishClient.reviews).toHaveLength(1);
    expect(harness.publishClient.reviews[0]?.comments).toEqual([
      {
        path: "src/api/server.ts",
        line: 12,
        side: "RIGHT",
        body: expect.stringContaining("Clarify request parsing"),
      },
    ]);
    expect(harness.publishClient.reviews[0]?.body).toContain(
      "nitpickr found one issue.",
    );
    expect(harness.reviewModel.prompts[0]?.user).toContain(
      "Prefer explicit webhook error handling.",
    );

    const reviewRun = [...harness.reviewLifecycleStore.reviewRuns.values()][0];
    expect(reviewRun?.status).toBe("published");
    expect(harness.reviewLifecycleStore.findings).toHaveLength(1);
    expect(harness.reviewLifecycleStore.comments).toHaveLength(1);
    expect(harness.reviewLifecycleStore.discussionEvents).toHaveLength(1);
  });

  it("processes a manual @nitpickr summary command end to end", async () => {
    const harness = createHarness();
    servers.push(harness.server);

    harness.githubApi.files = [
      {
        filename: "src/api/server.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: ["@@ -5,1 +5,1 @@", "+summary only"].join("\n"),
      },
    ];
    harness.reviewModel.nextResponse = {
      summary: "Summary mode review completed.",
      mermaid: "flowchart TD\nA[Command] --> B[Summary]",
      findings: [
        {
          path: "src/api/server.ts",
          line: 5,
          severity: "low",
          category: "style",
          title: "Would normally comment inline",
          body: "This should be suppressed in summary mode.",
          fixPrompt: "Do not emit inline comments for summary mode.",
        },
      ],
    };

    const payload = JSON.stringify({
      action: "created",
      installation: {
        id: 123456,
      },
      repository: {
        id: 99,
        name: "nitpickr",
        owner: {
          login: "example-owner",
        },
        default_branch: "main",
      },
      issue: {
        number: 42,
        pull_request: {
          url: "https://api.github.com/repos/example-owner/nitpickr/pulls/42",
        },
      },
      comment: {
        id: 9001,
        body: "@nitpickr summary",
        user: {
          login: "ruben",
        },
      },
    });

    const response = await harness.server.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-2",
        "x-github-event": "issue_comment",
        "x-hub-signature-256": createSignature("webhook-secret", payload),
      },
    });

    expect(response.statusCode).toBe(202);

    const processed = await harness.worker.runOnce({
      workerId: "worker_1",
      perTenantCap: 1,
    });

    expect(processed).toBe(true);
    expect(harness.publishClient.reviews).toHaveLength(1);
    expect(harness.githubApi.reactions).toEqual([
      {
        installationId: "123456",
        owner: "example-owner",
        repo: "nitpickr",
        commentId: 9001,
        content: "eyes",
      },
    ]);
    expect(harness.publishClient.reviews[0]?.comments).toEqual([]);
    expect(harness.publishClient.reviews[0]?.body).toContain(
      "Summary mode review completed.",
    );

    const reviewRun = [...harness.reviewLifecycleStore.reviewRuns.values()][0];
    expect(reviewRun?.mode).toBe("summary");
    expect(reviewRun?.trigger).toEqual({
      type: "manual_command",
      command: "summary",
      actorLogin: "ruben",
    });
  });

  it("processes synchronize events as commit-delta reviews and resolves threads the model marks fixed", async () => {
    const harness = createHarness();
    servers.push(harness.server);

    harness.githubApi.files = [
      {
        filename: "src/api/server.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: ["@@ -10,2 +10,3 @@", " context", "-old", "+new alpha"].join(
          "\n",
        ),
      },
      {
        filename: "src/queue/queue-scheduler.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
        patch: ["@@ -20,1 +20,2 @@", "-old queue", "+new queue"].join("\n"),
      },
    ];
    harness.githubApi.comparedFiles = [
      {
        filename: "src/api/server.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: ["@@ -10,2 +10,3 @@", " context", "-old", "+new alpha"].join(
          "\n",
        ),
      },
    ];
    harness.githubApi.nitpickrThreads = [
      {
        threadId: "thread_old",
        providerCommentId: "comment_old",
        path: "src/api/server.ts",
        line: 12,
        fingerprint:
          "src/api/server.ts:12:maintainability:clarify_request_parsing",
        isResolved: false,
        body: [
          "🛠️ **Clarify request parsing**",
          "**Where:** `src/api/server.ts:12`",
          "",
          "Clarify the guard path before queueing work.",
          "",
          "<!-- nitpickr:fingerprint:src/api/server.ts:12:maintainability:clarify_request_parsing -->",
        ].join("\n"),
        reactionSummary: {
          positiveCount: 0,
          negativeCount: 0,
        },
      },
    ];
    harness.reviewLifecycleStore.reviewRuns.set("review_run_previous", {
      id: "review_run_previous",
      tenantId: "github-installation:123456",
      repositoryId: "github:99",
      changeRequestId: "github:example-owner/nitpickr#42",
      trigger: {
        type: "pr_opened",
        actorLogin: "ruben",
      },
      mode: "quick",
      scope: "full_pr",
      headSha: "cccccccccccccccccccccccccccccccccccccccc",
      comparedFromSha: null,
      status: "published",
      budgets: {
        maxFiles: 50,
        maxHunks: 200,
        maxTokens: 120000,
        maxComments: 20,
        maxDurationMs: 300000,
      },
      createdAt: "2026-03-09T09:50:00.000Z",
      updatedAt: "2026-03-09T09:51:00.000Z",
      completedAt: "2026-03-09T09:51:00.000Z",
    });
    harness.reviewLifecycleStore.comments.push({
      id: "comment_persisted_1",
      reviewRunId: "review_run_previous",
      publishedReviewId: "review_1",
      path: "src/api/server.ts",
      line: 12,
      body: "Old nitpickr comment",
      providerThreadId: "thread_old",
      providerCommentId: "comment_old",
      fingerprint:
        "src/api/server.ts:12:maintainability:clarify_request_parsing",
      resolvedAt: null,
      createdAt: "2026-03-09T09:51:00.000Z",
    });
    harness.reviewModel.nextResponse = {
      summary: "This push hardens webhook request parsing.",
      mermaid: "flowchart TD\nA[Sync] --> B[Review]",
      findings: [
        {
          path: "src/api/server.ts",
          line: 13,
          findingType: "bug",
          severity: "high",
          category: "correctness",
          title: "Guard malformed JSON",
          body: "Malformed payloads can bubble through the webhook path.",
          fixPrompt:
            "In `src/api/server.ts` around line 13, guard malformed JSON before processing the webhook.",
        },
      ],
      priorThreadVerdicts: [{ threadId: "T1", verdict: "fixed" }],
    };

    const payload = JSON.stringify({
      action: "synchronize",
      installation: {
        id: 123456,
      },
      repository: {
        id: 99,
        name: "nitpickr",
        owner: {
          login: "example-owner",
        },
        default_branch: "main",
      },
      pull_request: {
        id: 101,
        number: 42,
        title: "Improve queue fairness",
        state: "open",
        draft: false,
        user: {
          login: "ruben",
        },
        base: {
          sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ref: "main",
        },
        head: {
          sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          ref: "feature",
        },
      },
    });

    const response = await harness.server.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-3",
        "x-github-event": "pull_request",
        "x-hub-signature-256": createSignature("webhook-secret", payload),
      },
    });

    expect(response.statusCode).toBe(202);

    const processed = await harness.worker.runOnce({
      workerId: "worker_1",
      perTenantCap: 1,
    });

    expect(processed).toBe(true);
    expect(harness.publishClient.reviews).toHaveLength(1);
    expect(harness.publishClient.reviews[0]?.body).toContain(
      "**nitpickr** · `",
    );
    expect(harness.publishClient.reviews[0]?.body).toContain("new finding");
    expect(harness.publishClient.reviews[0]?.body).not.toContain(
      "# nitpickr review ✨",
    );
    expect(harness.publishClient.reviews[0]?.comments).toEqual([
      {
        path: "src/api/server.ts",
        line: 11,
        side: "RIGHT",
        body: expect.stringContaining("Guard malformed JSON"),
      },
    ]);
    expect(harness.reviewModel.prompts[0]?.user).toContain(
      "Current PR context:",
    );
    expect(harness.reviewModel.prompts[0]?.user).toContain(
      "src/queue/queue-scheduler.ts (+3/-1)",
    );

    const reviewRun = [
      ...harness.reviewLifecycleStore.reviewRuns.values(),
    ].find((candidate) => candidate.id !== "review_run_previous");
    expect(reviewRun).toMatchObject({
      scope: "commit_delta",
      comparedFromSha: "cccccccccccccccccccccccccccccccccccccccc",
    });
    expect(harness.githubApi.resolvedThreadIds).toEqual(["thread_old"]);
    expect(harness.reviewLifecycleStore.resolvedThreadBatches).toEqual([
      ["thread_old"],
    ]);
    expect(
      harness.reviewLifecycleStore.comments.find(
        (comment) => comment.providerThreadId === "thread_old",
      )?.resolvedAt,
    ).toBe("2026-03-09T10:05:00.000Z");
  });
});
