import { z } from "zod";

import {
  type ResponseJsonSchema,
  toResponseSchema,
} from "../shared/chat-completion-client.js";
import {
  type DiagramSpec,
  defaultDiagramSpec,
  mergeDiagramSpecs,
  renderDiagramSpec,
} from "./diagram-renderer.js";
import {
  type EvidenceGateRejectedFinding,
  gateAndRankFindings,
  type ReviewFeedbackSignal,
  type Severity,
  severityWeight,
} from "./evidence-gate.js";
import { fingerprintFinding } from "./finding-fingerprint.js";
import { downgradeSeverity, verifyFinding } from "./finding-verifier.js";
import {
  type PriorThread,
  type PriorThreadVerdict,
  PromptBuilder,
} from "./prompt-builder.js";
import {
  type PromptOptimizationMode,
  PromptPayloadOptimizer,
  type PromptUsageSnapshot,
  type ReviewScope,
} from "./prompt-payload-optimizer.js";

const defaultMermaidDiagram = renderDiagramSpec(defaultDiagramSpec);
const defaultSummary = "nitpickr completed the review.";

const findingSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  findingType: z.enum(["bug", "safe_suggestion", "question", "teaching_note"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  category: z.enum([
    "correctness",
    "performance",
    "security",
    "maintainability",
    "testing",
    "style",
  ]),
  title: z.string().min(1),
  body: z.string().min(1),
  fixPrompt: z.string().min(1),
  suggestedChange: z.string().min(1).optional(),
  /** Line(s) the model quoted from the patch as the defect. */
  evidence: z.string().min(1).optional(),
  /** Concrete input/state, what happens, what should happen. */
  failureScenario: z.string().min(1).optional(),
});

const findingTypeAliasMap: Record<
  string,
  z.infer<typeof findingSchema>["findingType"]
> = {
  bug: "bug",
  defect: "bug",
  issue: "bug",
  concern: "bug",
  safe_suggestion: "safe_suggestion",
  safe_suggest: "safe_suggestion",
  suggestion: "safe_suggestion",
  question: "question",
  clarification: "question",
  teaching_note: "teaching_note",
  note: "teaching_note",
  explanation: "teaching_note",
};

const MAX_SUGGESTED_CHANGE_LINES = 12;
const MAX_EVIDENCE_CHARACTERS = 1_200;
const MAX_SUGGESTED_CHANGE_CHARACTERS = 600;

const severityAliasMap: Record<
  string,
  z.infer<typeof findingSchema>["severity"]
> = {
  info: "low",
  trivial: "low",
  minor: "low",
  nit: "low",
  low: "low",
  moderate: "medium",
  medium: "medium",
  major: "high",
  high: "high",
  significant: "high",
  severe: "critical",
  blocker: "critical",
  blocking: "critical",
  critical: "critical",
};

const categoryAliasMap: Record<
  string,
  z.infer<typeof findingSchema>["category"]
> = {
  bug: "correctness",
  bugs: "correctness",
  correctness: "correctness",
  logic: "correctness",
  functionality: "correctness",
  functional: "correctness",
  robustness: "correctness",
  reliability: "correctness",
  stability: "correctness",
  performance: "performance",
  perf: "performance",
  scalability: "performance",
  efficiency: "performance",
  security: "security",
  vuln: "security",
  vulnerability: "security",
  maintainability: "maintainability",
  architecture: "maintainability",
  design: "maintainability",
  readability: "maintainability",
  refactor: "maintainability",
  cleanup: "maintainability",
  testing: "testing",
  test: "testing",
  tests: "testing",
  coverage: "testing",
  style: "style",
  formatting: "style",
  docs: "style",
  documentation: "style",
  nitpick: "style",
};

export type ReviewFinding = z.infer<typeof findingSchema>;

