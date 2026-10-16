import { describe, expect, it } from "vitest";

import {
  buildVerifierPrompt,
  decideVerification,
  downgradeSeverity,
} from "../../src/review/finding-verifier.js";
import {
  ReviewEngine,
  type ReviewModel,
} from "../../src/review/review-engine.js";

const file = {
  path: "src/users.ts",
  patch:
    "@@ -1,2 +1,3 @@\n const a = 1;\n+if (!user) return;\n+deleteUser(user.id);",
  fileContent: "const a = 1;\nif (!user) return;\ndeleteUser(user.id);\n",
};

describe("decideVerification", () => {
  it("confirms only when the quoted lines exist in the code", () => {
    expect(
      decideVerification(
        {
          verdict: "confirmed",
          quotedLines: ["deleteUser(user.id);"],
          failureScenario: "any user deletes any account",
          refutationReason: "",
          confidence: "high",
        },
        file,
      ).verdict,
    ).toBe("confirmed");
    expect(
      decideVerification(
        {
          verdict: "confirmed",
          quotedLines: ["db.drop()"],
          failureScenario: "x",
          refutationReason: "",
          confidence: "high",
        },
        file,
      ).verdict,
    ).toBe("uncertain");
  });

  it("accepts quotes carrying the prompt's line-number prefix", () => {
    expect(
      decideVerification(
        {
          verdict: "confirmed",
          quotedLines: ["3: deleteUser(user.id);"],
          failureScenario: "x",
          refutationReason: "",
          confidence: "medium",
        },
        file,
      ).verdict,
    ).toBe("confirmed");
  });

  it("trusts a refutation only when it gives a reason", () => {
    const refuted = decideVerification(
      {
        verdict: "refuted",
        quotedLines: ["if (!user) return;"],
        failureScenario: "",
        refutationReason: "line 2 returns early when user is missing",
        confidence: "high",
      },
      file,
    );
    expect(refuted).toEqual({
      verdict: "refuted",
      reason: "line 2 returns early when user is missing",
    });
    expect(
      decideVerification(
        { verdict: "refuted", quotedLines: [], refutationReason: " " },
        file,
      ).verdict,
    ).toBe("uncertain");
  });

  it("treats unparseable replies as uncertain", () => {
    expect(decideVerification({ nope: true }, file).verdict).toBe("uncertain");
  });
});

describe("verifier helpers", () => {
  it("downgrades one severity level", () => {
    expect(downgradeSeverity("critical")).toBe("high");
    expect(downgradeSeverity("medium")).toBe("low");
    expect(downgradeSeverity("low")).toBe("low");
  });

  it("does not show the reviewer's fix prompt or failure scenario", () => {
    const prompt = buildVerifierPrompt(
      {
        path: "src/users.ts",
        line: 3,
        severity: "high",
        title: "Missing ownership check",
        body: "Any user can delete any account.",
      },
      file,
    );
    expect(prompt.user).toContain("Claim: Any user can delete any account.");
    expect(prompt.user).toContain("3: deleteUser(user.id);");
    expect(prompt.system).toContain("verdict first");
  });
});

describe("ReviewEngine with the verifier", () => {
  it("keeps confirmed, drops refuted, downgrades uncertain below the floor", async () => {
    const finding = (line: number, title: string, evidence: string) => ({
      path: "src/users.ts",
      line,
      findingType: "bug",
      severity: "medium",
      category: "correctness",
      title,
      evidence,
      failureScenario: "x",
      body: `${title}.`,
      fixPrompt: `In src/users.ts around line ${line}, fix.`,
      suggestedChange: null,
    });
    const verdicts: Record<string, unknown> = {
      "Real bug": {
        verdict: "confirmed",
        quotedLines: ["deleteUser(user.id);"],
        failureScenario: "any user deletes any account",
        refutationReason: "",
        confidence: "high",
      },
      "Wrong claim": {
        verdict: "refuted",
        quotedLines: ["if (!user) return;"],
        failureScenario: "",
        refutationReason: "guarded on line 2",
        confidence: "high",
      },
      "Maybe bug": {
        verdict: "uncertain",
        quotedLines: [],
        failureScenario: "",
        refutationReason: "depends on caller",
        confidence: "low",
      },
    };
    const model: ReviewModel = {
      async generateStructuredReview(input) {
        if (input.jsonSchema?.name === "nitpickr_verification") {
          const title = /Title: (.*)/.exec(input.user)?.[1] ?? "";
          return verdicts[title];
        }
        return {
          summary: "s",
          findings: [
            finding(3, "Real bug", "deleteUser(user.id);"),
            finding(2, "Wrong claim", "if (!user) return;"),
            finding(3, "Maybe bug", "deleteUser(user.id);"),
          ],
          priorThreadVerdicts: [],
        };
      },
    };

    const result = await new ReviewEngine(model, {
      verifier: { maxFindings: 6 },
    }).reviewWithDiagnostics({
      changeRequest: { title: "t", number: 1 },
      files: [{ ...file, additions: 2, deletions: 0 }],
      instructionText: "",
      memory: [],
      commentBudget: 5,
      severityFloor: "medium",
    });

    expect(result.result.findings.map((entry) => entry.title)).toEqual([
      "Real bug",
    ]);
    expect(
      result.rejectedFindings.map((entry) => [
        entry.finding.title,
        entry.reasons[0],
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["Wrong claim", "refuted_by_verifier"],
        ["Maybe bug", "unconfirmed_below_floor"],
      ]),
    );
  });
});
