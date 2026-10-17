import type { ChangeRequest } from "../domain/types.js";
import { parseReviewRun } from "../domain/types.js";
import type {
  PersistedDiscussionEvent,
  PersistedPublishedComment,
  PersistedReviewFinding,
  PersistedReviewRun,
  ReviewLifecycleStore,
} from "./review-lifecycle-service.js";

export interface PostgresReviewLifecycleClient {
  unsafe<T extends Record<string, unknown>>(
    query: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
}

export class PostgresReviewLifecycleStore implements ReviewLifecycleStore {
  readonly #client: PostgresReviewLifecycleClient;

  constructor(client: PostgresReviewLifecycleClient) {
    this.#client = client;
  }

  async upsertChangeRequest(changeRequest: ChangeRequest): Promise<void> {
    await this.#client.unsafe(
      `
        insert into change_requests (
          id,
          tenant_id,
          installation_id,
          repository_id,
          provider,
          number,
          title,
          base_sha,
          head_sha,
          status,
          author_login,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
        on conflict (id) do update set
          title = excluded.title,
          base_sha = excluded.base_sha,
          head_sha = excluded.head_sha,
          status = excluded.status,
          author_login = excluded.author_login,
          updated_at = now()
      `,
      [
        changeRequest.id,
        changeRequest.tenantId,
        changeRequest.installationId,
        changeRequest.repositoryId,
        changeRequest.provider,
        changeRequest.number,
        changeRequest.title,
        changeRequest.baseSha,
        changeRequest.headSha,
        changeRequest.status,
        changeRequest.authorLogin,
      ],
    );
  }

