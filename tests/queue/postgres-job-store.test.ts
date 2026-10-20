import { describe, expect, it } from "vitest";

import {
  type PostgresClient,
  PostgresJobStore,
} from "../../src/queue/postgres-job-store.js";

interface QueryCall {
  query: string;
  params: readonly unknown[] | undefined;
}

class FakePostgresClient implements PostgresClient {
  readonly calls: QueryCall[] = [];
  readonly responses: unknown[][] = [];

  queueResponse(rows: unknown[]): void {
    this.responses.push(rows);
  }

  async unsafe<T extends Record<string, unknown>>(
    query: string,
    params?: readonly unknown[],
  ): Promise<T[]> {
    this.calls.push({ query, params });
    return (this.responses.shift() ?? []) as T[];
  }
}

function buildRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "job_1",
    type: "review_requested",
    tenant_id: "tenant_1",
    repository_id: "repo_1",
    change_request_id: "cr_1",
    dedupe_key: "repo_1:cr_1:review",
    priority: 100,
    status: "queued",
    attempts: 0,
    max_attempts: 3,
    payload: {
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      trigger: "manual_command",
      mode: "quick",
    },
    created_at: new Date("2026-03-09T10:00:00.000Z"),
    scheduled_at: new Date("2026-03-09T10:00:00.000Z"),
    started_at: null,
    completed_at: null,
    worker_id: null,
    last_error: null,
    ...overrides,
  };
}