function normalizeLine(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function normalizeSeverity(
  value: unknown,
): ReviewFinding["severity"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return severityAliasMap[value.trim().toLowerCase()];
}

function normalizeCategory(
  value: unknown,
): ReviewFinding["category"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return categoryAliasMap[value.trim().toLowerCase()];
}

function normalizeFindingType(
  value: unknown,
): ReviewFinding["findingType"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return findingTypeAliasMap[value.trim().toLowerCase()];
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Keep the first `maxSentences` sentences. A sentence ends at `.`, `!` or `?`
 * followed by whitespace or the end of the text, outside inline code, so
 * `'a'.repeat(40)` or `v1.2` never cut a body mid-expression.
 */
export function maybeTrimSentenceCount(
  value: string,
  maxSentences: number,
): string {
  let inCode = false;
  let sentences = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "`") {
      inCode = !inCode;
      continue;
    }
    if (
      inCode ||
      (character !== "." && character !== "!" && character !== "?")
    ) {
      continue;
    }
    const next = value[index + 1];
    if (next === undefined || /\s/.test(next)) {
      sentences += 1;
      if (sentences === maxSentences) {
        return value.slice(0, index + 1).trim();
      }
    }
  }
  return value.trim();
}

function withScopedFixPrompt(
  path: string,
  line: number,
  fixPrompt: string | undefined,
  title: string | undefined,
): string | undefined {
  const body = fixPrompt?.trim() ?? (title ? `Resolve: ${title}.` : undefined);
  if (!body) {
    return undefined;
  }

  const hasPath = body.includes(path);
  const hasLine = new RegExp(`\\bline\\s+${line}\\b`, "i").test(body);
  if (hasPath && hasLine) {
    return body;
  }

  return `In \`${path}\` around line ${line}, ${body}`;
}

function normalizeSuggestedChange(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const fenced = trimmed.match(/^```(?:suggestion|[\w-]+)?\n([\s\S]*?)\n```$/i);
  const normalized = (fenced?.[1] ?? trimmed)
    .replace(/\r\n/g, "\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");

  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized.length > MAX_SUGGESTED_CHANGE_CHARACTERS) {
    return undefined;
  }
  if (normalized.split("\n").length > MAX_SUGGESTED_CHANGE_LINES) {
    return undefined;
  }

  return normalized;
}

function normalizeFinding(value: unknown): ReviewFinding | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const path = normalizeString(candidate.path);
  const line = normalizeLine(candidate.line);
  const normalizedSuggestedChange = normalizeSuggestedChange(
    candidate.suggestedChange,
  );
  const findingType =
    normalizeFindingType(candidate.findingType) ??
    (normalizedSuggestedChange ? "safe_suggestion" : "bug");
  const severity = normalizeSeverity(candidate.severity);
  const category = normalizeCategory(candidate.category);
  const title = normalizeString(candidate.title);
  const body = normalizeString(candidate.body);
  const conciseBody = body ? maybeTrimSentenceCount(body, 2) : undefined;
  const fixPrompt =
    path && line
      ? withScopedFixPrompt(
          path,
          line,
          normalizeString(candidate.fixPrompt),
          title,
        )
      : undefined;
  const suggestedChange =
    findingType === "safe_suggestion" ? normalizedSuggestedChange : undefined;
  const evidence = normalizeString(candidate.evidence)?.slice(
    0,
    MAX_EVIDENCE_CHARACTERS,
  );
  const failureScenario = normalizeString(candidate.failureScenario);

  const parsed = findingSchema.safeParse({
    path,
    line,
    findingType,
    severity,
    category,
    title,
    body: conciseBody,
    fixPrompt,
    suggestedChange,
    ...(evidence === undefined ? {} : { evidence }),
    ...(failureScenario === undefined
      ? {}
      : { failureScenario: maybeTrimSentenceCount(failureScenario, 3) }),
  });

  return parsed.success ? parsed.data : null;
}

function normalizeFindings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const finding = normalizeFinding(entry);
    return finding ? [finding] : [];
  });
}

