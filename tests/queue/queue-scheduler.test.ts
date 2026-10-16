import { describe, expect, it } from "vitest";

import {
  type JobStore,
  type QueueJob,
  type QueueJobInput,
  QueueScheduler,
} from "../../src/queue/queue-scheduler.js";

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
      createdAt: input.createdAt ?? new Date(),
      startedAt: null,
      completedAt: null,
      lastError: null,
      workerId: null,
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
      .sort((left, right) => right.priority - left.priority)
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
    const claimed: QueueJob[] = [];

    for (const jobId of jobIds) {
      const current = this.jobs.get(jobId);
      if (!current) {
        continue;
      }

      const next = {
        ...current,
        status: "running" as const,
        workerId,
        startedAt,
      };
      this.jobs.set(jobId, next);
      claimed.push(next);
    }

    return claimed;
  }

  async updateJob(jobId: string, patch: Partial<QueueJob>): Promise<QueueJob> {
    const current = this.jobs.get(jobId);
    if (!current) {
      throw new Error(`Unknown job ${jobId}`);
    }

    const next = {
      ...current,
      ...patch,
    };
    this.jobs.set(jobId, next);
    return next;
  }

  async cancelSupersededReviewJobs(input: {
    repositoryId: string;
    changeRequestId: string;
    headSha: string;
  }): Promise<number> {
    let canceled = 0;

    for (const [jobId, job] of this.jobs.entries()) {
      if (
        job.type === "review_requested" &&
        job.status === "queued" &&
        job.repositoryId === input.repositoryId &&
        job.changeRequestId === input.changeRequestId &&
        job.payload.headSha !== input.headSha
      ) {
        this.jobs.set(jobId, {
          ...job,
          status: "canceled",
          completedAt: new Date(),
        });
        canceled += 1;
      }
    }

    return canceled;
  }

  async requeueStaleRunningJobs(input: {
    activeWorkerIds: string[];
    staleStartedBefore: Date;
    recoveredAt: Date;
  }): Promise<number> {
    let recovered = 0;

    for (const [jobId, job] of this.jobs.entries()) {
      if (
        job.status === "running" &&
        job.startedAt !== null &&
        job.startedAt <= input.staleStartedBefore &&
        (!job.workerId || !input.activeWorkerIds.includes(job.workerId))
      ) {
        this.jobs.set(jobId, {
          ...job,
          status: "queued",
          scheduledAt: input.recoveredAt,
          startedAt: null,
          workerId: null,
          lastError:
            "Recovered stale running job after worker heartbeat timeout.",
        });
        recovered += 1;
      }
    }

    return recovered;
  }
}

const sha = {
  old: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  current: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  other: "cccccccccccccccccccccccccccccccccccccccc",
};

function buildJobInput(overrides: Partial<QueueJobInput> = {}): QueueJobInput {
  return {
    id: overrides.id ?? "job_1",
    type: overrides.type ?? "review_requested",
    tenantId: overrides.tenantId ?? "tenant_1",
    repositoryId: overrides.repositoryId ?? "repo_1",
    changeRequestId: overrides.changeRequestId ?? "cr_1",
    dedupeKey: overrides.dedupeKey ?? "repo_1:cr_1:review:head",
    priority: overrides.priority ?? 100,
    status: overrides.status ?? "queued",
    attempts: overrides.attempts ?? 0,
    maxAttempts: overrides.maxAttempts ?? 3,
    payload: overrides.payload ?? {
      headSha: sha.current,
      trigger: "manual_command",
      mode: "quick",
    },
    scheduledAt: overrides.scheduledAt ?? new Date("2026-03-09T10:00:00.000Z"),
    createdAt: overrides.createdAt ?? new Date("2026-03-09T10:00:00.000Z"),
  };
}

