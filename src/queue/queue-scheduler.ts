import { randomUUID } from "node:crypto";

export type QueueJobType =
  | "review_requested"
  | "interaction_requested"
  | "memory_ingest";
export type QueueJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export interface QueueJobPayload extends Record<string, unknown> {
  headSha?: string;
}

export interface QueueJobInput {
  id: string;
  type: QueueJobType;
  tenantId: string;
  repositoryId: string;
  changeRequestId: string | null;
  dedupeKey: string;
  priority: number;
  status: QueueJobStatus;
  attempts: number;
  maxAttempts: number;
  payload: QueueJobPayload;
  scheduledAt: Date;
  createdAt: Date;
}

export interface QueueJob extends QueueJobInput {
  startedAt: Date | null;
  completedAt: Date | null;
  workerId: string | null;
  lastError: string | null;
}

export interface EnqueueJobInput {
  type: QueueJobType;
  tenantId: string;
  repositoryId: string;
  changeRequestId: string;
  dedupeKey: string;
  priority: number;
  payload: QueueJobPayload;
  maxAttempts?: number;
  scheduledAt?: Date;
}

export interface JobStore {
  getJob(jobId: string): Promise<QueueJob | null>;
  findActiveByDedupeKey(dedupeKey: string): Promise<QueueJob | null>;
  createJob(input: QueueJobInput): Promise<QueueJob>;
  /** Queued jobs whose scheduled time is at or before `dueBy`, in claim order. */
  listQueuedJobs(limit: number, dueBy: Date): Promise<QueueJob[]>;
  listRunningJobs(): Promise<QueueJob[]>;
  markJobsRunning(
    jobIds: string[],
    workerId: string,
    startedAt: Date,
  ): Promise<QueueJob[]>;
  updateJob(jobId: string, patch: Partial<QueueJob>): Promise<QueueJob>;
  cancelSupersededReviewJobs(input: {
    repositoryId: string;
    changeRequestId: string;
    headSha: string;
    /** Only jobs queued before the running one; newer pushes keep theirs. */
    createdBefore: Date;
  }): Promise<{ canceledCount: number; checkRunIds: string[] }>;
  setJobCheckRun(jobId: string, checkRunId: string): Promise<boolean>;
  cancelQueuedReviewJobs(input: {
    repositoryId: string;
    changeRequestId: string;
  }): Promise<{ canceledCount: number; checkRunIds: string[] }>;
  requeueStaleRunningJobs(input: {
    activeWorkerIds: string[];
    staleStartedBefore: Date;
    recoveredAt: Date;
  }): Promise<number>;
}

export interface QueueSchedulerDependencies {
  now?: () => Date;
  createId?: () => string;
  /** Delay before the first retry; doubles per attempt up to maxRetryDelayMs. */
  retryBaseDelayMs?: number;
  maxRetryDelayMs?: number;
}

export const DEFAULT_RETRY_BASE_DELAY_MS = 30_000;
export const DEFAULT_MAX_RETRY_DELAY_MS = 15 * 60_000;

