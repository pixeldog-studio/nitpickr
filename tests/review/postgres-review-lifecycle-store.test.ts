import { describe, expect, it } from "vitest";

import { PostgresReviewLifecycleStore } from "../../src/review/postgres-review-lifecycle-store.js";

class FakePostgresClient {
  readonly calls: Array<{
    query: string;
    params: readonly unknown[] | undefined;
  }> = [];

  async unsafe<T extends Record<string, unknown>>(
    query: string,
    params?: readonly unknown[],
  ): Promise<T[]> {
    this.calls.push({ query, params });
    return [];
  }
}

describe("PostgresReviewLifecycleStore", () => {
  it("upserts change requests", async () => {
    const client = new FakePostgresClient();
    const store = new PostgresReviewLifecycleStore(client);

    await store.upsertChangeRequest({
      id: "github:99:42",
      tenantId: "github-installation:123456",
      installationId: "123456",
      repositoryId: "github:99",
      provider: "github",
      number: 42,
      title: "Improve queue fairness",
      baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      status: "open",
      authorLogin: "ruben",
    });

    expect(client.calls[0]?.query).toContain("insert into change_requests");
  });

  it("creates review runs", async () => {
    const client = new FakePostgresClient();
    const store = new PostgresReviewLifecycleStore(client);

    await store.createReviewRun({
      id: "review_run_1",
      tenantId: "github-installation:123456",
      repositoryId: "github:99",
      changeRequestId: "github:99:42",
      trigger: {
        type: "pr_opened",
        actorLogin: "ruben",
      },
      mode: "quick",
      scope: "full_pr",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      comparedFromSha: null,
      status: "running",
      budgets: {
        maxFiles: 50,
        maxHunks: 200,
        maxTokens: 120000,
        maxComments: 20,
        maxDurationMs: 300000,
      },
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      completedAt: null,
    });

    expect(client.calls[0]?.query).toContain("insert into review_runs");
  });

  it("completes review runs and stores findings and comments", async () => {
    const client = new FakePostgresClient();
    const store = new PostgresReviewLifecycleStore(client);

    await store.completeReviewRun({
      reviewRunId: "review_run_1",
      status: "published",
      publishedReviewId: "github_review_1",
      summary: "Queue fairness improved.",
      mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
      completedAt: "2026-03-09T10:05:00.000Z",
      findings: [
        {
          id: "finding_1",
          reviewRunId: "review_run_1",
          repositoryId: "github:99",
          path: "src/queue/queue-scheduler.ts",
          line: 24,
          findingType: "safe_suggestion",
          severity: "medium",
          category: "performance",
          title: "Avoid rescanning running jobs",
          body: "The scheduler recomputes tenant load on every pass.",
          fixPrompt: "Use a cached tenant count map during claim selection.",
          suggestedChange:
            "const tenantCounts = buildTenantCountMap(runningJobs);",
          createdAt: "2026-03-09T10:05:00.000Z",
        },
      ],
      publishedComments: [
        {
          id: "comment_1",
          reviewRunId: "review_run_1",
          publishedReviewId: "github_review_1",
          path: "src/queue/queue-scheduler.ts",
          line: 24,
          body: "**Avoid rescanning running jobs**",
          providerThreadId: "thread_1",
          providerCommentId: "comment_1",
          fingerprint: "fp_1",
          resolvedAt: null,
          createdAt: "2026-03-09T10:05:00.000Z",
        },
      ],
    });

    expect(client.calls[0]?.query).toContain("update review_runs");
    expect(client.calls[1]?.query).toContain("insert into review_findings");
    expect(client.calls[1]?.query).toContain("suggested_change");
    expect(client.calls[1]?.query).toContain("finding_type");
    expect(client.calls[2]?.query).toContain("insert into published_comments");
    expect(client.calls[2]?.query).toContain("provider_thread_id");
    expect(client.calls[2]?.query).toContain("provider_comment_id");
    expect(client.calls[2]?.query).toContain("fingerprint");
  });

  it("supersedes previous review runs for the same change request", async () => {
    const client = new FakePostgresClient();
    const store = new PostgresReviewLifecycleStore(client);

    const superseded = await store.supersedePreviousRuns({
      changeRequestId: "github:99:42",
      reviewRunId: "review_run_2",
      completedAt: "2026-03-09T10:06:00.000Z",
    });

    expect(superseded).toBe(0);
    expect(client.calls[0]?.query).toContain("update review_runs");
    expect(client.calls[0]?.query).toContain("status = 'superseded'");
  });

  it("marks review runs as failed", async () => {
    const client = new FakePostgresClient();
    const store = new PostgresReviewLifecycleStore(client);

    await store.failReviewRun({
      reviewRunId: "review_run_1",
      errorMessage: "boom",
      completedAt: "2026-03-09T10:06:00.000Z",
    });

    expect(client.calls[0]?.query).toContain("update review_runs");
    expect(client.calls[0]?.params).toContain("failed");
  });

  it("loads the latest completed review run for a change request", async () => {
    const client = new FakePostgresClient();
    client.unsafe = async <T extends Record<string, unknown>>(
      query: string,
      params?: readonly unknown[],
    ): Promise<T[]> => {
      client.calls.push({ query, params });
      return [
        {
          id: "review_run_0",
          tenant_id: "github-installation:123456",
          repository_id: "github:99",
          change_request_id: "github:99:42",
          trigger: JSON.stringify({
            type: "pr_opened",
            actorLogin: "ruben",
          }),
          mode: "quick",
          scope: "full_pr",
          head_sha: "cccccccccccccccccccccccccccccccccccccccc",
          compared_from_sha: null,
          status: "published",
          budgets: JSON.stringify({
            maxFiles: 50,
            maxHunks: 200,
            maxTokens: 120000,
            maxComments: 20,
            maxDurationMs: 300000,
          }),
          created_at: "2026-03-09T09:50:00.000Z",
          updated_at: "2026-03-09T09:51:00.000Z",
          completed_at: "2026-03-09T09:51:00.000Z",
        } as unknown as T,
      ];
    };
    const store = new PostgresReviewLifecycleStore(client);

    const run = await store.findLatestCompletedReviewRun("github:99:42");

    expect(run).toMatchObject({
      id: "review_run_0",
      scope: "full_pr",
      headSha: "cccccccccccccccccccccccccccccccccccccccc",
      comparedFromSha: null,
    });
    expect(client.calls[0]?.query).toContain("from review_runs");
    // A failed run must not count as reviewed.
    expect(client.calls[0]?.query).toContain(
      "status in ('published', 'skipped')",
    );
    expect(client.calls[0]?.query).toContain("completed_at desc");
  });

  it("counts only published/skipped review runs for a change request", async () => {
    const client = new FakePostgresClient();
    client.unsafe = async <T extends Record<string, unknown>>(
      query: string,
      params?: readonly unknown[],
    ): Promise<T[]> => {
      client.calls.push({ query, params });
      // Postgres bigint comes back as a string over the wire.
      return [{ count: "2" } as unknown as T];
    };
    const store = new PostgresReviewLifecycleStore(client);

    const count = await store.countCompletedReviewRuns("github:99:42");

    expect(count).toBe(2);
    expect(client.calls[0]?.query).toContain("select count(*)");
    expect(client.calls[0]?.query).toContain(
      "status in ('published', 'skipped')",
    );
    expect(client.calls[0]?.params).toEqual(["github:99:42"]);
  });

  it("returns 0 when the count query returns nothing", async () => {
    const client = new FakePostgresClient();
    const store = new PostgresReviewLifecycleStore(client);

    const count = await store.countCompletedReviewRuns("github:99:42");
    expect(count).toBe(0);
  });

  it("accepts numeric counts (driver-decoded bigint)", async () => {
    const client = new FakePostgresClient();
    client.unsafe = async <T extends Record<string, unknown>>(
      query: string,
      params?: readonly unknown[],
    ): Promise<T[]> => {
      client.calls.push({ query, params });
      return [{ count: 5 } as unknown as T];
    };
    const store = new PostgresReviewLifecycleStore(client);

    expect(await store.countCompletedReviewRuns("github:99:42")).toBe(5);
  });

  it("marks published comments resolved by provider thread id", async () => {
    const client = new FakePostgresClient();
    client.unsafe = async <T extends Record<string, unknown>>(
      query: string,
      params?: readonly unknown[],
    ): Promise<T[]> => {
      client.calls.push({ query, params });
      return [{ resolved_count: 2 } as unknown as T];
    };
    const store = new PostgresReviewLifecycleStore(client);

    const count = await store.markPublishedCommentsResolved({
      providerThreadIds: ["thread_1", "thread_2"],
      resolvedAt: "2026-03-09T10:10:00.000Z",
    });

    expect(count).toBe(2);
    expect(client.calls[0]?.query).toContain("update published_comments");
    expect(client.calls[0]?.params).toEqual([
      ["thread_1", "thread_2"],
      "2026-03-09T10:10:00.000Z",
    ]);
  });

  it("saves discussion events", async () => {
    const client = new FakePostgresClient();
    const store = new PostgresReviewLifecycleStore(client);

    await store.saveDiscussionEvents([
      {
        id: "discussion_1",
        tenantId: "github-installation:123456",
        repositoryId: "github:99",
        changeRequestId: "github:99:42",
        authorLogin: "maintainer",
        body: "Please keep stable ordering here.",
        path: "src/queue/queue-scheduler.ts",
        line: 12,
        source: "review_snapshot",
        providerCreatedAt: "2026-03-09T09:59:00.000Z",
        createdAt: "2026-03-09T10:00:00.000Z",
      },
    ]);

    expect(client.calls[0]?.query).toContain("insert into discussion_events");
  });
});
