import { describe, expect, it } from "vitest";

import { buildMigrations } from "../../src/db/migrations.js";

describe("job dedupe migration", () => {
  const migrations = buildMigrations();
  const position = (needle: string) =>
    migrations.findIndex((migration) => migration.includes(needle));

  it("cancels active duplicates before building the unique index", () => {
    const jobsTable = position("create table if not exists jobs");
    const cleanup = position("duplicate of an active job");
    const index = position(
      "create unique index if not exists jobs_active_dedupe_idx",
    );

    expect(jobsTable).toBeGreaterThanOrEqual(0);
    expect(cleanup).toBeGreaterThan(jobsTable);
    expect(index).toBeGreaterThan(cleanup);
  });

  it("keeps a running job, else the oldest, and only touches active rows", () => {
    const cleanup = migrations[position("duplicate of an active job")] ?? "";
    expect(cleanup).toContain(
      "order by (status = 'running') desc, created_at asc",
    );
    expect(cleanup).toContain("where status in ('queued', 'running')");
    expect(cleanup).toContain("where rank > 1");
  });

  it("uses the same predicate as the createJob conflict target", () => {
    const index = migrations[position("jobs_active_dedupe_idx")] ?? "";
    expect(index).toContain("on jobs (dedupe_key)");
    expect(index).toContain("where status in ('queued', 'running')");
  });
});