function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must not be empty.`);
  }
}

export class QueueScheduler {
  readonly #store: JobStore;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #retryBaseDelayMs: number;
  readonly #maxRetryDelayMs: number;

  constructor(store: JobStore, dependencies: QueueSchedulerDependencies = {}) {
    this.#store = store;
    this.#now = dependencies.now ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
    this.#retryBaseDelayMs =
      dependencies.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.#maxRetryDelayMs =
      dependencies.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  }

  async enqueue(input: EnqueueJobInput): Promise<QueueJob> {
    assertNonEmpty(input.tenantId, "tenantId");
    assertNonEmpty(input.repositoryId, "repositoryId");
    assertNonEmpty(input.changeRequestId, "changeRequestId");
    assertNonEmpty(input.dedupeKey, "dedupeKey");

    const existing = await this.#store.findActiveByDedupeKey(input.dedupeKey);
    if (existing) {
      return existing;
    }

    const now = this.#now();
    return this.#store.createJob({
      id: this.#createId(),
      type: input.type,
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
      changeRequestId: input.changeRequestId,
      dedupeKey: input.dedupeKey,
      priority: input.priority,
      status: "queued",
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      payload: input.payload,
      scheduledAt: input.scheduledAt ?? now,
      createdAt: now,
    });
  }

  async claimNextJobs(input: {
    limit: number;
    perTenantCap: number;
    workerId: string;
  }): Promise<QueueJob[]> {
    assertNonEmpty(input.workerId, "workerId");
    if (input.limit <= 0) {
      throw new Error("limit must be positive.");
    }
    if (input.perTenantCap <= 0) {
      throw new Error("perTenantCap must be positive.");
    }

    const queued = await this.#store.listQueuedJobs(
      input.limit * 5,
      this.#now(),
    );
    const running = await this.#store.listRunningJobs();
    const activeByTenant = new Map<string, number>();

    for (const job of running) {
      activeByTenant.set(
        job.tenantId,
        (activeByTenant.get(job.tenantId) ?? 0) + 1,
      );
    }

    const selected: QueueJob[] = [];
    for (const job of queued) {
      const activeCount = activeByTenant.get(job.tenantId) ?? 0;
      if (activeCount >= input.perTenantCap) {
        continue;
      }

      selected.push(job);
      activeByTenant.set(job.tenantId, activeCount + 1);

      if (selected.length === input.limit) {
        break;
      }
    }

    if (selected.length === 0) {
      return [];
    }

    return this.#store.markJobsRunning(
      selected.map((job) => job.id),
      input.workerId,
      this.#now(),
    );
  }

  async cancelSupersededReviewJobs(input: {
    repositoryId: string;
    changeRequestId: string;
    headSha: string;
    /** Only jobs queued before the running one; newer pushes keep theirs. */
    createdBefore: Date;
  }): Promise<{ canceledCount: number; checkRunIds: string[] }> {
    assertNonEmpty(input.repositoryId, "repositoryId");
    assertNonEmpty(input.changeRequestId, "changeRequestId");
    assertNonEmpty(input.headSha, "headSha");

    return this.#store.cancelSupersededReviewJobs(input);
  }

  /** A closed or merged PR needs none of its queued reviews. */
  async cancelReviewsForClosedPullRequest(input: {
    repositoryId: string;
    changeRequestId: string;
  }): Promise<{ canceledCount: number; checkRunIds: string[] }> {
    assertNonEmpty(input.repositoryId, "repositoryId");
    assertNonEmpty(input.changeRequestId, "changeRequestId");
    return this.#store.cancelQueuedReviewJobs(input);
  }

  async attachCheckRun(jobId: string, checkRunId: string): Promise<boolean> {
    assertNonEmpty(jobId, "jobId");
    assertNonEmpty(checkRunId, "checkRunId");
    return this.#store.setJobCheckRun(jobId, checkRunId);
  }

  async recoverStaleRunningJobs(input: {
    activeWorkerIds: string[];
    staleStartedBefore: Date;
  }): Promise<number> {
    return this.#store.requeueStaleRunningJobs({
      activeWorkerIds: input.activeWorkerIds,
      staleStartedBefore: input.staleStartedBefore,
      recoveredAt: this.#now(),
    });
  }

  async completeJob(jobId: string): Promise<QueueJob> {
    assertNonEmpty(jobId, "jobId");
    return this.#store.updateJob(jobId, {
      status: "completed",
      completedAt: this.#now(),
      workerId: null,
    });
  }

  async failJob(
    jobId: string,
    errorMessage: string,
    input: {
      retryable?: boolean;
    } = {},
  ): Promise<QueueJob> {
    assertNonEmpty(jobId, "jobId");
    assertNonEmpty(errorMessage, "errorMessage");

    const current = await this.#store.getJob(jobId);
    if (current === null) {
      throw new Error(`Unknown job ${jobId}`);
    }

    const nextAttempts = current.attempts + 1;

    if (input.retryable === false || nextAttempts >= current.maxAttempts) {
      return this.#store.updateJob(jobId, {
        status: "failed",
        attempts: nextAttempts,
        completedAt: this.#now(),
        workerId: null,
        lastError: errorMessage,
      });
    }

    // Exponential backoff: a struggling (often local, single-request) model
    // server gets breathing room instead of an immediate retry.
    const retryDelayMs = Math.min(
      this.#retryBaseDelayMs * 2 ** (nextAttempts - 1),
      this.#maxRetryDelayMs,
    );
    return this.#store.updateJob(jobId, {
      status: "queued",
      attempts: nextAttempts,
      scheduledAt: new Date(this.#now().getTime() + retryDelayMs),
      startedAt: null,
      workerId: null,
      lastError: errorMessage,
    });
  }
}
