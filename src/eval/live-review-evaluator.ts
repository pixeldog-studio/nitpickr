import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import { dismissalThreshold } from "../memory/dismissal-policy.js";
import type { MemoryEmbedder } from "../memory/memory-service.js";
import type { ModelCompletionInfo } from "../review/chat-review-model.js";
import {
  ReviewEngine,
  type ReviewEngineInput,
  type ReviewEngineOptions,
  type ReviewFinding,
  type ReviewModel,
} from "../review/review-engine.js";
import {
  applySeverityFloor,
  severityFloorForRound,
} from "../review/severity-floor.js";

/**
 * Live-model review evaluation: runs real diffs through `ReviewEngine` against
 * a real (usually local) model and scores published findings against
 * hand-annotated expectations. Complements `ReviewEvaluator`, which replays
 * canned model output and never calls a model.
 */

const fileSchema = z.object({
  path: z.string().min(1),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().nullable(),
  fileContent: z.string().nullable().optional(),
});

const expectedFindingSchema = z.object({
  /** Short label used in reports, e.g. "off-by-one in pagination". */
  label: z.string().min(1),
  path: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive().optional(),
  category: z
    .enum([
      "correctness",
      "performance",
      "security",
      "maintainability",
      "testing",
      "style",
    ])
    .optional(),
});

const priorThreadSchema = z.object({
  id: z.string().min(1),
  needsVerdict: z.boolean(),
  path: z.string().min(1),
  line: z.number().int().positive(),
  state: z.enum(["open", "resolved", "dismissed", "stale"]),
  title: z.string().min(1),
  fingerprint: z.string().min(1),
  userReply: z.string().optional(),
});

const verdictSchema = z.enum(["fixed", "still_applies", "obsolete"]);

export const fixtureKinds = [
  "planted",
  "clean",
  "captured_bug",
  "captured_clean",
  "multi_round",
  "injection",
  /** Paired `<name>-control` / `<name>-applied` cases: same diff, with and without a repo learning in memory. */
  "learning",
] as const;
export const fixtureStacks = [
  "swift",
  "typescript",
  "python",
  "sql",
  "other",
] as const;

export const liveEvaluationFixtureSchema = z.object({
  name: z.string().min(1),
  /** Where the case came from (PR URL, "synthetic", ...). Informational. */
  source: z.string().optional(),
  kind: z.enum(fixtureKinds).default("planted"),
  stack: z.enum(fixtureStacks).default("other"),
  /** Expected verdicts for prior threads that need one (multi-round cases). */
  expectedVerdicts: z
    .array(z.object({ threadId: z.string().min(1), verdict: verdictSchema }))
    .default([]),
  input: z.object({
    changeRequest: z.object({
      title: z.string().min(1),
      number: z.number().int().positive(),
    }),
    files: z.array(fileSchema).min(1),
    contextFiles: z.array(fileSchema).optional(),
    instructionText: z.string().default(""),
    memory: z
      .array(
        z.object({ summary: z.string().min(1), path: z.string().optional() }),
      )
      .default([]),
    commentBudget: z.number().int().positive().default(10),
    scope: z.enum(["full_pr", "commit_delta"]).optional(),
    priorThreads: z.array(priorThreadSchema).optional(),
    /** Prior completed reviews; drives the round-aware severity floor. */
    priorReviewRoundCount: z.number().int().nonnegative().default(0),
    /**
     * Findings this repo dismissed before (thumbs-down, resolved without a
     * change). With an embedder configured the eval runs the production
     * dismissal filter against them.
     */
    dismissals: z
      .array(
        z.object({
          title: z.string().min(1),
          body: z.string(),
          path: z.string().nullable().default(null),
          category: z.string().nullable().default(null),
        }),
      )
      .default([]),
  }),
  /** Ground truth. Empty array = a clean change where any finding is a false positive. */
  expectedFindings: z.array(expectedFindingSchema),
});

export type LiveEvaluationFixture = z.infer<typeof liveEvaluationFixtureSchema>;
export type ExpectedFinding = z.infer<typeof expectedFindingSchema>;

/** Lines of slack when matching a published finding to an expectation. */
export const LINE_MATCH_TOLERANCE = 2;

