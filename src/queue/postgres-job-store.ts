import { z } from "zod";

import type { JobStore, QueueJob, QueueJobInput } from "./queue-scheduler.js";

const queueJobStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "canceled",
]);

const queueJobTypeSchema = z.enum([
  "review_requested",
  "interaction_requested",
  "memory_ingest",
]);

const queueJobRowSchema = z
  .object({
    id: z.string().min(1),
    type: queueJobTypeSchema,
    tenant_id: z.string().min(1, "tenantId is required."),
    repository_id: z.string().min(1, "repositoryId is required."),
    change_request_id: z.string().nullable(),
    dedupe_key: z.string().min(1, "dedupeKey is required."),
    priority: z.number().int(),
    status: queueJobStatusSchema,
    attempts: z.number().int().nonnegative(),
    max_attempts: z.number().int().positive(),
    payload: z.union([z.record(z.string(), z.unknown()), z.string()]),
    created_at: z.coerce.date(),
    scheduled_at: z.coerce.date(),
    started_at: z.coerce.date().nullable(),
    completed_at: z.coerce.date().nullable(),
    worker_id: z.string().nullable(),
    last_error: z.string().nullable(),
  })
  .transform(
    (row): QueueJob => ({
      id: row.id,
      type: row.type,
      tenantId: row.tenant_id,
      repositoryId: row.repository_id,
      changeRequestId: row.change_request_id,
      dedupeKey: row.dedupe_key,
      priority: row.priority,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      payload:
        typeof row.payload === "string"
          ? (JSON.parse(row.payload) as QueueJob["payload"])
          : row.payload,
      createdAt: row.created_at,
      scheduledAt: row.scheduled_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      workerId: row.worker_id,
      lastError: row.last_error,
    }),
  );

