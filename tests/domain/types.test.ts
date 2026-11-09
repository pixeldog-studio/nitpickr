import { describe, expect, it } from "vitest";

import {
  parseChangeRequest,
  parseReviewFinding,
  parseReviewRun,
  parseTenant,
} from "../../src/domain/types.js";

describe("domain types", () => {
  it("parses a tenant", () => {
    const tenant = parseTenant({
      id: "tenant_1",
      provider: "github",
      installationId: "install_1",
      slug: "nitpickr-lab",
    });

    expect(tenant.slug).toBe("nitpickr-lab");
    expect(tenant.provider).toBe("github");
  });

  it("rejects an invalid tenant", () => {
    expect(() =>
      parseTenant({
        id: "tenant_1",
        provider: "git",
        installationId: "install_1",
        slug: "nitpickr-lab",
      }),
    ).toThrow(/provider/i);
  });

  it("parses a change request", () => {
    const changeRequest = parseChangeRequest({
      id: "cr_1",
      tenantId: "tenant_1",
      installationId: "install_1",
      repositoryId: "repo_1",
      provider: "github",
      number: 42,
      title: "Add faster queueing",
      baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      status: "open",
      authorLogin: "ruben",
    });

    expect(changeRequest.number).toBe(42);
    expect(changeRequest.status).toBe("open");
  });

  it("rejects invalid change request shas", () => {
    expect(() =>
      parseChangeRequest({
        id: "cr_1",
        tenantId: "tenant_1",
        installationId: "install_1",
        repositoryId: "repo_1",
        provider: "github",
        number: 42,
        title: "Add faster queueing",
        baseSha: "short",
        headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        status: "open",
        authorLogin: "ruben",
      }),
    ).toThrow(/baseSha/i);
  });

  it("parses a skipped review run with zero file and comment budgets", () => {
    // Stored when a push had no reviewable files; read back as the latest
    // completed review on the next push, so it must parse (#42).
    const skipped = {
      id: "run_0",
      tenantId: "tenant_1",
      repositoryId: "repo_1",
      changeRequestId: "cr_1",
      trigger: { type: "pr_synchronized", actorLogin: "ruben" },
      mode: "quick",
      scope: "commit_delta",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      comparedFromSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "skipped",
      budgets: {
        maxFiles: 0,
        maxHunks: 200,
        maxTokens: 120000,
        maxComments: 0,
        maxDurationMs: 300000,
      },
    };
    const reviewRun = parseReviewRun(skipped);

    expect(reviewRun.status).toBe("skipped");
    expect(reviewRun.budgets.maxFiles).toBe(0);
    expect(reviewRun.budgets.maxComments).toBe(0);
    expect(() =>
      parseReviewRun({
        ...skipped,
        budgets: { ...skipped.budgets, maxFiles: -1 },
      }),
    ).toThrow(/maxFiles/);
    expect(() =>
      parseReviewRun({
        ...skipped,
        budgets: { ...skipped.budgets, maxComments: -1 },
      }),
    ).toThrow(/maxComments/);
  });

  it("parses a review run with budgets", () => {
    const reviewRun = parseReviewRun({
      id: "run_1",
      tenantId: "tenant_1",
      repositoryId: "repo_1",
      changeRequestId: "cr_1",
      trigger: {
        type: "manual_command",
        command: "review",
        actorLogin: "ruben",
      },
      mode: "quick",
      scope: "full_pr",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      comparedFromSha: null,
      status: "queued",
      budgets: {
        maxFiles: 40,
        maxHunks: 160,
        maxTokens: 50000,
        maxComments: 15,
        maxDurationMs: 120000,
      },
    });

    expect(reviewRun.trigger.type).toBe("manual_command");
    if (reviewRun.trigger.type !== "manual_command") {
      throw new Error("Expected a manual command trigger.");
    }

    expect(reviewRun.trigger.command).toBe("review");
    expect(reviewRun.budgets.maxFiles).toBe(40);
  });

  it("rejects unknown review commands", () => {
    expect(() =>
      parseReviewRun({
        id: "run_1",
        tenantId: "tenant_1",
        repositoryId: "repo_1",
        changeRequestId: "cr_1",
        trigger: {
          type: "manual_command",
          command: "ship-it",
          actorLogin: "ruben",
        },
        mode: "quick",
        scope: "full_pr",
        headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        comparedFromSha: null,
        status: "queued",
        budgets: {
          maxFiles: 40,
          maxHunks: 160,
          maxTokens: 50000,
          maxComments: 15,
          maxDurationMs: 120000,
        },
      }),
    ).toThrow(/command/i);
  });

  it("parses review findings with AI fix prompts", () => {
    const finding = parseReviewFinding({
      id: "finding_1",
      reviewRunId: "run_1",
      repositoryId: "repo_1",
      path: "src/review/queue.ts",
      line: 18,
      findingType: "safe_suggestion",
      severity: "high",
      category: "correctness",
      title: "Queue ordering is unstable",
      body: "Jobs with the same priority can be reordered unexpectedly.",
      fixPrompt:
        "Rewrite the queue sorting logic to preserve insertion order for equal priorities.",
      suggestedChange:
        "return left.priority - right.priority || left.sequence - right.sequence;",
    });

    expect(finding.fixPrompt).toContain("queue sorting logic");
    expect(finding.suggestedChange).toContain("left.sequence");
  });

  it("rejects suggested changes on non-safe suggestion findings", () => {
    expect(() =>
      parseReviewFinding({
        id: "finding_1",
        reviewRunId: "run_1",
        repositoryId: "repo_1",
        path: "src/review/queue.ts",
        line: 18,
        findingType: "bug",
        severity: "high",
        category: "correctness",
        title: "Queue ordering is unstable",
        body: "Jobs with the same priority can be reordered unexpectedly.",
        fixPrompt:
          "Rewrite the queue sorting logic to preserve insertion order for equal priorities.",
        suggestedChange:
          "return left.priority - right.priority || left.sequence - right.sequence;",
      }),
    ).toThrow(/suggestedChange/i);
  });
});