/** A published finding the owner would call a nitpick: low or style. */
export function isNit(finding: Pick<ReviewFinding, "severity" | "category">) {
  return finding.severity === "low" || finding.category === "style";
}

function isMediumPlus(finding: Pick<ReviewFinding, "severity">) {
  return finding.severity !== "low";
}

export interface LiveCaseReport {
  name: string;
  source: string | null;
  kind: (typeof fixtureKinds)[number];
  stack: (typeof fixtureStacks)[number];
  /** Matched findings of medium+ severity, and all medium+ published. */
  matchedMediumPlus: number;
  publishedMediumPlus: number;
  nitCount: number;
  verdictsExpected: number;
  verdictsCorrect: number;
  /** Expectations matched by inline or second-look findings. */
  matchedIncludingSecondLook?: number;
  secondLook?: Array<
    Pick<ReviewFinding, "path" | "line" | "severity" | "category" | "title"> &
      Partial<
        Pick<
          ReviewFinding,
          "findingType" | "body" | "fixPrompt" | "verification"
        >
      >
  >;
  durationMs: number;
  modelCalls: number;
  promptTokens: number | null;
  completionTokens: number | null;
  estimatedPromptTokens: number;
  chunkCount: number;
  precision: number;
  recall: number;
  matched: Array<{ expected: string; finding: string }>;
  missed: string[];
  unexpected: string[];
  summary: string;
  findings: Array<
    Pick<
      ReviewFinding,
      | "path"
      | "line"
      | "severity"
      | "category"
      | "findingType"
      | "title"
      | "body"
      | "verification"
    > &
      Partial<Pick<ReviewFinding, "fixPrompt" | "failureScenario">>
  >;
  error: string | null;
}

export interface LiveEvaluationTotals {
  cases: number;
  failedCases: number;
  expected: number;
  matched: number;
  published: number;
  unexpected: number;
  precision: number;
  recall: number;
  /** Precision over medium+ findings only (the goal's headline number). */
  precisionMediumPlus: number;
  /** Recall when the summary's "worth a second look" list counts too. */
  recallIncludingSecondLook: number;
  nitCount: number;
  /** Findings published on cases that expect none. */
  cleanCaseFalsePositives: number;
  verdictAccuracy: number | null;
  medianCaseMs: number;
  durationMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface LiveEvaluationReport {
  cases: LiveCaseReport[];
  totals: LiveEvaluationTotals & {
    byStack: Record<string, LiveEvaluationTotals>;
    byKind: Record<string, LiveEvaluationTotals>;
  };
}

/** Collects usage from `ChatReviewModel.onCompletion` between `take()` calls. */
export class UsageTracker {
  #calls = 0;
  #promptTokens = 0;
  #completionTokens = 0;
  #sawUsage = false;

  readonly onCompletion = (info: ModelCompletionInfo): void => {
    this.#calls += 1;
    if (
      info.promptTokens !== undefined ||
      info.completionTokens !== undefined
    ) {
      this.#sawUsage = true;
      this.#promptTokens += info.promptTokens ?? 0;
      this.#completionTokens += info.completionTokens ?? 0;
    }
  };

  take(): {
    calls: number;
    promptTokens: number | null;
    completionTokens: number | null;
  } {
    const snapshot = {
      calls: this.#calls,
      promptTokens: this.#sawUsage ? this.#promptTokens : null,
      completionTokens: this.#sawUsage ? this.#completionTokens : null,
    };
    this.#calls = 0;
    this.#promptTokens = 0;
    this.#completionTokens = 0;
    this.#sawUsage = false;
    return snapshot;
  }
}

export async function loadLiveEvaluationFixtures(
  directory: string,
): Promise<LiveEvaluationFixture[]> {
  const entries = await readdir(directory);
  return Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map(async (entry) =>
        liveEvaluationFixtureSchema.parse(
          JSON.parse(await readFile(join(directory, entry), "utf8")),
        ),
      ),
  );
}