function normalizeLegacyMermaid(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeSequenceDiagram(
  value: Record<string, unknown>,
): DiagramSpec | null {
  const participants = Array.isArray(value.participants)
    ? value.participants.flatMap((participant) => {
        if (typeof participant === "string") {
          return [
            {
              id: participant,
              label: participant,
            },
          ];
        }

        if (
          typeof participant === "object" &&
          participant !== null &&
          typeof participant.id === "string"
        ) {
          return [
            {
              id: participant.id,
              label:
                typeof participant.label === "string"
                  ? participant.label
                  : participant.id,
            },
          ];
        }

        return [];
      })
    : [];

  const steps = Array.isArray(value.steps)
    ? value.steps.flatMap((step) => {
        if (
          typeof step !== "object" ||
          step === null ||
          typeof step.from !== "string" ||
          typeof step.to !== "string" ||
          typeof step.label !== "string"
        ) {
          return [];
        }

        return [
          {
            from: step.from,
            to: step.to,
            label: step.label,
          },
        ];
      })
    : [];

  if (participants.length === 0 || steps.length === 0) {
    return null;
  }

  const title = normalizeString(value.title);
  return {
    type: "sequence",
    ...(title ? { title } : {}),
    participants,
    steps,
  };
}

function normalizeFlowchartDiagram(
  value: Record<string, unknown>,
): DiagramSpec | null {
  const nodes = Array.isArray(value.nodes)
    ? value.nodes.flatMap((node) => {
        if (typeof node === "string") {
          return [
            {
              id: node,
              label: node,
            },
          ];
        }

        if (
          typeof node === "object" &&
          node !== null &&
          typeof node.id === "string"
        ) {
          return [
            {
              id: node.id,
              label: typeof node.label === "string" ? node.label : node.id,
            },
          ];
        }

        return [];
      })
    : [];

  const edges = Array.isArray(value.edges)
    ? value.edges.flatMap((edge) => {
        if (
          typeof edge !== "object" ||
          edge === null ||
          typeof edge.from !== "string" ||
          typeof edge.to !== "string"
        ) {
          return [];
        }

        return [
          {
            from: edge.from,
            to: edge.to,
            label: typeof edge.label === "string" ? edge.label : undefined,
          },
        ];
      })
    : [];

  if (nodes.length === 0 || edges.length === 0) {
    return null;
  }

  const title = normalizeString(value.title);
  return {
    type: "flowchart",
    ...(title ? { title } : {}),
    direction: value.direction === "TD" ? "TD" : "LR",
    nodes,
    edges,
  };
}

function normalizeDiagram(value: unknown): DiagramSpec | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.type === "sequence") {
    return normalizeSequenceDiagram(candidate);
  }

  if (candidate.type === "flowchart") {
    return normalizeFlowchartDiagram(candidate);
  }

  return null;
}

const priorThreadVerdictValues = [
  "fixed",
  "still_applies",
  "obsolete",
] as const satisfies readonly PriorThreadVerdict[];

function normalizePriorThreadVerdicts(
  value: unknown,
): Array<{ threadId: string; verdict: PriorThreadVerdict }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const candidate = entry as Record<string, unknown>;
    const threadId = normalizeString(candidate.threadId);
    const verdict = normalizeString(candidate.verdict)?.toLowerCase();
    const known = priorThreadVerdictValues.find((value) => value === verdict);
    return threadId && known ? [{ threadId, verdict: known }] : [];
  });
}

const modelResponseSchema = z
  .object({
    summary: z.preprocess((value) => {
      if (value === null || value === undefined) {
        return defaultSummary;
      }

      if (typeof value === "string" && value.trim().length === 0) {
        return defaultSummary;
      }

      return value;
    }, z.string().min(1)),
    diagram: z.unknown().optional(),
    mermaid: z.unknown().optional(),
    findings: z.preprocess(
      (value) => normalizeFindings(value),
      z.array(findingSchema),
    ),
    priorThreadVerdicts: z.unknown().optional(),
  })
  .transform((value) => ({
    summary: value.summary,
    diagram: normalizeDiagram(value.diagram),
    legacyMermaid: normalizeLegacyMermaid(value.mermaid),
    findings: value.findings,
    priorThreadVerdicts: normalizePriorThreadVerdicts(
      value.priorThreadVerdicts,
    ),
  }));

