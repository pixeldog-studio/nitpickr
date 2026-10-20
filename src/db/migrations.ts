export interface MigrationOptions {
  /** Width of the `memories.embedding` vector column (default 1536). */
  embeddingDimensions?: number;
}

export const DEFAULT_MIGRATION_EMBEDDING_DIMENSIONS = 1536;

function assertDimensions(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("embeddingDimensions must be a positive integer.");
  }
  return value;
}

/**
 * Build the ordered, idempotent migration list. The embedding vector width is
 * a parameter so self-hosters can use non-OpenAI embedding models (e.g.
 * nomic-embed-text = 768) — see NITPICKR_EMBEDDING_DIMENSIONS.
 */
export function buildMigrations(options: MigrationOptions = {}): string[] {
  const dims = assertDimensions(
    options.embeddingDimensions ?? DEFAULT_MIGRATION_EMBEDDING_DIMENSIONS,
  );
  return [
    `
    create table if not exists jobs (
      id text primary key,
      type text not null,
      tenant_id text not null,
      repository_id text not null,
      change_request_id text,
      dedupe_key text not null,
      priority integer not null,
      status text not null,
      attempts integer not null,
      max_attempts integer not null,
      payload jsonb not null,
      created_at timestamptz not null,
      scheduled_at timestamptz not null,
      started_at timestamptz,
      completed_at timestamptz,
      worker_id text,
      last_error text
    );

    create index if not exists jobs_queue_idx on jobs (status, priority desc, scheduled_at asc);
    create index if not exists jobs_tenant_idx on jobs (tenant_id, status);
  `,
    `
    create table if not exists memories (
      id text primary key,
      tenant_id text not null,
      repository_id text not null,
      kind text not null,
      summary text not null,
      path text,
      confidence double precision not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    );

    create index if not exists memories_repo_idx on memories (tenant_id, repository_id);
  `,
    `
    create table if not exists change_requests (
      id text primary key,
      tenant_id text not null,
      installation_id text not null,
      repository_id text not null,
      provider text not null,
      number integer not null,
      title text not null,
      base_sha text not null,
      head_sha text not null,
      status text not null,
      author_login text not null,
      updated_at timestamptz not null
    );

    create index if not exists change_requests_repo_idx on change_requests (tenant_id, repository_id, number desc);
  `,
    `
    create table if not exists review_runs (
      id text primary key,
      tenant_id text not null,
      repository_id text not null,
      change_request_id text not null references change_requests (id),
      trigger jsonb not null,
      mode text not null,
      scope text not null default 'full_pr',
      head_sha text not null,
      compared_from_sha text,
      status text not null,
      budgets jsonb not null,
      summary text,
      mermaid text,
      published_review_id text,
      failure_reason text,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      completed_at timestamptz
    );

    create index if not exists review_runs_lookup_idx on review_runs (tenant_id, repository_id, change_request_id, created_at desc);
  `,
    `
    create table if not exists review_findings (
      id text primary key,
      review_run_id text not null references review_runs (id),
      repository_id text not null,
      path text not null,
      line integer not null,
      finding_type text not null default 'bug',
      severity text not null,
      category text not null,
      title text not null,
      body text not null,
      fix_prompt text not null,
      created_at timestamptz not null
    );

    create index if not exists review_findings_run_idx on review_findings (review_run_id, severity);
  `,
    `
    create table if not exists published_comments (
      id text primary key,
      review_run_id text not null references review_runs (id),
      published_review_id text not null,
      path text not null,
      line integer not null,
      body text not null,
      provider_thread_id text,
      provider_comment_id text,
      fingerprint text,
      resolved_at timestamptz,
      created_at timestamptz not null
    );

    create index if not exists published_comments_run_idx on published_comments (review_run_id);
  `,
    `
    create table if not exists discussion_events (
      id text primary key,
      tenant_id text not null,
      repository_id text not null,
      change_request_id text not null references change_requests (id),
      author_login text not null,
      body text not null,
      path text,
      line integer,
      source text not null,
      provider_created_at timestamptz not null,
      created_at timestamptz not null
    );

    create index if not exists discussion_events_repo_idx on discussion_events (tenant_id, repository_id, change_request_id, provider_created_at desc);
  `,
    `
    alter table review_findings
    add column if not exists suggested_change text;
  `,
    `
    alter table review_runs
    add column if not exists check_run_id text;
  `,
    `
    alter table review_runs
    add column if not exists scope text not null default 'full_pr';

    alter table review_runs
    add column if not exists compared_from_sha text;
  `,
    `
    alter table review_findings
    add column if not exists finding_type text not null default 'bug';
  `,
    `
    alter table published_comments
    add column if not exists provider_thread_id text;

    alter table published_comments
    add column if not exists provider_comment_id text;

    alter table published_comments
    add column if not exists fingerprint text;

    alter table published_comments
    add column if not exists resolved_at timestamptz;
  `,
    `
    create table if not exists app_runtime_config (
      singleton_key text primary key,
      encrypted_runtime_secrets text,
      updated_at timestamptz not null
    );
  `,
    `
    create table if not exists worker_heartbeats (
      worker_id text primary key,
      status text not null,
      last_seen_at timestamptz not null,
      updated_at timestamptz not null
    );
  `,
    `
    create table if not exists webhook_events (
      delivery_id text primary key,
      provider text not null,
      event_name text not null,
      status text not null,
      repository_id text,
      change_request_id text,
      payload jsonb,
      error_message text,
      received_at timestamptz not null,
      updated_at timestamptz not null
    );

    create index if not exists webhook_events_status_idx on webhook_events (provider, status, updated_at desc);
  `,
    `
    create table if not exists review_feedback_events (
      id text primary key,
      tenant_id text not null,
      repository_id text not null,
      scope_key text not null,
      provider_comment_id text,
      fingerprint text,
      path text,
      category text,
      finding_type text,
      kind text not null,
      count integer not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    );

    create unique index if not exists review_feedback_events_scope_idx
      on review_feedback_events (repository_id, scope_key);

    create index if not exists review_feedback_events_repo_idx
      on review_feedback_events (tenant_id, repository_id, updated_at desc);
  `,
    `
    drop index if exists review_feedback_events_scope_idx;

    create unique index if not exists review_feedback_events_scope_idx
      on review_feedback_events (repository_id, scope_key);
  `,
    `
    create extension if not exists vector;

    alter table memories
      add column if not exists embedding vector(${dims});

    alter table memories
      add column if not exists tags text[] not null default '{}';

    alter table memories
      add column if not exists globs text[] not null default '{}';

    alter table memories
      add column if not exists usage_count integer not null default 0;

    alter table memories
      add column if not exists last_used_at timestamptz;

    alter table memories
      add column if not exists superseded_by text references memories (id);

    alter table memories
      add column if not exists source text not null default 'discussion';

    create index if not exists memories_embedding_idx
      on memories using hnsw (embedding vector_cosine_ops);

    create index if not exists memories_tags_idx on memories using gin (tags);

    create index if not exists memories_repo_active_idx
      on memories (tenant_id, repository_id)
      where superseded_by is null;
  `,
    `
    create table if not exists discussion_acknowledgments (
      repository_id text not null,
      provider_comment_id text not null,
      acknowledged_at timestamptz not null,
      primary key (repository_id, provider_comment_id)
    );
  `,
    // At most one active job per dedupe key, so concurrent webhook deliveries
    // can't both enqueue. Older duplicates are canceled first (keeping a
    // running job, else the oldest) so the index can always be built.
    `
    update jobs
    set status = 'canceled',
        completed_at = now(),
        last_error = 'Canceled: duplicate of an active job with the same dedupe key.'
    where id in (
      select id
      from (
        select id,
               row_number() over (
                 partition by dedupe_key
                 order by (status = 'running') desc, created_at asc
               ) as rank
        from jobs
        where status in ('queued', 'running')
      ) ranked
      where rank > 1
    );
  `,
    `
    create unique index if not exists jobs_active_dedupe_idx
      on jobs (dedupe_key)
      where status in ('queued', 'running');
  `,
    // Job payloads used to be stored double-encoded (a jsonb string holding
    // JSON), so SQL could not read fields inside them. Unwrap them once.
    `
    update jobs
    set payload = (payload #>> '{}')::jsonb
    where jsonb_typeof(payload) = 'string';
  `,
    // Re-shape memories.embedding when the configured dimension changes (e.g.
    // switching from text-embedding-3-small/1536 to nomic-embed-text/768).
    // Existing vectors cannot be converted, so they are cleared; memory recall
    // falls back to keyword/recency ranking for those rows until re-embedded.
    `
    do $$
    begin
      if exists (
        select 1
        from pg_attribute
        where attrelid = 'memories'::regclass
          and attname = 'embedding'
          and not attisdropped
          and atttypmod <> ${dims}
      ) then
        drop index if exists memories_embedding_idx;
        alter table memories
          alter column embedding type vector(${dims}) using null;
        create index if not exists memories_embedding_idx
          on memories using hnsw (embedding vector_cosine_ops);
      end if;
    end
    $$;
  `,
  ];
}

/** Default migration list (1536-dimension embeddings). */
export const migrations = buildMigrations();