export function matchFindings(
  findings: ReviewFinding[],
  expected: ExpectedFinding[],
): {
  matched: Array<{ expected: ExpectedFinding; finding: ReviewFinding }>;
  missed: ExpectedFinding[];
  unexpected: ReviewFinding[];
} {
  const remaining = new Set(findings);
  const matched: Array<{ expected: ExpectedFinding; finding: ReviewFinding }> =
    [];
  const missed: ExpectedFinding[] = [];

  for (const expectation of expected) {
    const lineStart = expectation.lineStart - LINE_MATCH_TOLERANCE;
    const lineEnd =
      (expectation.lineEnd ?? expectation.lineStart) + LINE_MATCH_TOLERANCE;
    const candidate = [...remaining].find(
      (finding) =>
        finding.path === expectation.path &&
        finding.line >= lineStart &&
        finding.line <= lineEnd &&
        (expectation.category === undefined ||
          finding.category === expectation.category),
    );
    if (candidate) {
      remaining.delete(candidate);
      matched.push({ expected: expectation, finding: candidate });
    } else {
      missed.push(expectation);
    }
  }

  return { matched, missed, unexpected: [...remaining] };
}

function describeFinding(finding: ReviewFinding): string {
  return `${finding.path}:${finding.line} [${finding.severity}/${finding.category}] ${finding.title}`;
}

function describeExpected(expected: ExpectedFinding): string {
  const range =
    expected.lineEnd && expected.lineEnd !== expected.lineStart
      ? `${expected.lineStart}-${expected.lineEnd}`
      : `${expected.lineStart}`;
  return `${expected.path}:${range} ${expected.label}`;
}

const TRANSPORT_ERROR_PATTERN =
  /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|other side closed|status 5\d\d/i;

export function isTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : "";
  return TRANSPORT_ERROR_PATTERN.test(`${message} ${cause}`);
}

export interface LiveReviewEvaluatorOptions {
  model: ReviewModel;
  usage?: UsageTracker;
  engineOptions?: ReviewEngineOptions;
  /** Embeds findings and dismissals to exercise the dismissal filter. */
  embedder?: MemoryEmbedder;
  /**
   * Wait before retrying a case once after a transport failure (the model
   * server restarted or dropped the connection). Default 15 s.
   */
  transportRetryDelayMs?: number;
  /** Reports from an earlier, interrupted run; those cases are not rerun. */
  completedCases?: LiveCaseReport[];
  onCaseStart?: (fixture: LiveEvaluationFixture, index: number) => void;
  /** Awaited, so callers can persist progress after every case. */
  onCaseDone?: (
    report: LiveCaseReport,
    index: number,
    casesSoFar: LiveCaseReport[],
  ) => void | Promise<void>;
}

export class LiveReviewEvaluator {
  readonly #options: LiveReviewEvaluatorOptions;

  constructor(options: LiveReviewEvaluatorOptions) {
    this.#options = options;
  }

  async evaluate(
    fixtures: LiveEvaluationFixture[],
  ): Promise<LiveEvaluationReport> {
    const engine = new ReviewEngine(
      this.#options.model,
      this.#options.engineOptions ?? {},
    );
    const cases: LiveCaseReport[] = [];
    const completed = new Map(
      (this.#options.completedCases ?? []).map((entry) => [entry.name, entry]),
    );

    for (const [index, fixture] of fixtures.entries()) {
      const previous = completed.get(fixture.name);
      if (previous) {
        cases.push(previous);
        continue;
      }
      this.#options.onCaseStart?.(fixture, index);
      const report = await this.#evaluateCase(engine, fixture);
      cases.push(report);
      await this.#options.onCaseDone?.(report, index, cases);
    }

    return { cases, totals: summarizeReport(cases) };
  }

  /** The production dismissal filter over the fixture's dismissals. */
  async #dismissalCheck(
    fixture: LiveEvaluationFixture,
  ): Promise<((finding: ReviewFinding) => Promise<string | null>) | null> {
    const embedder = this.#options.embedder;
    if (!embedder || fixture.input.dismissals.length === 0) {
      return null;
    }
    const dismissed = await Promise.all(
      fixture.input.dismissals.map(async (entry) => ({
        ...entry,
        vector: await embedder.embed(
          `${entry.title}. ${entry.body}`,
          "document",
        ),
      })),
    );
    return async (finding) => {
      const vector = await embedder.embed(
        `${finding.title}. ${finding.body}`,
        "document",
      );
      for (const entry of dismissed) {
        const similarity = cosineSimilarity(vector, entry.vector);
        const threshold = dismissalThreshold(finding, {
          path: entry.path,
          category: entry.category ?? null,
        });
        if (threshold !== null && similarity >= threshold) {
          return `${entry.title} (similarity ${similarity.toFixed(2)})`;
        }
      }
      return null;
    };
  }