/**
 * The reply shape the model is constrained to (JSON Schema structured
 * output). Every field is required and optional values are nullable, as
 * strict mode expects; modelResponseSchema above still normalizes the reply.
 */
const reviewResponseWireSchema = z.strictObject({
  summary: z.string(),
  diagram: z.union([
    z.strictObject({
      type: z.literal("sequence"),
      participants: z.array(
        z.strictObject({ id: z.string(), label: z.string() }),
      ),
      steps: z.array(
        z.strictObject({ from: z.string(), to: z.string(), label: z.string() }),
      ),
    }),
    z.strictObject({
      type: z.literal("flowchart"),
      direction: z.enum(["LR", "TD"]).nullable(),
      nodes: z.array(z.strictObject({ id: z.string(), label: z.string() })),
      edges: z.array(
        z.strictObject({
          from: z.string(),
          to: z.string(),
          label: z.string().nullable(),
        }),
      ),
    }),
  ]),
  findings: z.array(
    z.strictObject({
      path: z.string(),
      line: z.number().int(),
      findingType: findingSchema.shape.findingType,
      severity: findingSchema.shape.severity,
      category: findingSchema.shape.category,
      title: z.string(),
      body: z.string(),
      evidence: z.string(),
      failureScenario: z.string(),
      fixPrompt: z.string(),
      suggestedChange: z.string().nullable(),
    }),
  ),
  priorThreadVerdicts: z.array(
    z.strictObject({
      threadId: z.string(),
      verdict: z.enum(priorThreadVerdictValues),
    }),
  ),
});

export const reviewResponseJsonSchema: ResponseJsonSchema = {
  name: "nitpickr_review",
  schema: toResponseSchema(reviewResponseWireSchema),
};

export interface ReviewModel {
  generateStructuredReview(input: {
    system: string;
    user: string;
    jsonSchema?: ResponseJsonSchema | null;
  }): Promise<unknown>;
}

export interface ReviewEngineInput {
  changeRequest: {
    title: string;
    number: number;
  };
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    patch: string | null;
    fileContent?: string | null;
  }>;
  contextFiles?: Array<{
    path: string;
    additions: number;
    deletions: number;
    patch: string | null;
  }>;
  instructionText: string;
  memory: Array<{
    summary: string;
    path?: string;
  }>;
  commentBudget: number;
  scope?: ReviewScope;
  optimizationMode?: PromptOptimizationMode;
  feedbackSignals?: ReviewFeedbackSignal[];
  publishableFindingTypes?: ReviewFinding["findingType"][];
  priorThreads?: PriorThread[];
  /**
   * Count of prior completed (`published` or `skipped`) review runs for this
   * change request. Surfaced to the prompt so the model can self-restrain on
   * long-iteration PRs. Defaults to 0 when omitted.
   */
  priorReviewRoundCount?: number;
  /**
   * Minimum severity to publish (round-aware floor, see severity-floor.ts).
   * Applied before the comment budget so low findings never take a slot.
   */
  severityFloor?: Severity | null;
}

export interface ReviewEngineResult {
  summary: string;
  mermaid: string;
  findings: ReviewFinding[];
  /** Verdicts for prior threads that needed one; unknown ids are dropped. */
  priorThreadVerdicts?: Array<{
    threadId: string;
    verdict: PriorThreadVerdict;
  }>;
}

export interface ReviewEngineDiagnosticsResult {
  result: ReviewEngineResult;
  rejectedFindings: EvidenceGateRejectedFinding<ReviewFinding>[];
  promptUsage: {
    beforeCompaction: PromptUsageSnapshot;
    afterCompaction: PromptUsageSnapshot;
  };
}

