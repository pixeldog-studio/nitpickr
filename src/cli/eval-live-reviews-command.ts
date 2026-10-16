import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ReasoningEffort } from "../config/app-config.js";
import {
  type LiveCaseReport,
  type LiveEvaluationReport,
  type LiveEvaluationTotals,
  LiveReviewEvaluator,
  loadLiveEvaluationFixtures,
  summarizeLearningPairs,
  summarizeReport,
  UsageTracker,
} from "../eval/live-review-evaluator.js";
import { createLogger } from "../logging/logger.js";
import type { MemoryEmbedder } from "../memory/memory-service.js";
import { ChatReviewModel } from "../review/chat-review-model.js";
import type { ReviewEngineOptions } from "../review/review-engine.js";

export interface EvalLiveReviewsInput {
  cwd?: string;
  fixtureDirectory?: string;
  outFile?: string;
  filter?: string;
  apiKey: string | null;
  baseUrl: string;
  model: string;
  reasoningEffort?: ReasoningEffort | null;
  timeoutMs?: number;
  engineOptions?: ReviewEngineOptions;
  /** Injected for tests; defaults to a real ChatReviewModel. */
  modelFactory?: (
    usage: UsageTracker,
  ) => Pick<ChatReviewModel, "generateStructuredReview">;
  write?: (line: string) => void;
  /** Stamped into the report; passed in so callers control clock access. */
  startedAt?: string;
  /** Commit under test, stamped into the report for baseline comparisons. */
  gitCommit?: string;
  /** Keep cases already recorded in `outFile` and run only the rest. */
  resume?: boolean;
  /** Runs the dismissal filter for fixtures that carry dismissals. */
  embedder?: MemoryEmbedder;
}

export const DEFAULT_LIVE_FIXTURE_DIRECTORY =
  "tests/fixtures/review-evals/live";

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCase(report: LiveCaseReport): string {
  const tokens =
    report.promptTokens === null
      ? "tokens n/a"
      : `${report.promptTokens}+${report.completionTokens ?? 0} tok`;
  const status = report.error ? `ERROR ${report.error}` : "";
  return [
    `  ${report.name}: recall ${pct(report.recall)} precision ${pct(report.precision)}`,
    `matched ${report.matched.length} missed ${report.missed.length} unexpected ${report.unexpected.length}`,
    `${seconds(report.durationMs)} ${report.chunkCount} chunk(s) ${tokens} ${status}`,
  ].join(" | ");
}

export function formatTotals(
  label: string,
  totals: LiveEvaluationTotals,
): string {
  return [
    `${label}: cases ${totals.cases}`,
    `precision(medium+) ${pct(totals.precisionMediumPlus)}`,
    `precision ${pct(totals.precision)} (${totals.matched}/${totals.published})`,
    `recall ${pct(totals.recall)} (${totals.matched}/${totals.expected})`,
    `recall+second-look ${pct(totals.recallIncludingSecondLook)}`,
    `nits ${totals.nitCount}`,
    `clean-case FPs ${totals.cleanCaseFalsePositives}`,
    `verdicts ${totals.verdictAccuracy === null ? "n/a" : pct(totals.verdictAccuracy)}`,
    `median ${seconds(totals.medianCaseMs)}`,
    `total ${seconds(totals.durationMs)}`,
    `failed ${totals.failedCases}`,
  ].join(" | ");
}

export class EvalLiveReviewsCommand {
  async run(input: EvalLiveReviewsInput): Promise<LiveEvaluationReport> {
    const write = input.write ?? ((line: string) => console.log(line));
    const cwd = input.cwd ?? process.cwd();
    const directory =
      input.fixtureDirectory ?? join(cwd, DEFAULT_LIVE_FIXTURE_DIRECTORY);
    try {
      await access(directory);
    } catch {
      throw new Error(`Fixture directory does not exist: ${directory}`);
    }

    let fixtures = await loadLiveEvaluationFixtures(directory);
    if (input.filter) {
      const needle = input.filter.toLowerCase();
      fixtures = fixtures.filter((fixture) =>
        fixture.name.toLowerCase().includes(needle),
      );
    }
    if (fixtures.length === 0) {
      throw new Error(`No live eval fixtures found in ${directory}.`);
    }

    const usage = new UsageTracker();
    const model =
      input.modelFactory?.(usage) ??
      new ChatReviewModel({
        apiKey: input.apiKey,
        model: input.model,
        baseUrl: input.baseUrl,
        reasoningEffort: input.reasoningEffort ?? null,
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        onCompletion: usage.onCompletion,
        logger: createLogger({ level: "warn" }),
      });

    write(
      `Live review eval: model=${input.model} baseUrl=${input.baseUrl} reasoningEffort=${input.reasoningEffort ?? "(unset)"} fixtures=${fixtures.length}`,
    );

    // With --resume, cases already in the output file are kept, so a run
    // interrupted on a slow machine continues where it stopped.
    const completedCases: LiveCaseReport[] =
      input.resume && input.outFile
        ? await readFile(input.outFile, "utf8")
            .then((text) => (JSON.parse(text) as LiveEvaluationReport).cases)
            .catch(() => [])
        : [];
    if (completedCases.length > 0) {
      write(`Resuming: ${completedCases.length} case(s) already done.`);
    }
    const writeReport = async (
      cases: LiveCaseReport[],
      final: boolean,
    ): Promise<void> => {
      if (!input.outFile) {
        return;
      }
      const payload = {
        model: input.model,
        baseUrl: input.baseUrl,
        reasoningEffort: input.reasoningEffort ?? null,
        startedAt: input.startedAt ?? null,
        gitCommit: input.gitCommit ?? null,
        fixtureDirectory: directory,
        complete: final,
        cases,
        totals: summarizeReport(cases),
      };
      await mkdir(dirname(input.outFile), { recursive: true });
      await writeFile(input.outFile, `${JSON.stringify(payload, null, 2)}\n`);
    };

    const evaluator = new LiveReviewEvaluator({
      model,
      usage,
      completedCases,
      engineOptions: input.engineOptions ?? {},
      ...(input.embedder ? { embedder: input.embedder } : {}),
      onCaseStart: (fixture, index) => {
        write(`[${index + 1}/${fixtures.length}] ${fixture.name} ...`);
      },
      onCaseDone: async (report, _index, casesSoFar) => {
        await writeReport(casesSoFar, false);
        write(formatCase(report));
        for (const entry of report.matched) {
          write(`      ✓ ${entry.expected}  ←  ${entry.finding}`);
        }
        for (const entry of report.missed) {
          write(`      ✗ missed: ${entry}`);
        }
        for (const entry of report.unexpected) {
          write(`      ? unexpected: ${entry}`);
        }
      },
    });

    const report = await evaluator.evaluate(fixtures);
    const totals = report.totals;
    write("");
    write(formatTotals("Totals", totals));
    for (const pair of summarizeLearningPairs(report.cases)) {
      write(
        `  learning ${pair.name}: control ${pair.control.findings} finding(s) ${pair.control.passed ? "pass" : "fail"} | with learning ${pair.applied.findings} finding(s) ${pair.applied.passed ? "pass" : "fail"} | learning applied: ${pair.learningApplied ? "yes" : "no"}`,
      );
    }
    for (const [group, entries] of [
      ["stack", totals.byStack],
      ["kind", totals.byKind],
    ] as const) {
      for (const [name, entry] of Object.entries(entries)) {
        write(formatTotals(`  ${group}=${name}`, entry));
      }
    }

    if (input.outFile) {
      await writeReport(report.cases, true);
      write(`Wrote ${input.outFile}`);
    }

    return report;
  }
}