  async #evaluateCase(
    engine: ReviewEngine,
    fixture: LiveEvaluationFixture,
  ): Promise<LiveCaseReport> {
    // Reset on a transport retry so latency measures the successful run.
    let startedAt = process.hrtime.bigint();
    const elapsedMs = () =>
      Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    this.#options.usage?.take();

    const base = {
      name: fixture.name,
      source: fixture.source ?? null,
      kind: fixture.kind,
      stack: fixture.stack,
      verdictsExpected: fixture.expectedVerdicts.length,
    };

    try {
      // Mirrors the worker: automatic-trigger publishable types, the
      // round-aware floor, then the floor again after the engine (a no-op
      // when the engine already applies it; the worker did this before).
      const severityFloor = severityFloorForRound(
        fixture.input.priorReviewRoundCount,
      );
      const dismissalCheck = await this.#dismissalCheck(fixture);
      const run = () =>
        engine.reviewWithDiagnostics({
          ...(fixture.input as ReviewEngineInput),
          publishableFindingTypes: ["bug", "safe_suggestion"],
          severityFloor,
          ...(dismissalCheck ? { dismissalCheck } : {}),
        });
      let diagnostics: Awaited<ReturnType<typeof run>>;
      try {
        diagnostics = await run();
      } catch (error) {
        // Infrastructure noise (model server restarts) must not be scored
        // as a review failure; retry such a case once.
        if (!isTransportError(error)) {
          throw error;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, this.#options.transportRetryDelayMs ?? 15_000),
        );
        this.#options.usage?.take();
        startedAt = process.hrtime.bigint();
        diagnostics = await run();
      }
      const usage = this.#options.usage?.take();
      const findings = applySeverityFloor(diagnostics.result, severityFloor)
        .kept.findings;
      const { matched, missed, unexpected } = matchFindings(
        findings,
        fixture.expectedFindings,
      );
      const secondLook = diagnostics.result.secondLook ?? [];
      const withSecondLook = matchFindings(
        [...findings, ...secondLook],
        fixture.expectedFindings,
      );
      const verdicts = new Map(
        (
          (
            diagnostics.result as {
              priorThreadVerdicts?: Array<{
                threadId: string;
                verdict: string;
              }>;
            }
          ).priorThreadVerdicts ?? []
        ).map((entry) => [entry.threadId, entry.verdict]),
      );

      return {
        ...base,
        matchedMediumPlus: matched.filter((entry) =>
          isMediumPlus(entry.finding),
        ).length,
        publishedMediumPlus: findings.filter(isMediumPlus).length,
        nitCount: findings.filter(isNit).length,
        matchedIncludingSecondLook: withSecondLook.matched.length,
        secondLook: secondLook.map((finding) => ({
          path: finding.path,
          line: finding.line,
          severity: finding.severity,
          category: finding.category,
          findingType: finding.findingType,
          title: finding.title,
          body: finding.body,
          fixPrompt: finding.fixPrompt,
          ...(finding.verification
            ? { verification: finding.verification }
            : {}),
        })),
        verdictsCorrect: fixture.expectedVerdicts.filter(
          (entry) => verdicts.get(entry.threadId) === entry.verdict,
        ).length,
        durationMs: elapsedMs(),
        modelCalls:
          usage?.calls ?? diagnostics.promptUsage.afterCompaction.chunkCount,
        promptTokens: usage?.promptTokens ?? null,
        completionTokens: usage?.completionTokens ?? null,
        estimatedPromptTokens:
          diagnostics.promptUsage.afterCompaction.estimatedPromptTokens,
        chunkCount: diagnostics.promptUsage.afterCompaction.chunkCount,
        precision: findings.length === 0 ? 1 : matched.length / findings.length,
        recall:
          fixture.expectedFindings.length === 0
            ? 1
            : matched.length / fixture.expectedFindings.length,
        matched: matched.map((entry) => ({
          expected: describeExpected(entry.expected),
          finding: describeFinding(entry.finding),
        })),
        missed: missed.map(describeExpected),
        unexpected: unexpected.map(describeFinding),
        summary: diagnostics.result.summary,
        findings: findings.map((finding) => ({
          path: finding.path,
          line: finding.line,
          severity: finding.severity,
          category: finding.category,
          findingType: finding.findingType,
          title: finding.title,
          body: finding.body,
          // Kept so a voice sample shows what was really posted.
          fixPrompt: finding.fixPrompt,
          ...(finding.failureScenario
            ? { failureScenario: finding.failureScenario }
            : {}),
          ...(finding.verification
            ? { verification: finding.verification }
            : {}),
        })),
        error: null,
      };
    } catch (error) {
      const usage = this.#options.usage?.take();
      return {
        ...base,
        matchedMediumPlus: 0,
        publishedMediumPlus: 0,
        nitCount: 0,
        verdictsCorrect: 0,
        durationMs: elapsedMs(),
        modelCalls: usage?.calls ?? 0,
        promptTokens: usage?.promptTokens ?? null,
        completionTokens: usage?.completionTokens ?? null,
        estimatedPromptTokens: 0,
        chunkCount: 0,
        precision: 0,
        recall: 0,
        matched: [],
        missed: fixture.expectedFindings.map(describeExpected),
        unexpected: [],
        summary: "",
        findings: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/**
 * Re-score a saved report against the current fixture labels without
 * calling the model: used after adjudicating "unexpected" findings so the
 * baseline and a branch are compared with the same labels.
 */
export function rescoreReport(
  report: Pick<LiveEvaluationReport, "cases">,
  fixtures: LiveEvaluationFixture[],
): LiveEvaluationReport {
  const byName = new Map(fixtures.map((fixture) => [fixture.name, fixture]));
  const cases = report.cases.flatMap((entry) => {
    const fixture = byName.get(entry.name);
    if (!fixture) {
      return [];
    }
    const findings = entry.findings as ReviewFinding[];
    const { matched, missed, unexpected } = matchFindings(
      findings,
      fixture.expectedFindings,
    );
    const withSecondLook = matchFindings(
      [...findings, ...((entry.secondLook ?? []) as ReviewFinding[])],
      fixture.expectedFindings,
    );
    const rescored: LiveCaseReport = {
      ...entry,
      matchedIncludingSecondLook: withSecondLook.matched.length,
      kind: fixture.kind,
      stack: fixture.stack,
      matched: matched.map((item) => ({
        expected: describeExpected(item.expected),
        finding: describeFinding(item.finding),
      })),
      missed:
        entry.error === null ? missed.map(describeExpected) : entry.missed,
      unexpected: unexpected.map(describeFinding),
      matchedMediumPlus: matched.filter((item) => isMediumPlus(item.finding))
        .length,
      precision: findings.length === 0 ? 1 : matched.length / findings.length,
      recall:
        fixture.expectedFindings.length === 0
          ? 1
          : matched.length / fixture.expectedFindings.length,
    };
    return [rescored];
  });
  return { cases, totals: summarizeReport(cases) };
}

export interface LearningPairReport {
  name: string;
  control: { passed: boolean; findings: number };
  applied: { passed: boolean; findings: number };
  /** The learning changed the review and the applied case meets expectations. */
  learningApplied: boolean;
}

function casePassed(entry: LiveCaseReport): boolean {
  return (
    entry.error === null &&
    entry.missed.length === 0 &&
    entry.unexpected.length === 0
  );
}

/** Compare each `-control` case with its `-applied` twin. */
export function summarizeLearningPairs(
  cases: LiveCaseReport[],
): LearningPairReport[] {
  return cases.flatMap((control) => {
    if (control.kind !== "learning" || !control.name.endsWith("-control")) {
      return [];
    }
    const name = control.name.slice(0, -"-control".length);
    const applied = cases.find((entry) => entry.name === `${name}-applied`);
    if (!applied) {
      return [];
    }
    // Learning applied: the control raised the issue (inline or for a
    // second look) and, with the learning, nothing is raised at those
    // spots. The verifier sends many findings to the second-look list, so
    // counting inline findings only would miss the effect. An errored case
    // has no findings, which would look like a change.
    const raised = (entry: LiveCaseReport) => [
      ...entry.findings,
      ...((entry.secondLook ?? []) as Array<{ path: string; line: number }>),
    ];
    const controlSpots = raised(control);
    const stillRaised = raised(applied).some((finding) =>
      controlSpots.some(
        (spot) =>
          spot.path === finding.path && Math.abs(spot.line - finding.line) <= 3,
      ),
    );
    const changed =
      control.error === null &&
      applied.error === null &&
      (control.matchedIncludingSecondLook ?? control.matched.length) > 0 &&
      !stillRaised;
    return [
      {
        name,
        control: {
          passed: casePassed(control),
          findings: control.findings.length,
        },
        applied: {
          passed: casePassed(applied),
          findings: applied.findings.length,
        },
        learningApplied: changed,
      },
    ];
  });
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm === 0 || rightNorm === 0
    ? 0
    : dot / Math.sqrt(leftNorm * rightNorm);
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function sum(cases: LiveCaseReport[], pick: (entry: LiveCaseReport) => number) {
  return cases.reduce((total, entry) => total + pick(entry), 0);
}

/**
 * Ratios use only cases that completed: a failed case has no findings, so
 * counting it would make precision and false positives look better during a
 * model-server outage. `failedCases` reports how many were left out.
 */
export function summarizeCases(
  allCases: LiveCaseReport[],
): LiveEvaluationTotals {
  const cases = allCases.filter((entry) => entry.error === null);
  const expected = sum(
    cases,
    (entry) => entry.matched.length + entry.missed.length,
  );
  const matched = sum(cases, (entry) => entry.matched.length);
  const published = sum(cases, (entry) => entry.findings.length);
  const matchedMediumPlus = sum(cases, (entry) => entry.matchedMediumPlus);
  const publishedMediumPlus = sum(cases, (entry) => entry.publishedMediumPlus);
  const verdictsExpected = sum(cases, (entry) => entry.verdictsExpected);
  const sawTokens = cases.some((entry) => entry.promptTokens !== null);
  return {
    cases: allCases.length,
    failedCases: allCases.length - cases.length,
    expected,
    matched,
    published,
    unexpected: sum(cases, (entry) => entry.unexpected.length),
    precision: published === 0 ? 1 : matched / published,
    recall: expected === 0 ? 1 : matched / expected,
    precisionMediumPlus:
      publishedMediumPlus === 0 ? 1 : matchedMediumPlus / publishedMediumPlus,
    recallIncludingSecondLook:
      expected === 0
        ? 1
        : sum(
            cases,
            (entry) => entry.matchedIncludingSecondLook ?? entry.matched.length,
          ) / expected,
    nitCount: sum(cases, (entry) => entry.nitCount),
    cleanCaseFalsePositives: sum(cases, (entry) =>
      entry.matched.length + entry.missed.length === 0
        ? entry.findings.length
        : 0,
    ),
    verdictAccuracy:
      verdictsExpected === 0
        ? null
        : sum(cases, (entry) => entry.verdictsCorrect) / verdictsExpected,
    medianCaseMs: median(cases.map((entry) => entry.durationMs)),
    durationMs: sum(cases, (entry) => entry.durationMs),
    promptTokens: sawTokens
      ? sum(cases, (entry) => entry.promptTokens ?? 0)
      : null,
    completionTokens: sawTokens
      ? sum(cases, (entry) => entry.completionTokens ?? 0)
      : null,
  };
}

function groupBy(
  cases: LiveCaseReport[],
  key: (entry: LiveCaseReport) => string,
): Record<string, LiveEvaluationTotals> {
  const groups = new Map<string, LiveCaseReport[]>();
  for (const entry of cases) {
    groups.set(key(entry), [...(groups.get(key(entry)) ?? []), entry]);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, group]) => [name, summarizeCases(group)]),
  );
}

export function summarizeReport(
  cases: LiveCaseReport[],
): LiveEvaluationReport["totals"] {
  return {
    ...summarizeCases(cases),
    byStack: groupBy(cases, (entry) => entry.stack),
    byKind: groupBy(cases, (entry) => entry.kind),
  };
}