export interface ReviewEngineOptions {
  /** Patch characters packed per chunk (file content excluded). */
  maxPatchCharactersPerChunk?: number;
  /**
   * Total prompt characters (patch + full file content) packed per chunk.
   * Bounds prompt size for models with small context windows / slow prefill.
   */
  maxTotalCharactersPerChunk?: number;
  /** Max model requests in flight for one review; 1 = strictly sequential. */
  maxConcurrentModelRequests?: number;
  /**
   * Reject findings whose quoted `evidence` is missing or does not appear in
   * the patch/file (default true): it catches findings about code that is
   * not there, the most common false positive from small models.
   */
  requireEvidence?: boolean;
  /**
   * Adversarially verify findings that survive the gate, one model call each
   * and at most `maxFindings` per review. Confirmed findings publish, refuted
   * ones drop, uncertain ones lose one severity level. Off when null/absent.
   */
  verifier?: { maxFindings: number } | null;
}

export const DEFAULT_MAX_PATCH_CHARACTERS_PER_CHUNK = 16_000;
export const DEFAULT_MAX_TOTAL_CHARACTERS_PER_CHUNK = 200_000;
export const DEFAULT_MAX_CONCURRENT_MODEL_REQUESTS = 4;

function splitIntoChunks(
  files: ReviewEngineInput["files"],
  maxPatchCharactersPerChunk: number,
  maxTotalCharactersPerChunk: number,
): Array<ReviewEngineInput["files"]> {
  const chunks: Array<ReviewEngineInput["files"]> = [];
  let currentChunk: ReviewEngineInput["files"] = [];
  let currentPatchSize = 0;
  let currentTotalSize = 0;

  for (const file of files) {
    const patchSize = file.patch?.length ?? 0;
    const totalSize = patchSize + (file.fileContent?.length ?? 0);
    const wouldOverflow =
      currentChunk.length > 0 &&
      (currentPatchSize + patchSize > maxPatchCharactersPerChunk ||
        currentTotalSize + totalSize > maxTotalCharactersPerChunk);

    if (wouldOverflow) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentPatchSize = 0;
      currentTotalSize = 0;
    }

    currentChunk.push(file);
    currentPatchSize += patchSize;
    currentTotalSize += totalSize;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Run `task` for every item with at most `limit` in flight, preserving order.
 * Kept inline (no dependency) because it is the only bounded pool we need.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await task(items[index] as T, index);
      }
    }),
  );
  return results;
}

// severityWeight is imported from evidence-gate (see the top of this file)
// so the ordering of "low" < "medium" < "high" < "critical" has one source
// of truth across the gate, the round-aware floor (severity-floor.ts), and
// the engine's deduplicator/ranker below.

function dedupeKey(finding: ReviewFinding): string {
  return fingerprintFinding(finding);
}

function compareFindings(left: ReviewFinding, right: ReviewFinding): number {
  const severityDifference =
    severityWeight(right.severity) - severityWeight(left.severity);
  if (severityDifference !== 0) {
    return severityDifference;
  }

  const pathComparison = left.path.localeCompare(right.path);
  if (pathComparison !== 0) {
    return pathComparison;
  }

  if (left.line !== right.line) {
    return left.line - right.line;
  }

  const categoryComparison = left.category.localeCompare(right.category);
  if (categoryComparison !== 0) {
    return categoryComparison;
  }

  return left.title.localeCompare(right.title);
}

function dedupeAndRankFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const deduped = new Map<string, ReviewFinding>();

  for (const finding of findings) {
    const key = dedupeKey(finding);
    const current = deduped.get(key);
    if (!current || compareFindings(finding, current) < 0) {
      deduped.set(key, finding);
    }
  }

  return [...deduped.values()].sort(compareFindings);
}

