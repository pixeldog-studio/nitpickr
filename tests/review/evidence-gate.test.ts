import { describe, expect, it } from "vitest";

import { gateAndRankFindings } from "../../src/review/evidence-gate.js";

describe("gateAndRankFindings", () => {
  it("suppresses findings when matching suppressing feedback exists", () => {
    const result = gateAndRankFindings({
      findings: [
        {
          path: "src/api/server.ts",
          line: 12,
          findingType: "bug",
          severity: "high",
          category: "correctness",
          title: "Guard malformed JSON",
        },
      ],
      files: [
        {
          path: "src/api/server.ts",
          patch: "@@ -10,1 +10,2 @@\n context\n+guard",
        },
      ],
      feedbackSignals: [
        {
          path: "src/api/server.ts",
          category: "correctness",
          findingType: "bug",
          score: -2,
          suppress: true,
        },
      ],
      publishableFindingTypes: ["bug"],
    });

    expect(result.acceptedFindings).toEqual([]);
    expect(result.rejectedFindings).toEqual([
      expect.objectContaining({
        reasons: ["suppressed_by_feedback"],
      }),
    ]);
  });

  it("rejects findings that repeat a still-open thread", () => {
    const finding = (line: number, title: string) => ({
      path: "src/users.ts",
      line,
      findingType: "bug",
      severity: "high" as const,
      category: "correctness",
      title,
    });
    const result = gateAndRankFindings({
      findings: [finding(11, "Missing timeout"), finding(30, "Other bug")],
      files: [
        {
          path: "src/users.ts",
          patch: "@@ -8,1 +8,30 @@\n+changed",
        },
      ],
      openThreads: [
        { path: "src/users.ts", line: 10, category: "correctness" },
      ],
    });

    expect(result.acceptedFindings.map((entry) => entry.title)).toEqual([
      "Other bug",
    ]);
    expect(result.rejectedFindings[0]?.reasons).toEqual([
      "duplicates_open_thread",
    ]);
  });

  it("keeps a different-category finding next to an open thread", () => {
    const result = gateAndRankFindings({
      findings: [
        {
          path: "src/users.ts",
          line: 11,
          findingType: "bug",
          severity: "critical",
          category: "security",
          title: "SQL injection",
        },
      ],
      files: [{ path: "src/users.ts", patch: "@@ -8,1 +8,30 @@\n+changed" }],
      openThreads: [
        { path: "src/users.ts", line: 10, category: "maintainability" },
      ],
    });

    expect(result.acceptedFindings).toHaveLength(1);
  });

  it("keeps no-hunk patches eligible for later targeting", () => {
    const result = gateAndRankFindings({
      findings: [
        {
          path: "src/api/server.ts",
          line: 200,
          findingType: "bug",
          severity: "medium",
          category: "maintainability",
          title: "Clarify binary diff handling",
        },
      ],
      files: [
        {
          path: "src/api/server.ts",
          patch: "Binary files differ",
        },
      ],
      publishableFindingTypes: ["bug"],
    });

    expect(result.acceptedFindings).toHaveLength(1);
    expect(result.rejectedFindings).toEqual([]);
  });
});
