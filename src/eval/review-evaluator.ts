import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { fingerprintFinding } from "../review/finding-fingerprint.js";
import {
  ReviewEngine,
  type ReviewEngineInput,
  type ReviewModel,
} from "../review/review-engine.js";

const evaluationFixtureSchema = z.object({
  name: z.string().min(1),
  input: z.object({
    changeRequest: z.object({
      title: z.string().min(1),
      number: z.number().int().positive(),
    }),
    files: z.array(
      z.object({
        path: z.string().min(1),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        patch: z.string().nullable(),
      }),
    ),
    contextFiles: z
      .array(
        z.object({
          path: z.string().min(1),
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative(),
          patch: z.string().nullable(),
        }),
      )
      .optional(),
    instructionText: z.string(),
    memory: z.array(
      z.object({
        summary: z.string().min(1),
        path: z.string().optional(),
      }),
    ),
    commentBudget: z.number().int().positive(),
  }),
  chunkResponses: z.array(z.unknown()).min(1),
  expectations: z.object({
    publishedFingerprints: z.array(z.string().min(1)),
    suppressedFingerprints: z.array(z.string().min(1)),
  }),
  reactionFeedback: z.array(
    z.object({
      providerCommentId: z.string().min(1),
      fingerprint: z.string().min(1),
      polarity: z.enum(["positive", "negative"]),
    }),
  ),
});

export type ReviewEvaluationFixture = z.infer<typeof evaluationFixtureSchema>;

export interface ReviewEvaluationCaseReport {
  name: string;
  publishedFingerprints: string[];
  suppressedFingerprints: string[];
  unexpectedPublishedFingerprints: string[];
  missedExpectedFingerprints: string[];
  precision: number;
}

export interface ReviewEvaluationReport {
  fixtures: ReviewEvaluationCaseReport[];
  metrics: {
    precision: number;
    duplicateRate: number;
    staleRateProxy: number;
    negativeReactionRate: number;
    commentCountPerReview: number;
    suggestionEligibilityRate: number;
  };
}

class FixtureReviewModel implements ReviewModel {
  readonly #chunkResponses: unknown[];

  constructor(chunkResponses: unknown[]) {
    this.#chunkResponses = [...chunkResponses];
  }

  async generateStructuredReview(): Promise<unknown> {
    return (
      this.#chunkResponses.shift() ?? {
        summary: "No findings.",
        mermaid: "flowchart TD\nA[Change] --> B[Reviewed]",
        findings: [],
      }
    );
  }
}

export async function loadReviewEvaluationFixtures(
  directory: string,
): Promise<ReviewEvaluationFixture[]> {
  const entries = await readdir(directory);

  return Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map(async (entry) =>
        evaluationFixtureSchema.parse(
          JSON.parse(await readFile(join(directory, entry), "utf8")),
        ),
      ),
  );
}

export class ReviewEvaluator {
  async evaluate(
    fixtures: ReviewEvaluationFixture[],
  ): Promise<ReviewEvaluationReport> {
    const reports: ReviewEvaluationCaseReport[] = [];
    let totalPublished = 0;
    let totalCorrectPublished = 0;
    let totalUnexpectedPublished = 0;
    let totalDuplicates = 0;
    let totalSuggestions = 0;
    let totalReactionFeedback = 0;
    let totalNegativeReactionFeedback = 0;

    for (const fixture of fixtures) {
      // Canned responses predate the evidence field; replay scores ranking,
      // dedupe and gating, while the evidence gate has its own unit tests.
      const engine = new ReviewEngine(
        new FixtureReviewModel(fixture.chunkResponses),
        { requireEvidence: false },
      );
      const diagnostics = await engine.reviewWithDiagnostics({
        ...(fixture.input as ReviewEngineInput),
        publishableFindingTypes: ["bug", "safe_suggestion"],
      });

      const publishedFingerprints = diagnostics.result.findings
        .map((finding) => fingerprintFinding(finding))
        .sort();
      const suppressedFingerprints = diagnostics.rejectedFindings
        .map((finding) => finding.findingFingerprint)
        .sort();
      const expectedPublished = new Set(
        fixture.expectations.publishedFingerprints,
      );
      const unexpectedPublishedFingerprints = publishedFingerprints.filter(
        (fingerprint) => !expectedPublished.has(fingerprint),
      );
      const missedExpectedFingerprints =
        fixture.expectations.publishedFingerprints.filter(
          (fingerprint) => !publishedFingerprints.includes(fingerprint),
        );
      const precision =
        publishedFingerprints.length === 0
          ? 1
          : (publishedFingerprints.length -
              unexpectedPublishedFingerprints.length) /
            publishedFingerprints.length;

      reports.push({
        name: fixture.name,
        publishedFingerprints,
        suppressedFingerprints,
        unexpectedPublishedFingerprints,
        missedExpectedFingerprints,
        precision,
      });

      totalPublished += publishedFingerprints.length;
      totalCorrectPublished +=
        publishedFingerprints.length - unexpectedPublishedFingerprints.length;
      totalUnexpectedPublished += unexpectedPublishedFingerprints.length;
      totalDuplicates +=
        publishedFingerprints.length - new Set(publishedFingerprints).size;
      totalSuggestions += diagnostics.result.findings.filter(
        (finding) => finding.suggestedChange !== undefined,
      ).length;
      totalReactionFeedback += fixture.reactionFeedback.length;
      totalNegativeReactionFeedback += fixture.reactionFeedback.filter(
        (feedback) => feedback.polarity === "negative",
      ).length;
    }

    return {
      fixtures: reports,
      metrics: {
        precision:
          totalPublished === 0 ? 1 : totalCorrectPublished / totalPublished,
        duplicateRate:
          totalPublished === 0 ? 0 : totalDuplicates / totalPublished,
        staleRateProxy:
          totalPublished === 0 ? 0 : totalUnexpectedPublished / totalPublished,
        negativeReactionRate:
          totalReactionFeedback === 0
            ? 0
            : totalNegativeReactionFeedback / totalReactionFeedback,
        commentCountPerReview:
          fixtures.length === 0 ? 0 : totalPublished / fixtures.length,
        suggestionEligibilityRate:
          totalPublished === 0 ? 0 : totalSuggestions / totalPublished,
      },
    };
  }
}