function mergeMermaid(diagrams: string[]): string {
  if (diagrams.length === 0) {
    return defaultMermaidDiagram;
  }

  if (diagrams.some((diagram) => !diagram.trim().startsWith("flowchart"))) {
    return diagrams[0] ?? defaultMermaidDiagram;
  }

  const lines = new Set<string>();
  let hasHeader = false;

  for (const diagram of diagrams) {
    for (const line of diagram.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      if (trimmed.startsWith("flowchart")) {
        hasHeader = true;
        continue;
      }

      lines.add(trimmed);
    }
  }

  const header = hasHeader ? "flowchart TD" : "flowchart TD";
  return [header, ...lines].join("\n");
}

function renderMergedDiagram(
  responses: Array<{
    diagram: DiagramSpec | null;
    legacyMermaid: string | null;
  }>,
): string {
  const diagrams = responses.flatMap((response) =>
    response.diagram ? [response.diagram] : [],
  );
  if (diagrams.length === responses.length && diagrams.length > 0) {
    return renderDiagramSpec(mergeDiagramSpecs(diagrams));
  }
  if (diagrams.length > 0) {
    return renderDiagramSpec(diagrams[0] ?? defaultDiagramSpec);
  }

  const legacyMermaid = responses.flatMap((response) =>
    response.legacyMermaid ? [response.legacyMermaid] : [],
  );
  if (legacyMermaid.length > 0) {
    return mergeMermaid(legacyMermaid);
  }

  return defaultMermaidDiagram;
}

export class ReviewEngine {
  readonly #model: ReviewModel;
  readonly #promptBuilder: PromptBuilder;
  readonly #promptPayloadOptimizer: PromptPayloadOptimizer;
  readonly #maxPatchCharactersPerChunk: number;
  readonly #maxTotalCharactersPerChunk: number;
  readonly #maxConcurrentModelRequests: number;
  readonly #requireEvidence: boolean;
  readonly #verifier: { maxFindings: number } | null;

  constructor(model: ReviewModel, options: ReviewEngineOptions = {}) {
    this.#model = model;
    this.#promptBuilder = new PromptBuilder();
    this.#promptPayloadOptimizer = new PromptPayloadOptimizer();
    this.#maxPatchCharactersPerChunk =
      options.maxPatchCharactersPerChunk ??
      DEFAULT_MAX_PATCH_CHARACTERS_PER_CHUNK;
    this.#maxTotalCharactersPerChunk =
      options.maxTotalCharactersPerChunk ??
      DEFAULT_MAX_TOTAL_CHARACTERS_PER_CHUNK;
    this.#maxConcurrentModelRequests =
      options.maxConcurrentModelRequests ??
      DEFAULT_MAX_CONCURRENT_MODEL_REQUESTS;
    this.#requireEvidence = options.requireEvidence ?? true;
    this.#verifier = options.verifier ?? null;
  }