export interface PostgresClient {
  unsafe<T extends Record<string, unknown>>(
    query: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must not be empty.`);
  }
}

function parseRow(row: Record<string, unknown>): QueueJob {
  const parsed = queueJobRowSchema.safeParse(row);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const firstPath = String(firstIssue?.path[0] ?? "row");
    const fieldName =
      firstPath === "tenant_id"
        ? "tenantId"
        : firstPath === "repository_id"
          ? "repositoryId"
          : firstPath === "change_request_id"
            ? "changeRequestId"
            : firstPath === "dedupe_key"
              ? "dedupeKey"
              : firstPath === "max_attempts"
                ? "maxAttempts"
                : firstPath === "created_at"
                  ? "createdAt"
                  : firstPath === "scheduled_at"
                    ? "scheduledAt"
                    : firstPath === "started_at"
                      ? "startedAt"
                      : firstPath === "completed_at"
                        ? "completedAt"
                        : firstPath === "worker_id"
                          ? "workerId"
                          : firstPath === "last_error"
                            ? "lastError"
                            : firstPath;

    throw new Error(`Invalid job row: ${fieldName}.`);
  }

  return parsed.data;
}

export class PostgresJobStore implements JobStore {
  readonly #client: PostgresClient;

  constructor(client: PostgresClient) {
    this.#client = client;
  }

  async getJob(jobId: string): Promise<QueueJob | null> {
    assertNonEmpty(jobId, "jobId");

    const rows = await this.#client.unsafe<Record<string, unknown>>(
      `
        select *
        from jobs
        where id = $1
        limit 1
      `,
      [jobId],
    );

    const row = rows[0];
    return row ? parseRow(row) : null;
  }

  async findActiveByDedupeKey(dedupeKey: string): Promise<QueueJob | null> {
    assertNonEmpty(dedupeKey, "dedupeKey");

    const rows = await this.#client.unsafe<Record<string, unknown>>(
      `
        select *
        from jobs
        where dedupe_key = $1
          and status in ('queued', 'running')
        limit 1
      `,
      [dedupeKey],
    );

    const row = rows[0];
    return row ? parseRow(row) : null;
  }

  async createJob(input: QueueJobInput): Promise<QueueJob> {
    const rows = await this.#client.unsafe<Record<string, unknown>>(
      `
        insert into jobs (
          id,
          type,
          tenant_id,
          repository_id,
          change_request_id,
          dedupe_key,
          priority,
          status,
          attempts,
          payload,
          max_attempts,
          created_at,
          scheduled_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
        returning *
      `,
      [
        input.id,
        input.type,
        input.tenantId,
        input.repositoryId,
        input.changeRequestId,
        input.dedupeKey,
        input.priority,
        input.status,
        input.attempts,
        // Pass the object: postgres.js encodes jsonb parameters itself, and a
        // pre-stringified payload is stored as a jsonb *string*, which makes
        // every `payload->>'…'` query (supersede, check runs) match nothing.
        input.payload,
        input.maxAttempts,
        input.createdAt,
        input.scheduledAt,
      ],
    );

    return parseRow(rows[0] ?? {});
  }

  async listQueuedJobs(limit: number, dueBy: Date): Promise<QueueJob[]> {
    const rows = await this.#client.unsafe<Record<string, unknown>>(
      `
        select *
        from jobs
        where status = 'queued'
          and scheduled_at <= $2
        order by priority desc, scheduled_at asc, created_at asc
        limit $1
      `,
      [limit, dueBy.toISOString()],
    );

    return rows.map(parseRow);
  }

  async listRunningJobs(): Promise<QueueJob[]> {
    const rows = await this.#client.unsafe<Record<string, unknown>>(
      `
        select *
        from jobs
        where status = 'running'
      `,
    );

    return rows.map(parseRow);
  }

  async markJobsRunning(
    jobIds: string[],
    workerId: string,
    startedAt: Date,
  ): Promise<QueueJob[]> {
    const rows = await this.#client.unsafe<Record<string, unknown>>(
      `
        update jobs
        set status = 'running',
            worker_id = $2,
            started_at = $3
        where id = any($1::text[])
          and status = 'queued'
        returning *
      `,
      [jobIds, workerId, startedAt],
    );

    return rows.map(parseRow);
  }

  async updateJob(jobId: string, patch: Partial<QueueJob>): Promise<QueueJob> {
    assertNonEmpty(jobId, "jobId");

    const assignments: string[] = [];
    const params: unknown[] = [];

    const setField = (column: string, value: unknown): void => {
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    };

    if (patch.status !== undefined) {
      setField("status", patch.status);
    }
    if (patch.attempts !== undefined) {
      setField("attempts", patch.attempts);
    }
    if (patch.scheduledAt !== undefined) {
      setField("scheduled_at", patch.scheduledAt);
    }
    if (patch.startedAt !== undefined) {
      setField("started_at", patch.startedAt);
    }
    if (patch.completedAt !== undefined) {
      setField("completed_at", patch.completedAt);
    }
    if (patch.workerId !== undefined) {
      setField("worker_id", patch.workerId);
    }
    if (patch.lastError !== undefined) {
      setField("last_error", patch.lastError);
    }

    if (assignments.length === 0) {
      throw new Error("updateJob requires at least one mutable field.");
    }

    params.push(jobId);
    const rows = await this.#client.unsafe<Record<string, unknown>>(
      `
        update jobs
        set ${assignments.join(", ")}
        where id = $${params.length}
        returning *
      `,
      params,
    );

    return parseRow(rows[0] ?? {});
  }

  async cancelSupersededReviewJobs(input: {
    repositoryId: string;
    changeRequestId: string;
    headSha: string;
    /** Only jobs queued before the running one; newer pushes keep theirs. */
    createdBefore: Date;
  }): Promise<{ canceledCount: number; checkRunIds: string[] }> {
    const rows = await this.#client.unsafe<{
      canceled_count: number;
      check_run_ids: string[] | null;
    }>(
      `
        with canceled as (
          update jobs
          set status = 'canceled',
              completed_at = now()
          where type = 'review_requested'
            and status = 'queued'
            and repository_id = $1
            and change_request_id = $2
            and payload->>'headSha' is not null
            and payload->>'headSha' <> $3
            and created_at < $4
          returning id, payload->>'checkRunId' as check_run_id
        )
        select count(*)::int as canceled_count,
               array_remove(array_agg(check_run_id), null) as check_run_ids
        from canceled
      `,
      [
        input.repositoryId,
        input.changeRequestId,
        input.headSha,
        input.createdBefore,
      ],
    );

    return {
      canceledCount: rows[0]?.canceled_count ?? 0,
      checkRunIds: rows[0]?.check_run_ids ?? [],
    };
  }

  /**
   * Record the queued check run so the worker updates it instead. False
   * when the job already left the queue (claimed or canceled meanwhile).
   */
  async setJobCheckRun(jobId: string, checkRunId: string): Promise<boolean> {
    const rows = await this.#client.unsafe<{ id: string }>(
      `
        update jobs
        set payload = payload || jsonb_build_object('checkRunId', $2::text)
        where id = $1 and status = 'queued'
        returning id
      `,
      [jobId, checkRunId],
    );
    return rows.length > 0;
  }

  async requeueStaleRunningJobs(input: {
    activeWorkerIds: string[];
    staleStartedBefore: Date;
    recoveredAt: Date;
  }): Promise<number> {
    const rows = await this.#client.unsafe<{ recovered_count: number }>(
      `
        with recovered as (
          update jobs
          set status = 'queued',
              scheduled_at = $3,
              started_at = null,
              worker_id = null,
              last_error = 'Recovered stale running job after worker heartbeat timeout.'
          where status = 'running'
            and started_at <= $1
            and (
              worker_id is null
              or worker_id <> all($2::text[])
            )
          returning id
        )
        select count(*)::int as recovered_count
        from recovered
      `,
      [input.staleStartedBefore, input.activeWorkerIds, input.recoveredAt],
    );

    return rows[0]?.recovered_count ?? 0;
  }
}
