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

/** Twelve changed lines so findings can sit far apart (not collapsed). */
const wideFile = {
  path: "src/users.ts",
  patch: [
    "@@ -0,0 +1,12 @@",
    ...Array.from({ length: 12 }, (_, index) =>
      index === 1
        ? "+if (!user) return;"
        : index === 6 || index === 11
          ? "+deleteUser(user.id);"
          : `+const v${index} = ${index};`,
    ),
  ].join("\n"),
  fileContent: `${Array.from({ length: 12 }, (_, index) =>
    index === 1
      ? "if (!user) return;"
      : index === 6 || index === 11
        ? "deleteUser(user.id);"
        : `const v${index} = ${index};`,
  ).join("\n")}\n`,
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
      confidence: "high",
    });
    expect(
      decideVerification(
        { verdict: "refuted", quotedLines: [], refutationReason: " " },
        file,
      ).verdict,
    ).toBe("uncertain");
  });

  it("treats unparseable replies as unverified, not as evidence", () => {
    expect(decideVerification({ nope: true }, file).verdict).toBe("unverified");
  });

  it("accepts multi-line quotes with a line number on every line", () => {
    expect(
      decideVerification(
        {
          verdict: "confirmed",
          quotedLines: ["2: if (!user) return;\n3: deleteUser(user.id);"],
          failureScenario: "x",
          refutationReason: "",
          confidence: "high",
        },
        file,
      ).verdict,
    ).toBe("confirmed");
  });

  it("does not trust a refutation that quotes code that is not there", () => {
    expect(
      decideVerification(
        {
          verdict: "refuted",
          quotedLines: ["validateUser(user);"],
          failureScenario: "",
          refutationReason: "the caller validates the user",
          confidence: "high",
        },
        file,
      ).verdict,
    ).toBe("uncertain");
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
    const withRelated = buildVerifierPrompt(
      {
        path: "src/users.ts",
        line: 3,
        severity: "high",
        title: "Missing ownership check",
        body: "Any user can delete any account.",
      },
      file,
      [
        {
          path: "src/db/users.ts",
          startLine: 1,
          kind: "definition",
          symbol: "deleteUser",
          text: "1: export function deleteUser(id) {",
        },
      ],
    );
    expect(withRelated.user).toContain(
      "src/db/users.ts (definition of deleteUser):",
    );
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
            finding(7, "Real bug", "deleteUser(user.id);"),
            finding(2, "Wrong claim", "if (!user) return;"),
            finding(12, "Maybe bug", "deleteUser(user.id);"),
          ],
          priorThreadVerdicts: [],
        };
      },
    };

    const result = await new ReviewEngine(model, {
      verifier: { maxFindings: 6 },
    }).reviewWithDiagnostics({
      changeRequest: { title: "t", number: 1 },
      files: [{ ...wideFile, additions: 12, deletions: 0 }],
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

describe("ReviewEngine verifier outcomes", () => {
  const finding = (title: string, severity: string, line = 7) => ({
    path: "src/users.ts",
    line,
    findingType: "bug",
    severity,
    category: "security",
    title,
    evidence: "deleteUser(user.id);",
    failureScenario: "x",
    body: `${title}.`,
    fixPrompt: "In src/users.ts around line 3, fix.",
    suggestedChange: null,
  });

  it("keeps unverified findings at their severity and demotes refuted severe ones", async () => {
    const model: ReviewModel = {
      async generateStructuredReview(input) {
        if (input.jsonSchema?.name === "nitpickr_verification") {
          if (input.user.includes("Title: Verifier fails")) {
            throw new Error("timeout");
          }
          return {
            verdict: "refuted",
            quotedLines: ["if (!user) return;"],
            failureScenario: "",
            refutationReason: "guarded on line 2",
            confidence: "high",
          };
        }
        return {
          summary: "s",
          findings: [
            finding("Verifier fails", "medium"),
            finding("Refuted critical", "critical", 12),
          ],
          priorThreadVerdicts: [],
        };
      },
    };

    const result = await new ReviewEngine(model, {
      verifier: { maxFindings: 6 },
    }).reviewWithDiagnostics({
      changeRequest: { title: "t", number: 1 },
      files: [{ ...wideFile, additions: 12, deletions: 0 }],
      instructionText: "",
      memory: [],
      commentBudget: 5,
      severityFloor: "medium",
    });

    expect(
      result.result.findings.map((entry) => [entry.title, entry.severity]),
    ).toEqual([
      ["Refuted critical", "high"],
      ["Verifier fails", "medium"],
    ]);
  });
});

describe("collapseNearbyFindings", () => {
  it("keeps one finding per spot", async () => {
    const { collapseNearbyFindings } = await import(
      "../../src/review/review-engine.js"
    );
    const result = collapseNearbyFindings([
      { path: "a.ts", line: 10, title: "first" },
      { path: "a.ts", line: 12, title: "same spot" },
      { path: "a.ts", line: 30, title: "elsewhere" },
      { path: "b.ts", line: 11, title: "other file" },
    ]);
    expect(result.kept.map((entry) => entry.title)).toEqual([
      "first",
      "elsewhere",
      "other file",
    ]);
    expect(result.collapsed.map((entry) => entry.title)).toEqual(["same spot"]);
  });
});

describe("inline policy", () => {
  it("keeps only confirmed findings inline and lists the rest for a second look", async () => {
    const make = (title: string, line: number) => ({
      path: "src/users.ts",
      line,
      findingType: "bug",
      severity: "high",
      category: "security",
      title,
      evidence: "deleteUser(user.id);",
      failureScenario: "x",
      body: `${title}.`,
      fixPrompt: `In src/users.ts around line ${line}, fix.`,
      suggestedChange: null,
    });
    const model: ReviewModel = {
      async generateStructuredReview(input) {
        if (input.jsonSchema?.name === "nitpickr_verification") {
          return input.user.includes("Title: Confirmed one")
            ? {
                verdict: "confirmed",
                quotedLines: ["deleteUser(user.id);"],
                failureScenario: "any user deletes any account",
                refutationReason: "",
                confidence: "high",
              }
            : {
                verdict: "uncertain",
                quotedLines: [],
                failureScenario: "",
                refutationReason: "depends on caller",
                confidence: "low",
              };
        }
        return {
          summary: "s",
          findings: [make("Confirmed one", 7), make("Unconfirmed one", 12)],
          priorThreadVerdicts: [],
        };
      },
    };
    const result = await new ReviewEngine(model, {
      verifier: { maxFindings: 6 },
      inlinePolicy: "confirmed",
    }).reviewWithDiagnostics({
      changeRequest: { title: "t", number: 1 },
      files: [{ ...wideFile, additions: 12, deletions: 0 }],
      instructionText: "",
      memory: [],
      commentBudget: 5,
      severityFloor: "medium",
    });

    expect(result.result.findings.map((entry) => entry.title)).toEqual([
      "Confirmed one",
    ]);
    expect(result.result.secondLook?.map((entry) => entry.title)).toEqual([
      "Unconfirmed one",
    ]);
  });
});