  /**
   * Verify gated findings in rank order until the comment budget is filled.
   * Returns the findings to publish and the ones the verifier removed.
   */
  async #verify(
    findings: ReviewFinding[],
    input: ReviewEngineInput,
  ): Promise<{
    kept: ReviewFinding[];
    rejected: EvidenceGateRejectedFinding<ReviewFinding>[];
  }> {
    const verifier = this.#verifier;
    if (verifier === null) {
      return { kept: findings, rejected: [] };
    }
    const filesByPath = new Map(input.files.map((file) => [file.path, file]));
    const floor = input.severityFloor ?? null;
    const kept: ReviewFinding[] = [];
    const rejected: EvidenceGateRejectedFinding<ReviewFinding>[] = [];
    let calls = 0;
    for (const finding of findings) {
      if (kept.length >= input.commentBudget) {
        break;
      }
      const file = filesByPath.get(finding.path);
      const outcome =
        file !== undefined && calls < verifier.maxFindings
          ? await verifyFinding(this.#model, finding, file)
          : { verdict: "unverified" as const, reason: "not verified (cap)" };
      calls += file === undefined ? 0 : 1;
      if (outcome.verdict === "confirmed" || outcome.verdict === "unverified") {
        // Unverified (cap reached or the verifier failed) is not evidence
        // against the finding: publish it as the reviewer rated it.
        kept.push(finding);
        continue;
      }
      if (
        outcome.verdict === "refuted" &&
        (finding.severity === "high" || finding.severity === "critical")
      ) {
        // A small model can talk itself out of a real serious bug; demote
        // instead of deleting so it still gets seen.
        kept.push({
          ...finding,
          severity: downgradeSeverity(finding.severity),
        });
        continue;
      }
      if (outcome.verdict === "refuted") {
        rejected.push({
          finding,
          findingFingerprint: fingerprintFinding(finding),
          reasons: ["refuted_by_verifier"],
          detail: outcome.reason,
        });
        continue;
      }
      const downgraded = {
        ...finding,
        severity: downgradeSeverity(finding.severity),
      };
      if (
        floor !== null &&
        severityWeight(downgraded.severity) < severityWeight(floor)
      ) {
        rejected.push({
          finding,
          findingFingerprint: fingerprintFinding(finding),
          reasons: ["unconfirmed_below_floor"],
          detail: outcome.reason,
        });
        continue;
      }
      kept.push(downgraded);
    }
    return { kept, rejected };
  }

  async #reviewInternal(input: ReviewEngineInput): Promise<{
    result: ReviewEngineResult;
    promptUsage: {
      beforeCompaction: PromptUsageSnapshot;
      afterCompaction: PromptUsageSnapshot;
    };
  }> {
    if (input.files.length === 0) {
      throw new Error("Review input must contain at least one file.");
    }

    const scope = input.scope ?? "full_pr";
    const optimizationMode = input.optimizationMode ?? "balanced";
    const unoptimizedChunks = splitIntoChunks(
      input.files,
      this.#maxPatchCharactersPerChunk,
      this.#maxTotalCharactersPerChunk,
    );
    const beforeCompaction = this.#promptPayloadOptimizer.estimatePromptUsage({
      chunks: unoptimizedChunks,
      ...(input.contextFiles === undefined
        ? {}
        : { contextFiles: input.contextFiles }),
      instructionText: input.instructionText,
      chunkMemory: unoptimizedChunks.map(() => input.memory),
    });

    const optimized = this.#promptPayloadOptimizer.optimize({
      scope,
      mode: optimizationMode,
      files: input.files,
      ...(input.contextFiles === undefined
        ? {}
        : { contextFiles: input.contextFiles }),
      instructionText: input.instructionText,
      memory: input.memory,
    });

    const chunks = splitIntoChunks(
      optimized.files,
      this.#maxPatchCharactersPerChunk,
      this.#maxTotalCharactersPerChunk,
    );
    const chunkMemories = chunks.map((files) =>
      this.#promptPayloadOptimizer.selectChunkMemory({
        mode: optimizationMode,
        files,
        memory: optimized.memory,
      }),
    );
    const afterCompaction = this.#promptPayloadOptimizer.estimatePromptUsage({
      chunks,
      ...(optimized.contextFiles === undefined
        ? {}
        : { contextFiles: optimized.contextFiles }),
      instructionText: optimized.instructionText,
      chunkMemory: chunkMemories,
    });

    const responses = await mapWithConcurrency(
      chunks,
      this.#maxConcurrentModelRequests,
      async (files, index) => {
        const chunkPaths = new Set(files.map((file) => file.path));
        const chunkPriorThreads = input.priorThreads
          ? input.priorThreads.filter((thread) => chunkPaths.has(thread.path))
          : undefined;
        const prompt = this.#promptBuilder.build({
          changeRequest: input.changeRequest,
          chunk: {
            index,
            total: chunks.length,
            files,
          },
          instructionText: optimized.instructionText,
          memory: chunkMemories[index] ?? [],
          commentBudget: input.commentBudget,
          ...(optimized.contextFiles === undefined
            ? {}
            : { contextFiles: optimized.contextFiles }),
          ...(chunkPriorThreads && chunkPriorThreads.length > 0
            ? { priorThreads: chunkPriorThreads }
            : {}),
          ...(input.priorReviewRoundCount !== undefined
            ? { priorReviewRoundCount: input.priorReviewRoundCount }
            : {}),
        });

        const response = await this.#model.generateStructuredReview({
          ...prompt,
          jsonSchema: reviewResponseJsonSchema,
        });
        const parsed = modelResponseSchema.parse(response);
        // A chunk may only judge threads it was shown.
        const shownThreadIds = new Set(
          (chunkPriorThreads ?? []).map((thread) => thread.id),
        );
        return {
          ...parsed,
          priorThreadVerdicts: parsed.priorThreadVerdicts.filter((entry) =>
            shownThreadIds.has(entry.threadId),
          ),
        };
      },
    );

    // The comment budget is applied by the callers, after every filter, so
    // findings that are later rejected never take a slot.
    const mergedFindings = dedupeAndRankFindings(
      responses.flatMap((response) => response.findings),
    );

    const verdictThreadIds = new Set(
      (input.priorThreads ?? [])
        .filter((thread) => thread.needsVerdict)
        .map((thread) => thread.id),
    );
    const priorThreadVerdicts = [
      ...new Map(
        responses
          .flatMap((response) => response.priorThreadVerdicts)
          .filter((entry) => verdictThreadIds.has(entry.threadId))
          .map((entry) => [entry.threadId, entry] as const),
      ).values(),
    ];

    return {
      result: {
        summary: responses.map((response) => response.summary).join("\n\n"),
        mermaid: renderMergedDiagram(responses),
        findings: mergedFindings,
        priorThreadVerdicts,
      },
      promptUsage: {
        beforeCompaction,
        afterCompaction,
      },
    };
  }

  async review(input: ReviewEngineInput): Promise<ReviewEngineResult> {
    const reviewed = await this.#reviewInternal(input);
    return {
      ...reviewed.result,
      findings: reviewed.result.findings.slice(0, input.commentBudget),
    };
  }

  async reviewWithDiagnostics(
    input: ReviewEngineInput,
  ): Promise<ReviewEngineDiagnosticsResult> {
    const reviewed = await this.#reviewInternal(input);
    // Only the primary files are in scope: they are the ones the publisher can
    // anchor inline comments to. Context files are listed to the model by
    // name only, so a finding on them has no evidence behind it.
    const settledThreadIds = new Set(
      (reviewed.result.priorThreadVerdicts ?? [])
        .filter((entry) => entry.verdict !== "still_applies")
        .map((entry) => entry.threadId),
    );
    const openThreads = (input.priorThreads ?? [])
      .filter(
        (thread) =>
          thread.state !== "resolved" && !settledThreadIds.has(thread.id),
      )
      .map((thread) => {
        // Fingerprints are path:line:category:title; a new finding of a
        // different category near an open thread is a different problem.
        const category = thread.fingerprint.split(":").at(-2);
        return category
          ? { path: thread.path, line: thread.line, category }
          : { path: thread.path, line: thread.line };
      });
    const gatedFindings = gateAndRankFindings({
      findings: reviewed.result.findings,
      files: input.files,
      requireEvidence: this.#requireEvidence,
      ...(openThreads.length === 0 ? {} : { openThreads }),
      ...(input.severityFloor === undefined
        ? {}
        : { minimumSeverity: input.severityFloor }),
      ...(input.feedbackSignals === undefined
        ? {}
        : { feedbackSignals: input.feedbackSignals }),
      ...(input.publishableFindingTypes === undefined
        ? {}
        : { publishableFindingTypes: input.publishableFindingTypes }),
    });

    const verified = await this.#verify(gatedFindings.acceptedFindings, input);

    return {
      result: {
        ...reviewed.result,
        findings: verified.kept.slice(0, input.commentBudget),
      },
      rejectedFindings: [
        ...gatedFindings.rejectedFindings,
        ...verified.rejected,
      ],
      promptUsage: reviewed.promptUsage,
    };
  }
}