  async createReviewRun(reviewRun: PersistedReviewRun): Promise<void> {
    await this.#client.unsafe(
      `
        insert into review_runs (
          id,
          tenant_id,
          repository_id,
          change_request_id,
          trigger,
          mode,
          scope,
          head_sha,
          compared_from_sha,
          status,
          budgets,
          created_at,
          updated_at,
          completed_at
        )
        values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
      `,
      [
        reviewRun.id,
        reviewRun.tenantId,
        reviewRun.repositoryId,
        reviewRun.changeRequestId,
        JSON.stringify(reviewRun.trigger),
        reviewRun.mode,
        reviewRun.scope,
        reviewRun.headSha,
        reviewRun.comparedFromSha,
        reviewRun.status,
        JSON.stringify(reviewRun.budgets),
        reviewRun.createdAt,
        reviewRun.updatedAt,
        reviewRun.completedAt,
      ],
    );
  }

  async findLatestCompletedReviewRun(
    changeRequestId: string,
  ): Promise<PersistedReviewRun | null> {
    const rows = await this.#client.unsafe<{
      id: string;
      tenant_id: string;
      repository_id: string;
      change_request_id: string;
      trigger: string;
      mode: string;
      scope: string;
      head_sha: string;
      compared_from_sha: string | null;
      status: string;
      budgets: string;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    }>(
      `
        select
          id,
          tenant_id,
          repository_id,
          change_request_id,
          trigger,
          mode,
          scope,
          head_sha,
          compared_from_sha,
          status,
          budgets,
          created_at,
          updated_at,
          completed_at
        from review_runs
        where change_request_id = $1
          -- Only reviews that reached the PR: a failed run must not make
          -- its commit look reviewed (or become the next delta's base).
          and status in ('published', 'skipped')
        order by completed_at desc
        limit 1
      `,
      [changeRequestId],
    );

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      ...parseReviewRun({
        id: row.id,
        tenantId: row.tenant_id,
        repositoryId: row.repository_id,
        changeRequestId: row.change_request_id,
        trigger: JSON.parse(row.trigger),
        mode: row.mode,
        scope: row.scope,
        headSha: row.head_sha,
        comparedFromSha: row.compared_from_sha,
        status: row.status,
        budgets: JSON.parse(row.budgets),
      }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  async countCompletedReviewRuns(changeRequestId: string): Promise<number> {
    const rows = await this.#client.unsafe<{ count: string | number }>(
      `
        select count(*)::bigint as count
        from review_runs
        where change_request_id = $1
          and status in ('published', 'skipped')
      `,
      [changeRequestId],
    );

    const raw = rows[0]?.count;
    if (typeof raw === "number") {
      return raw;
    }
    if (typeof raw === "string") {
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  async markPublishedCommentsResolved(input: {
    providerThreadIds: string[];
    resolvedAt: string;
  }): Promise<number> {
    const rows = await this.#client.unsafe<{ resolved_count: number }>(
      `
        with resolved as (
          update published_comments
          set resolved_at = $2
          where provider_thread_id = any($1::text[])
            and resolved_at is null
          returning id
        )
        select count(*)::int as resolved_count
        from resolved
      `,
      [input.providerThreadIds, input.resolvedAt],
    );

    return rows[0]?.resolved_count ?? 0;
  }

  async supersedePreviousRuns(input: {
    changeRequestId: string;
    reviewRunId: string;
    completedAt: string;
  }): Promise<number> {
    const rows = await this.#client.unsafe<{ superseded_count: number }>(
      `
        with superseded as (
          update review_runs
          set status = 'superseded',
              updated_at = $3,
              completed_at = coalesce(completed_at, $3)
          where change_request_id = $1
            and id <> $2
            and status in ('running', 'published', 'failed', 'skipped')
          returning id
        )
        select count(*)::int as superseded_count
        from superseded
      `,
      [input.changeRequestId, input.reviewRunId, input.completedAt],
    );

    return rows[0]?.superseded_count ?? 0;
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
    await this.#client.unsafe(
      `
        update review_runs
        set status = $2,
            summary = $3,
            mermaid = $4,
            published_review_id = $5,
            updated_at = $6,
            completed_at = $6,
            failure_reason = null
        where id = $1
      `,
      [
        input.reviewRunId,
        input.status,
        input.summary,
        input.mermaid,
        input.publishedReviewId,
        input.completedAt,
      ],
    );

    for (const finding of input.findings) {
      await this.#client.unsafe(
        `
          insert into review_findings (
            id,
            review_run_id,
            repository_id,
            path,
            line,
            finding_type,
            severity,
            category,
            title,
            body,
            fix_prompt,
            suggested_change,
            created_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `,
        [
          finding.id,
          finding.reviewRunId,
          finding.repositoryId,
          finding.path,
          finding.line,
          finding.findingType,
          finding.severity,
          finding.category,
          finding.title,
          finding.body,
          finding.fixPrompt,
          finding.suggestedChange ?? null,
          finding.createdAt,
        ],
      );
    }

    for (const comment of input.publishedComments) {
      await this.#client.unsafe(
        `
          insert into published_comments (
            id,
            review_run_id,
            published_review_id,
            path,
            line,
            body,
            provider_thread_id,
            provider_comment_id,
            fingerprint,
            resolved_at,
            created_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `,
        [
          comment.id,
          comment.reviewRunId,
          comment.publishedReviewId,
          comment.path,
          comment.line,
          comment.body,
          comment.providerThreadId,
          comment.providerCommentId,
          comment.fingerprint,
          comment.resolvedAt,
          comment.createdAt,
        ],
      );
    }
  }

  async failReviewRun(input: {
    reviewRunId: string;
    errorMessage: string;
    completedAt: string;
  }): Promise<void> {
    await this.#client.unsafe(
      `
        update review_runs
        set status = $2,
            failure_reason = $3,
            updated_at = $4,
            completed_at = $4
        where id = $1
      `,
      [input.reviewRunId, "failed", input.errorMessage, input.completedAt],
    );
  }

  async saveDiscussionEvents(
    events: PersistedDiscussionEvent[],
  ): Promise<void> {
    for (const event of events) {
      await this.#client.unsafe(
        `
          insert into discussion_events (
            id,
            tenant_id,
            repository_id,
            change_request_id,
            author_login,
            body,
            path,
            line,
            source,
            provider_created_at,
            created_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          on conflict (id) do update set
            body = excluded.body,
            path = excluded.path,
            line = excluded.line
        `,
        [
          event.id,
          event.tenantId,
          event.repositoryId,
          event.changeRequestId,
          event.authorLogin,
          event.body,
          event.path,
          event.line,
          event.source,
          event.providerCreatedAt,
          event.createdAt,
        ],
      );
    }
  }
}