describe("PostgresJobStore", () => {
  it("gets a job by identifier", async () => {
    const client = new FakePostgresClient();
    client.queueResponse([buildRow()]);
    const store = new PostgresJobStore(client);

    const job = await store.getJob("job_1");

    expect(job?.id).toBe("job_1");
    expect(client.calls[0]?.query).toContain("where id = $1");
  });

  it("creates a job and serializes its payload", async () => {
    const client = new FakePostgresClient();
    client.queueResponse([buildRow()]);
    const store = new PostgresJobStore(client);

    const created = await store.createJob({
      id: "job_1",
      type: "review_requested",
      tenantId: "tenant_1",
      repositoryId: "repo_1",
      changeRequestId: "cr_1",
      dedupeKey: "repo_1:cr_1:review",
      priority: 100,
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      payload: {
        headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        trigger: "manual_command",
        mode: "quick",
      },
      createdAt: new Date("2026-03-09T10:00:00.000Z"),
      scheduledAt: new Date("2026-03-09T10:00:00.000Z"),
    });

    expect(created.id).toBe("job_1");
    expect(client.calls[0]?.query).toContain("insert into jobs");
    // An object, not a JSON string: see the note in createJob.
    expect(client.calls[0]?.params?.[9]).toEqual({
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      trigger: "manual_command",
      mode: "quick",
    });
  });

  it("finds an active job by dedupe key", async () => {
    const client = new FakePostgresClient();
    client.queueResponse([buildRow()]);
    const store = new PostgresJobStore(client);

    const job = await store.findActiveByDedupeKey("repo_1:cr_1:review");

    expect(job?.dedupeKey).toBe("repo_1:cr_1:review");
    expect(client.calls[0]?.query).toContain("where dedupe_key = $1");
  });

  it("lists queued jobs in claim order", async () => {
    const client = new FakePostgresClient();
    client.queueResponse([
      buildRow({ id: "job_1", priority: 100 }),
      buildRow({ id: "job_2", priority: 90 }),
    ]);
    const store = new PostgresJobStore(client);

    const jobs = await store.listQueuedJobs(
      2,
      new Date("2026-03-09T10:05:00.000Z"),
    );

    expect(jobs).toHaveLength(2);
    expect(client.calls[0]?.query).toContain("order by priority desc");
    expect(client.calls[0]?.query).toContain("scheduled_at <= $2");
    expect(client.calls[0]?.params).toEqual([2, "2026-03-09T10:05:00.000Z"]);
  });

  it("lists running jobs", async () => {
    const client = new FakePostgresClient();
    client.queueResponse([buildRow({ status: "running" })]);
    const store = new PostgresJobStore(client);

    const jobs = await store.listRunningJobs();

    expect(jobs[0]?.status).toBe("running");
    expect(client.calls[0]?.query).toContain("where status = 'running'");
  });

  it("marks queued jobs as running", async () => {
    const client = new FakePostgresClient();
    client.queueResponse([
      buildRow({
        status: "running",
        worker_id: "worker_1",
        started_at: new Date("2026-03-09T10:05:00.000Z"),
      }),
    ]);
    const store = new PostgresJobStore(client);

    const jobs = await store.markJobsRunning(
      ["job_1"],
      "worker_1",
      new Date("2026-03-09T10:05:00.000Z"),
    );

    expect(jobs[0]?.workerId).toBe("worker_1");
    expect(client.calls[0]?.query).toContain("update jobs");
  });

  it("updates an existing job", async () => {
    const client = new FakePostgresClient();
    client.queueResponse([
      buildRow({
        status: "completed",
        completed_at: new Date("2026-03-09T10:06:00.000Z"),
      }),
    ]);
    const store = new PostgresJobStore(client);

    const updated = await store.updateJob("job_1", {
      status: "completed",
      completedAt: new Date("2026-03-09T10:06:00.000Z"),
    });

    expect(updated.status).toBe("completed");
    expect(client.calls[0]?.query).toContain("where id = $");
  });

  it("guards an update on the expected status and keeps a moved job", async () => {
    const client = new FakePostgresClient();
    client.queueResponse([]);
    client.queueResponse([buildRow({ status: "queued" })]);
    const store = new PostgresJobStore(client);

    const result = await store.updateJob(
      "job_1",
      {
        status: "completed",
        completedAt: new Date("2026-03-09T10:06:00.000Z"),
      },
      { expectedStatus: "running" },
    );

    expect(client.calls[0]?.query).toMatch(/where id = \$3 and status = \$4/);
    expect(client.calls[0]?.params?.slice(2)).toEqual(["job_1", "running"]);
    expect(result.status).toBe("queued");
  });

  it("returns the active job when another delivery holds the dedupe key", async () => {
    const client = new FakePostgresClient();
    client.queueResponse([]);
    client.queueResponse([buildRow({ id: "job_existing", status: "running" })]);
    const store = new PostgresJobStore(client);

    const created = await store.createJob({
      id: "job_new",
      type: "review_requested",
      tenantId: "tenant_1",
      repositoryId: "repo_1",
      changeRequestId: "cr_1",
      dedupeKey: "repo_1:cr_1:review",
      priority: 100,
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      payload: {
        headSha: "b".repeat(40),
        trigger: "manual_command",
        mode: "quick",
      },
      createdAt: new Date("2026-03-09T10:00:00.000Z"),
      scheduledAt: new Date("2026-03-09T10:00:00.000Z"),
    });

    expect(client.calls[0]?.query).toContain(
      "on conflict (dedupe_key) where status in ('queued', 'running')",
    );
    expect(client.calls[1]?.query).toContain("where dedupe_key = $1");
    expect(created.id).toBe("job_existing");
  });

  it("also guards on the owning worker when given", async () => {
    const client = new FakePostgresClient();
    client.queueResponse([buildRow({ status: "completed" })]);
    const store = new PostgresJobStore(client);

    await store.updateJob(
      "job_1",
      { status: "completed" },
      { expectedStatus: "running", expectedWorkerId: "worker_a" },
    );

    expect(client.calls[0]?.query).toMatch(
      /where id = \$2 and status = \$3 and worker_id = \$4/,
    );
    expect(client.calls[0]?.params?.slice(1)).toEqual([
      "job_1",
      "running",
      "worker_a",
    ]);
  });

  it("retries the insert once when the key holder finished meanwhile", async () => {
    const client = new FakePostgresClient();
    client.queueResponse([]);
    client.queueResponse([]);
    client.queueResponse([buildRow({ id: "job_new" })]);
    const store = new PostgresJobStore(client);

    const created = await store.createJob({
      id: "job_new",
      type: "review_requested",
      tenantId: "tenant_1",
      repositoryId: "repo_1",
      changeRequestId: "cr_1",
      dedupeKey: "repo_1:cr_1:review",
      priority: 100,
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      payload: {
        headSha: "b".repeat(40),
        trigger: "manual_command",
        mode: "quick",
      },
      createdAt: new Date("2026-03-09T10:00:00.000Z"),
      scheduledAt: new Date("2026-03-09T10:00:00.000Z"),
    });

    expect(
      client.calls.map((call) => call.query.trim().split(/\s+/)[0]),
    ).toEqual(["insert", "select", "insert"]);
    expect(created.id).toBe("job_new");
  });

  it("cancels superseded queued review jobs", async () => {
    const client = new FakePostgresClient();
    client.queueResponse([{ canceled_count: 2 }]);
    const store = new PostgresJobStore(client);

    const canceled = await store.cancelSupersededReviewJobs({
      repositoryId: "repo_1",
      changeRequestId: "cr_1",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      createdBefore: new Date("2026-03-09T10:00:00.000Z"),
    });

    expect(canceled.canceledCount).toBe(2);
    expect(client.calls[0]?.query).toContain("type = 'review_requested'");
    expect(client.calls[0]?.query).toContain("status = 'queued'");
    // Manual commands carry no headSha and must never be superseded.
    expect(client.calls[0]?.query).toContain("payload->>'headSha' is not null");
    // Never cancel a push that was queued after the running job started.
    expect(client.calls[0]?.query).toContain("created_at < $4");
  });

  it("requeues stale running jobs whose workers are no longer fresh", async () => {
    const client = new FakePostgresClient();
    client.queueResponse([{ recovered_count: 1 }]);
    const store = new PostgresJobStore(client);

    const recovered = await store.requeueStaleRunningJobs({
      activeWorkerIds: ["worker-fresh"],
      staleStartedBefore: new Date("2026-03-09T09:58:00.000Z"),
      recoveredAt: new Date("2026-03-09T10:00:00.000Z"),
    });

    expect(recovered).toBe(1);
    expect(client.calls[0]?.query).toContain("where status = 'running'");
    expect(client.calls[0]?.query).toContain("worker_id");
  });

  it("hands a stopping worker's running jobs back to the queue", async () => {
    const client = new FakePostgresClient();
    client.queueResponse([{ id: "job_1" }, { id: "job_2" }]);
    const store = new PostgresJobStore(client);

    const requeued = await store.requeueWorkerJobs(
      "worker-a",
      new Date("2026-03-09T10:00:00.000Z"),
    );

    expect(requeued).toBe(2);
    expect(client.calls[0]?.query).toContain(
      "where status = 'running' and worker_id = $1",
    );
    expect(client.calls[0]?.params?.[0]).toBe("worker-a");
  });

  it("rejects empty identifiers before querying", async () => {
    const client = new FakePostgresClient();
    const store = new PostgresJobStore(client);

    await expect(() => store.findActiveByDedupeKey("")).rejects.toThrow(
      /dedupeKey/i,
    );
    expect(client.calls).toHaveLength(0);
  });

  it("rejects invalid rows returned from the database", async () => {
    const client = new FakePostgresClient();
    client.queueResponse([
      {
        ...buildRow(),
        tenant_id: undefined,
      },
    ]);
    const store = new PostgresJobStore(client);

    await expect(() => store.listQueuedJobs(1, new Date())).rejects.toThrow(
      /tenantId/i,
    );
  });
});