describe("QueueScheduler", () => {
  it("dedupes queued jobs by dedupe key", async () => {
    const store = new InMemoryJobStore();
    const scheduler = new QueueScheduler(store, {
      createId: () => "generated_job",
      now: () => new Date("2026-03-09T10:00:00.000Z"),
    });

    const first = await scheduler.enqueue({
      type: "review_requested",
      tenantId: "tenant_1",
      repositoryId: "repo_1",
      changeRequestId: "cr_1",
      dedupeKey: "repo_1:cr_1:review",
      priority: 100,
      payload: {
        headSha: sha.current,
        trigger: "manual_command",
        mode: "quick",
      },
    });

    const second = await scheduler.enqueue({
      type: "review_requested",
      tenantId: "tenant_1",
      repositoryId: "repo_1",
      changeRequestId: "cr_1",
      dedupeKey: "repo_1:cr_1:review",
      priority: 100,
      payload: {
        headSha: sha.current,
        trigger: "manual_command",
        mode: "quick",
      },
    });

    expect(first.id).toBe(second.id);
    expect(store.jobs.size).toBe(1);
  });

  it("claims queued jobs fairly across tenants", async () => {
    const store = new InMemoryJobStore();
    await store.createJob(
      buildJobInput({
        id: "running_job",
        tenantId: "tenant_1",
        status: "running",
      }),
    );
    await store.createJob(
      buildJobInput({
        id: "queued_tenant_1",
        tenantId: "tenant_1",
        dedupeKey: "repo_1:cr_2:review",
      }),
    );
    await store.createJob(
      buildJobInput({
        id: "queued_tenant_2",
        tenantId: "tenant_2",
        repositoryId: "repo_2",
        changeRequestId: "cr_2",
        dedupeKey: "repo_2:cr_2:review",
        priority: 95,
      }),
    );
    await store.createJob(
      buildJobInput({
        id: "queued_tenant_3",
        tenantId: "tenant_3",
        repositoryId: "repo_3",
        changeRequestId: "cr_3",
        dedupeKey: "repo_3:cr_3:review",
        priority: 90,
      }),
    );

    const scheduler = new QueueScheduler(store, {
      now: () => new Date("2026-03-09T10:01:00.000Z"),
    });

    const claimed = await scheduler.claimNextJobs({
      limit: 2,
      perTenantCap: 1,
      workerId: "worker_1",
    });

    expect(claimed.map((job) => job.id)).toEqual([
      "queued_tenant_2",
      "queued_tenant_3",
    ]);
    expect(store.jobs.get("queued_tenant_1")?.status).toBe("queued");
  });

  it("cancels superseded queued review jobs for the same change request", async () => {
    const store = new InMemoryJobStore();
    await store.createJob(
      buildJobInput({
        id: "queued_old",
        payload: {
          headSha: sha.old,
          trigger: "pr_synchronized",
          mode: "quick",
        },
      }),
    );
    await store.createJob(
      buildJobInput({
        id: "queued_current",
        dedupeKey: "repo_1:cr_1:review:current",
        payload: {
          headSha: sha.current,
          trigger: "pr_synchronized",
          mode: "quick",
        },
      }),
    );

    const scheduler = new QueueScheduler(store);
    const canceled = await scheduler.cancelSupersededReviewJobs({
      repositoryId: "repo_1",
      changeRequestId: "cr_1",
      headSha: sha.current,
      createdBefore: new Date("2026-03-09T10:00:00.000Z"),
    });

    expect(canceled).toBe(1);
    expect(store.jobs.get("queued_old")?.status).toBe("canceled");
    expect(store.jobs.get("queued_current")?.status).toBe("queued");
  });

  it("completes a running job", async () => {
    const store = new InMemoryJobStore();
    await store.createJob(
      buildJobInput({
        id: "running_job",
        status: "running",
      }),
    );

    const scheduler = new QueueScheduler(store, {
      now: () => new Date("2026-03-09T10:02:00.000Z"),
    });

    const completed = await scheduler.completeJob("running_job");

    expect(completed.status).toBe("completed");
    expect(completed.completedAt?.toISOString()).toBe(
      "2026-03-09T10:02:00.000Z",
    );
  });

  it("requeues retryable failures and fails exhausted jobs", async () => {
    const store = new InMemoryJobStore();
    await store.createJob(
      buildJobInput({
        id: "retryable_job",
        status: "running",
      }),
    );
    await store.createJob(
      buildJobInput({
        id: "exhausted_job",
        status: "running",
        attempts: 2,
        maxAttempts: 3,
      }),
    );

    const scheduler = new QueueScheduler(store, {
      now: () => new Date("2026-03-09T10:03:00.000Z"),
    });

    const retried = await scheduler.failJob("retryable_job", "network issue");
    const failed = await scheduler.failJob("exhausted_job", "fatal issue");

    expect(retried.status).toBe("queued");
    expect(retried.attempts).toBe(1);
    expect(retried.lastError).toBe("network issue");
    expect(retried.scheduledAt.toISOString()).toBe("2026-03-09T10:03:30.000Z");
    expect(failed.status).toBe("failed");
    expect(failed.attempts).toBe(3);
  });

  it("backs off retries exponentially up to the cap and holds them until due", async () => {
    const store = new InMemoryJobStore();
    await store.createJob(
      buildJobInput({
        id: "flaky_job",
        status: "running",
        attempts: 3,
        maxAttempts: 10,
      }),
    );
    let now = new Date("2026-03-09T10:00:00.000Z");
    const scheduler = new QueueScheduler(store, {
      now: () => now,
      retryBaseDelayMs: 1_000,
      maxRetryDelayMs: 5_000,
    });

    const retried = await scheduler.failJob("flaky_job", "model timeout");
    // 4th attempt: 1s * 2^3 = 8s, capped at 5s.
    expect(retried.scheduledAt.toISOString()).toBe("2026-03-09T10:00:05.000Z");

    await expect(
      scheduler.claimNextJobs({ limit: 1, perTenantCap: 1, workerId: "w" }),
    ).resolves.toEqual([]);

    now = new Date("2026-03-09T10:00:05.000Z");
    const claimed = await scheduler.claimNextJobs({
      limit: 1,
      perTenantCap: 1,
      workerId: "w",
    });
    expect(claimed.map((job) => job.id)).toEqual(["flaky_job"]);
  });

  it("fails non-retryable jobs immediately", async () => {
    const store = new InMemoryJobStore();
    await store.createJob(
      buildJobInput({
        id: "invalid_model_job",
        status: "running",
      }),
    );

    const scheduler = new QueueScheduler(store, {
      now: () => new Date("2026-03-09T10:03:00.000Z"),
    });

    const failed = await scheduler.failJob(
      "invalid_model_job",
      "malformed model output",
      {
        retryable: false,
      },
    );

    expect(failed.status).toBe("failed");
    expect(failed.attempts).toBe(1);
  });

  it("requeues stale running jobs from workers without a fresh heartbeat", async () => {
    const store = new InMemoryJobStore();
    await store.createJob(
      buildJobInput({
        id: "stale_running_job",
        status: "running",
      }),
    );
    await store.updateJob("stale_running_job", {
      startedAt: new Date("2026-03-09T09:50:00.000Z"),
      workerId: "worker-stale",
    });

    await store.createJob(
      buildJobInput({
        id: "healthy_running_job",
        status: "running",
      }),
    );
    await store.updateJob("healthy_running_job", {
      startedAt: new Date("2026-03-09T09:59:30.000Z"),
      workerId: "worker-fresh",
    });

    const scheduler = new QueueScheduler(store, {
      now: () => new Date("2026-03-09T10:00:00.000Z"),
    });

    const recovered = await scheduler.recoverStaleRunningJobs({
      activeWorkerIds: ["worker-fresh"],
      staleStartedBefore: new Date("2026-03-09T09:58:00.000Z"),
    });

    expect(recovered).toBe(1);
    expect(store.jobs.get("stale_running_job")?.status).toBe("queued");
    expect(store.jobs.get("healthy_running_job")?.status).toBe("running");
  });
});
