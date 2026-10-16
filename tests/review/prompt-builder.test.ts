import { describe, expect, it } from "vitest";

import { PromptBuilder } from "../../src/review/prompt-builder.js";

describe("PromptBuilder", () => {
  it("builds a review prompt with instructions, memory, and file diffs", () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({
      changeRequest: {
        title: "Improve queue fairness",
        number: 42,
      },
      chunk: {
        index: 0,
        total: 1,
        files: [
          {
            path: "src/queue/queue-scheduler.ts",
            patch: "@@ -1,4 +1,8 @@\n+preserve order",
            additions: 8,
            deletions: 2,
          },
        ],
      },
      contextFiles: [
        {
          path: "src/queue/queue-scheduler.ts",
          patch: "@@ -1,4 +1,8 @@\n+preserve order",
          additions: 8,
          deletions: 2,
        },
        {
          path: "src/api/server.ts",
          patch: "@@ -10,1 +10,2 @@\n+validate body",
          additions: 2,
          deletions: 1,
        },
      ],
      instructionText:
        "strictness: balanced\nfocusAreas: queue fairness, prompt validation",
      memory: [
        {
          summary:
            "Maintainers rejected comments that suggest unstable ordering fixes.",
          path: "src/queue",
        },
      ],
      commentBudget: 5,
    });

    expect(prompt.system).toContain("JSON");
    expect(prompt.system).toContain("summary, diagram, findings");
    expect(prompt.system).toContain('Prefer `diagram.type = "sequence"`');
    expect(prompt.system).toContain("Do not return raw Mermaid text");
    expect(prompt.system).toContain("Keep the summary concise");
    expect(prompt.system).toContain(
      "Keep each finding body concise, clear, and actionable",
    );
    expect(prompt.system).toContain(
      "Write polished GitHub-ready copy in plain Markdown",
    );
    expect(prompt.system).toContain("Lead with the issue");
    expect(prompt.system).toContain("suggestedChange");
    expect(prompt.system).toContain("findingType");
    expect(prompt.system).toContain(
      "'bug' | 'safe_suggestion' | 'question' | 'teaching_note'",
    );
    expect(prompt.system).toContain(
      "Only return suggestedChange when the fix is small, local, and safe to apply inline on GitHub.",
    );
    expect(prompt.system).toContain(
      "Every fixPrompt must mention the exact file path and target line",
    );
    expect(prompt.system).toContain("'low' | 'medium' | 'high' | 'critical'");
    expect(prompt.system).toContain(
      "'correctness' | 'performance' | 'security' | 'maintainability' | 'testing' | 'style'",
    );
    expect(prompt.user).toContain("Improve queue fairness");
    expect(prompt.user).toContain("queue fairness");
    expect(prompt.user).toContain("unstable ordering fixes");
    expect(prompt.user).toContain("src/queue/queue-scheduler.ts");
    expect(prompt.user).toContain("Current PR context:");
    expect(prompt.user).toContain("src/api/server.ts (+2/-1)");
    expect(prompt.user).toContain("Primary review scope:");
  });

  it("renders the prior threads section grouped by state", () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({
      changeRequest: { title: "Refactor auth", number: 7 },
      chunk: {
        index: 0,
        total: 1,
        files: [
          {
            path: "src/auth/session.ts",
            patch: "@@ -1,2 +1,3 @@\n+verify token",
            additions: 1,
            deletions: 0,
          },
        ],
      },
      instructionText: "",
      memory: [],
      commentBudget: 5,
      priorThreads: [
        {
          id: "T1",
          needsVerdict: true,
          path: "src/auth/session.ts",
          line: 12,
          state: "open",
          title: "Verify token signature before issuing session",
          fingerprint: "src/auth/session.ts:12:security:verify_token",
        },
        {
          id: "T2",
          needsVerdict: false,
          path: "src/auth/session.ts",
          line: 30,
          state: "dismissed",
          title: "Consider caching the JWKS",
          fingerprint: "src/auth/session.ts:30:performance:cache_jwks",
          userReply: "Intentional — we want strict freshness.",
        },
        {
          id: "T3",
          needsVerdict: false,
          path: "src/auth/session.ts",
          line: 45,
          state: "resolved",
          title: "Use constant-time compare for tokens",
          fingerprint: "src/auth/session.ts:45:security:constant_time",
        },
        {
          id: "T4",
          needsVerdict: false,
          path: "src/auth/session.ts",
          line: 99,
          state: "stale",
          title: "Old finding on a line that is no longer in the diff",
          fingerprint: "src/auth/session.ts:99:style:foo",
        },
      ],
    });

    expect(prompt.user).toContain("Prior nitpickr threads on this PR:");
    expect(prompt.user).toContain(
      "open:\n- [T1] src/auth/session.ts:12 — Verify token signature before issuing session (verdict needed)",
    );
    expect(prompt.user).toContain(
      "dismissed:\n- [T2] src/auth/session.ts:30 — Consider caching the JWKS\n  user reply: Intentional — we want strict freshness.",
    );
    expect(prompt.user).toContain(
      "resolved:\n- [T3] src/auth/session.ts:45 — Use constant-time compare for tokens",
    );
    expect(prompt.user).toContain(
      "stale:\n- [T4] src/auth/session.ts:99 — Old finding on a line that is no longer in the diff",
    );
    expect(prompt.system).toContain(
      "do not re-raise findings represented by an open, resolved, or stale prior thread",
    );
    expect(prompt.system).toContain(
      "Stay consistent with prior recommendations",
    );
  });

  it("renders 'None' when prior threads is empty or omitted", () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({
      changeRequest: { title: "x", number: 1 },
      chunk: {
        index: 0,
        total: 1,
        files: [
          {
            path: "a.ts",
            patch: "@@ -1 +1 @@\n+x",
            additions: 1,
            deletions: 0,
          },
        ],
      },
      instructionText: "",
      memory: [],
      commentBudget: 1,
    });

    expect(prompt.user).toContain("Prior nitpickr threads on this PR:\nNone");
  });

  it("includes the full file at HEAD when fileContent is provided", () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({
      changeRequest: { title: "x", number: 2 },
      chunk: {
        index: 0,
        total: 1,
        files: [
          {
            path: "src/index.ts",
            patch: "@@ -1 +1,2 @@\n+console.log('hi')",
            additions: 1,
            deletions: 0,
            fileContent:
              "export const main = () => {\n  console.log('hi');\n};",
          },
        ],
      },
      instructionText: "",
      memory: [],
      commentBudget: 1,
    });

    expect(prompt.user).toContain(
      "Full file at HEAD (for context only — review against the patch):",
    );
    expect(prompt.user).toContain("export const main = () =>");
    expect(prompt.system).toContain(
      "every finding must still reference a line that appears in the patch",
    );
  });

  it("omits the file content block when fileContent is null or absent", () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({
      changeRequest: { title: "x", number: 3 },
      chunk: {
        index: 0,
        total: 1,
        files: [
          {
            path: "a.ts",
            patch: "@@ -1 +1 @@\n+x",
            additions: 1,
            deletions: 0,
            fileContent: null,
          },
        ],
      },
      instructionText: "",
      memory: [],
      commentBudget: 1,
    });

    expect(prompt.user).not.toContain("Full file at HEAD");
  });

  it("renders the review round and floor instructions in the prompt", () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({
      changeRequest: { title: "x", number: 1 },
      chunk: {
        index: 0,
        total: 1,
        files: [
          {
            path: "a.ts",
            patch: "@@ -1 +1 @@\n+x",
            additions: 1,
            deletions: 0,
          },
        ],
      },
      instructionText: "",
      memory: [],
      commentBudget: 1,
      priorReviewRoundCount: 3,
    });

    expect(prompt.user).toContain(
      "Review round: 3 (count of prior completed reviews on this PR)",
    );
    expect(prompt.system).toContain(
      "When 'Review round' is 2 or higher, only raise findings of severity 'medium' or above.",
    );
    expect(prompt.system).toContain(
      "When 'Review round' is 4 or higher, only raise findings of severity 'high' or 'critical'.",
    );
    expect(prompt.system).toContain(
      "intended behavior to prevent nit cascades",
    );
  });

  it("defaults review round to 0 when priorReviewRoundCount is omitted", () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({
      changeRequest: { title: "x", number: 2 },
      chunk: {
        index: 0,
        total: 1,
        files: [
          {
            path: "a.ts",
            patch: "@@ -1 +1 @@\n+x",
            additions: 1,
            deletions: 0,
          },
        ],
      },
      instructionText: "",
      memory: [],
      commentBudget: 1,
    });

    expect(prompt.user).toContain("Review round: 0");
  });

  it("rejects empty review chunks", () => {
    const builder = new PromptBuilder();

    expect(() =>
      builder.build({
        changeRequest: {
          title: "Improve queue fairness",
          number: 42,
        },
        chunk: {
          index: 0,
          total: 1,
          files: [],
        },
        instructionText: "strictness: balanced",
        memory: [],
        commentBudget: 5,
      }),
    ).toThrow(/chunk/i);
  });
});
