import { randomUUID } from "node:crypto";

import { type Logger, noopLogger } from "../logging/logger.js";

export type MemoryKind =
  | "preferred_pattern"
  | "false_positive"
  | "accepted_recommendation"
  | "coding_convention"
  | "domain_fact"
  | "dismissed_finding";

export interface MemoryEntry {
  id: string;
  tenantId: string;
  repositoryId: string;
  kind: MemoryKind;
  summary: string;
  path: string | null;
  tags: string[];
  globs: string[];
  confidence: number;
  usageCount: number;
  lastUsedAt: string | null;
  embedding: number[] | null;
  supersededBy: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryClassifierResultEntry {
  kind: MemoryKind;
  summary: string;
  tags: string[];
  globs: string[];
  confidence: number;
  supersedesHint?: string;
}

export interface MemoryClassifierResult {
  entries: MemoryClassifierResultEntry[];
  acknowledgment: string;
}

export interface MemoryClassifier {
  extract(input: {
    body: string;
    authorLogin: string;
    path: string | null;
  }): Promise<MemoryClassifierResult>;
}

/** Retrieval models embed stored text and search queries differently. */
export type EmbeddingPurpose = "document" | "query";

export interface MemoryEmbedder {
  embed(text: string, purpose?: EmbeddingPurpose): Promise<number[]>;
}

export interface MemoryStore {
  save(entries: MemoryEntry[]): Promise<void>;
  listByRepository(input: {
    tenantId: string;
    repositoryId: string;
  }): Promise<MemoryEntry[]>;
  findNearestNeighbors?(input: {
    tenantId: string;
    repositoryId: string;
    embedding: number[];
    kind?: MemoryKind;
    limit: number;
  }): Promise<Array<{ entry: MemoryEntry; similarity: number }>>;
  markSuperseded?(input: {
    supersededId: string;
    supersededBy: string;
    updatedAt: string;
  }): Promise<void>;
  markUsage?(input: { ids: string[]; lastUsedAt: string }): Promise<void>;
  findActiveById?(input: {
    tenantId: string;
    repositoryId: string;
    id: string;
  }): Promise<MemoryEntry | null>;
}

export interface MemoryServiceDependencies {
  classifier?: MemoryClassifier;
  embedder?: MemoryEmbedder;
  logger?: Logger;
  now?: () => Date;
  createId?: () => string;
}

function normalizeSummary(body: string): string {
  return body.trim().replace(/\s+/g, " ");
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

const FALLBACK_KEYWORD_DEDUP_THRESHOLD = 0.85;
const SEMANTIC_DEDUP_THRESHOLD = 0.92;

function fallbackClassify(body: string): MemoryClassifierResultEntry | null {
  const normalized = body.toLowerCase();

  if (normalized.includes("false positive")) {
    return {
      kind: "false_positive",
      summary: normalizeSummary(body),
      tags: [],
      globs: [],
      confidence: 0.95,
    };
  }

  if (normalized.startsWith("prefer ") || normalized.includes(" prefer ")) {
    return {
      kind: "preferred_pattern",
      summary: normalizeSummary(body),
      tags: [],
      globs: [],
      confidence: 0.85,
    };
  }

  if (
    normalized.includes("accepted recommendation") ||
    normalized.includes("good fix")
  ) {
    return {
      kind: "accepted_recommendation",
      summary: normalizeSummary(body),
      tags: [],
      globs: [],
      confidence: 0.75,
    };
  }

  return null;
}

function fallbackAcknowledgment(
  entries: MemoryClassifierResultEntry[],
): string {
  if (entries.length === 0) {
    return "Thanks — noted, but I didn't find anything repo-wide to remember.";
  }
  return `Got it — I'll remember: ${entries
    .map((entry) => entry.summary)
    .join("; ")}.`;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export class MemoryService {
  readonly #store: MemoryStore;
  #classifier: MemoryClassifier | null;
  #embedder: MemoryEmbedder | null;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #createId: () => string;

  constructor(
    store: MemoryStore,
    dependencies: MemoryServiceDependencies = {},
  ) {
    this.#store = store;
    this.#classifier = dependencies.classifier ?? null;
    this.#embedder = dependencies.embedder ?? null;
    this.#logger = (dependencies.logger ?? noopLogger).child({
      component: "memory-service",
    });
    this.#now = dependencies.now ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
  }

  configureBackends(input: {
    classifier?: MemoryClassifier;
    embedder?: MemoryEmbedder;
  }): void {
    if (input.classifier) {
      this.#classifier = input.classifier;
    }
    if (input.embedder) {
      this.#embedder = input.embedder;
    }
  }

  async ingestDiscussion(input: {
    tenantId: string;
    repositoryId: string;
    discussions: Array<{
      authorLogin: string;
      body: string;
      path: string | null;
    }>;
  }): Promise<MemoryIngestionResult> {
    const startedAt = process.hrtime.bigint();
    const now = this.#now().toISOString();
    const acknowledgments: string[] = [];
    const savedEntries: MemoryEntry[] = [];

    for (const discussion of input.discussions) {
      const result = await this.#classifyDiscussion(discussion);
      acknowledgments.push(result.acknowledgment);

      for (const candidate of result.entries) {
        const persisted = await this.#persistEntry({
          tenantId: input.tenantId,
          repositoryId: input.repositoryId,
          candidate,
          discussionPath: discussion.path,
          now,
        });
        if (persisted) {
          savedEntries.push(persisted);
        }
      }
    }

    this.#logger.info("memory.ingest_discussion", {
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
      discussionCount: input.discussions.length,
      savedEntries: savedEntries.length,
      durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
    });

    return {
      acknowledgments,
      savedEntries,
    };
  }

  /**
   * Remember that a finding was not wanted in this repo (refuted on
   * reconsider, thumbs-down, or resolved by a human without a code change).
   * Stored as an embedded, repo-scoped `dismissed_finding` memory: retrieved
   * into later prompts and used to filter look-alike findings.
   */
  async recordDismissedFinding(input: {
    tenantId: string;
    repositoryId: string;
    path: string | null;
    title: string;
    /** The finding's body; stored with the title so look-alikes match. */
    body: string;
    signal: "reconsider_refuted" | "thumbs_down" | "resolved_without_change";
  }): Promise<MemoryEntry | null> {
    // Stored as the finding's own words (not a description of it): the
    // embedder matches finding-to-finding far better than finding-to-label.
    const body = normalizeSummary(input.body).slice(0, 300);
    return this.#persistEntry({
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
      candidate: {
        kind: "dismissed_finding",
        summary: `${normalizeSummary(input.title).replace(/\.$/, "")}.${
          body.length > 0 ? ` ${body}` : ""
        }`,
        tags: [input.signal],
        globs: [],
        confidence: input.signal === "reconsider_refuted" ? 0.8 : 0.6,
      },
      discussionPath: input.path,
      now: this.#now().toISOString(),
    });
  }

  /**
   * Past dismissals in this repo that look like `text`. Empty when no
   * embedder or vector search is available.
   */
  async findSimilarDismissals(input: {
    tenantId: string;
    repositoryId: string;
    text: string;
    minSimilarity: number;
  }): Promise<Array<{ entry: MemoryEntry; similarity: number }>> {
    if (!this.#embedder || !this.#store.findNearestNeighbors) {
      return [];
    }
    try {
      // Same purpose as stored dismissals: finding text against finding text.
      const embedding = await this.#embedder.embed(input.text, "document");
      const neighbors = await this.#store.findNearestNeighbors({
        tenantId: input.tenantId,
        repositoryId: input.repositoryId,
        embedding,
        kind: "dismissed_finding",
        limit: 5,
      });
      return neighbors.filter(
        (neighbor) => neighbor.similarity >= input.minSimilarity,
      );
    } catch (error) {
      this.#logger.warn("memory.similar_dismissals_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async #classifyDiscussion(discussion: {
    authorLogin: string;
    body: string;
    path: string | null;
  }): Promise<MemoryClassifierResult> {
    if (this.#classifier) {
      try {
        return await this.#classifier.extract(discussion);
      } catch {
        // fall through to fallback so a classifier outage never drops a comment
      }
    }

    const fallback = fallbackClassify(discussion.body);
    const entries = fallback ? [fallback] : [];
    return {
      entries,
      acknowledgment: fallbackAcknowledgment(entries),
    };
  }

  async #persistEntry(input: {
    tenantId: string;
    repositoryId: string;
    candidate: MemoryClassifierResultEntry;
    discussionPath: string | null;
    now: string;
  }): Promise<MemoryEntry | null> {
    const { tenantId, repositoryId, candidate, now } = input;
    const summary = normalizeSummary(candidate.summary);
    if (summary.length === 0) {
      return null;
    }

    let embedding: number[] | null = null;
    if (this.#embedder) {
      try {
        embedding = await this.#embedder.embed(summary, "document");
      } catch {
        embedding = null;
      }
    }

    const existing = await this.#findDuplicate({
      tenantId,
      repositoryId,
      kind: candidate.kind,
      summary,
      embedding,
    });

    if (existing) {
      const merged: MemoryEntry = {
        ...existing.entry,
        summary,
        path: existing.entry.path ?? input.discussionPath,
        tags: mergeUnique(existing.entry.tags, candidate.tags),
        globs: mergeUnique(existing.entry.globs, candidate.globs),
        confidence: clampConfidence(
          Math.max(existing.entry.confidence, candidate.confidence) +
            (1 - Math.max(existing.entry.confidence, candidate.confidence)) *
              0.1,
        ),
        embedding: embedding ?? existing.entry.embedding,
        updatedAt: now,
      };
      await this.#store.save([merged]);
      return merged;
    }

    const id = this.#createId();
    const entry: MemoryEntry = {
      id,
      tenantId,
      repositoryId,
      kind: candidate.kind,
      summary,
      path: input.discussionPath,
      tags: [...candidate.tags],
      globs: [...candidate.globs],
      confidence: clampConfidence(candidate.confidence),
      usageCount: 0,
      lastUsedAt: null,
      embedding,
      supersededBy: null,
      source: "discussion",
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.save([entry]);

    if (candidate.supersedesHint && this.#store.markSuperseded) {
      const target = await this.#resolveSupersedeTarget({
        tenantId,
        repositoryId,
        hint: candidate.supersedesHint,
        embedding,
        kind: candidate.kind,
        excludeId: id,
      });
      if (target) {
        await this.#store.markSuperseded({
          supersededId: target.id,
          supersededBy: id,
          updatedAt: now,
        });
      }
    }

    return entry;
  }

  async #findDuplicate(input: {
    tenantId: string;
    repositoryId: string;
    kind: MemoryKind;
    summary: string;
    embedding: number[] | null;
  }): Promise<{ entry: MemoryEntry; similarity: number } | null> {
    if (input.embedding && this.#store.findNearestNeighbors) {
      const neighbors = await this.#store.findNearestNeighbors({
        tenantId: input.tenantId,
        repositoryId: input.repositoryId,
        embedding: input.embedding,
        kind: input.kind,
        limit: 3,
      });
      const best = neighbors[0];
      if (best && best.similarity >= SEMANTIC_DEDUP_THRESHOLD) {
        return best;
      }
    }

    // Fallback substring dedup so the keyword-only path stays sane.
    const all = await this.#store.listByRepository({
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
    });
    const summaryLower = input.summary.toLowerCase();
    const candidate = all.find(
      (entry) =>
        entry.supersededBy === null &&
        entry.kind === input.kind &&
        entry.summary.toLowerCase() === summaryLower,
    );
    if (candidate) {
      return { entry: candidate, similarity: 1 };
    }
    return null;
  }

  async #resolveSupersedeTarget(input: {
    tenantId: string;
    repositoryId: string;
    hint: string;
    embedding: number[] | null;
    kind: MemoryKind;
    excludeId: string;
  }): Promise<MemoryEntry | null> {
    if (input.embedding && this.#store.findNearestNeighbors) {
      const neighbors = await this.#store.findNearestNeighbors({
        tenantId: input.tenantId,
        repositoryId: input.repositoryId,
        embedding: input.embedding,
        kind: input.kind,
        limit: 5,
      });
      const candidate = neighbors.find(
        (n) =>
          n.entry.id !== input.excludeId &&
          n.entry.supersededBy === null &&
          n.similarity >= FALLBACK_KEYWORD_DEDUP_THRESHOLD,
      );
      if (candidate) {
        return candidate.entry;
      }
    }

    const all = await this.#store.listByRepository({
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
    });
    const hintLower = input.hint.toLowerCase();
    return (
      all.find(
        (entry) =>
          entry.id !== input.excludeId &&
          entry.supersededBy === null &&
          entry.summary.toLowerCase().includes(hintLower),
      ) ?? null
    );
  }

  async getRelevantMemories(input: {
    tenantId: string;
    repositoryId: string;
    paths: string[];
    limit: number;
  }): Promise<MemoryEntry[]> {
    const repositoryEntries = await this.#store.listByRepository({
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
    });

    return repositoryEntries
      .filter((entry) => entry.supersededBy === null)
      .filter((entry) => {
        if (entry.globs.length === 0 && entry.path === null) {
          return true;
        }
        if (entry.path !== null) {
          if (input.paths.some((path) => path.startsWith(entry.path ?? ""))) {
            return true;
          }
        }
        return entry.globs.some((glob) =>
          input.paths.some((path) => matchesGlob(path, glob)),
        );
      })
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, input.limit);
  }

  async runMaintenance(input: {
    tenantId: string;
    repositoryId: string;
    minConfidence?: number;
    unusedForMs?: number;
  }): Promise<MemoryMaintenanceResult> {
    const startedAt = process.hrtime.bigint();
    const minConfidence = input.minConfidence ?? 0.3;
    const unusedForMs = input.unusedForMs ?? 90 * 24 * 60 * 60 * 1000;
    const now = this.#now();
    const nowIso = now.toISOString();

    const entries = await this.#store.listByRepository({
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
    });
    const active = entries.filter((entry) => entry.supersededBy === null);

    let evicted = 0;
    let merged = 0;

    // Evict low-confidence, unused entries by marking them superseded by themselves
    // is not meaningful; instead we'll soft-delete via a sentinel. Skip if the store
    // doesn't support markSuperseded.
    if (this.#store.markSuperseded) {
      for (const entry of active) {
        if (entry.confidence >= minConfidence) {
          continue;
        }
        const lastUsedAt = entry.lastUsedAt
          ? Date.parse(entry.lastUsedAt)
          : Date.parse(entry.updatedAt);
        const ageMs = Number.isFinite(lastUsedAt)
          ? now.getTime() - lastUsedAt
          : Number.POSITIVE_INFINITY;
        if (ageMs < unusedForMs) {
          continue;
        }
        await this.#store.markSuperseded({
          supersededId: entry.id,
          supersededBy: entry.id,
          updatedAt: nowIso,
        });
        evicted += 1;
      }
    }

    // Repo-wide dedup: cluster by kind + summary similarity. We use exact summary
    // text plus, if embeddings are present, cosine similarity ≥ 0.95.
    const stillActive = active.filter((entry) => {
      // re-filter after eviction
      const lastUsedAt = entry.lastUsedAt
        ? Date.parse(entry.lastUsedAt)
        : Date.parse(entry.updatedAt);
      const ageMs = Number.isFinite(lastUsedAt)
        ? now.getTime() - lastUsedAt
        : Number.POSITIVE_INFINITY;
      return !(entry.confidence < minConfidence && ageMs >= unusedForMs);
    });

    if (this.#store.markSuperseded) {
      const byKind = new Map<MemoryKind, MemoryEntry[]>();
      for (const entry of stillActive) {
        const bucket = byKind.get(entry.kind) ?? [];
        bucket.push(entry);
        byKind.set(entry.kind, bucket);
      }
      const REPO_DEDUP_THRESHOLD = 0.95;
      for (const bucket of byKind.values()) {
        // Sort by confidence desc, updatedAt desc — keep the strongest as canonical
        bucket.sort((left, right) => {
          if (right.confidence !== left.confidence) {
            return right.confidence - left.confidence;
          }
          return right.updatedAt.localeCompare(left.updatedAt);
        });
        const supersededIds = new Set<string>();
        for (let i = 0; i < bucket.length; i += 1) {
          const canonical = bucket[i];
          if (!canonical || supersededIds.has(canonical.id)) {
            continue;
          }
          for (let j = i + 1; j < bucket.length; j += 1) {
            const other = bucket[j];
            if (!other || supersededIds.has(other.id)) {
              continue;
            }
            const sameSummary =
              canonical.summary.toLowerCase() === other.summary.toLowerCase();
            const similar =
              canonical.embedding && other.embedding
                ? cosineSimilarity(canonical.embedding, other.embedding) >=
                  REPO_DEDUP_THRESHOLD
                : false;
            if (sameSummary || similar) {
              await this.#store.markSuperseded({
                supersededId: other.id,
                supersededBy: canonical.id,
                updatedAt: nowIso,
              });
              supersededIds.add(other.id);
              merged += 1;
            }
          }
        }
      }
    }

    this.#logger.info("memory.run_maintenance", {
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
      evicted,
      merged,
      durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
    });
    return { evicted, merged };
  }

  async selectMemoriesForReview(input: {
    tenantId: string;
    repositoryId: string;
    reviewedPaths: string[];
    reviewContext: string;
    charBudget: number;
  }): Promise<MemoryEntry[]> {
    const startedAt = process.hrtime.bigint();
    const candidates = await this.#store.listByRepository({
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
    });
    const active = candidates.filter((entry) => entry.supersededBy === null);
    const filtered = active.filter((entry) => {
      if (entry.globs.length === 0 && entry.path === null) {
        return true;
      }
      if (entry.path !== null) {
        if (input.reviewedPaths.some((p) => p.startsWith(entry.path ?? ""))) {
          return true;
        }
      }
      return entry.globs.some((glob) =>
        input.reviewedPaths.some((path) => matchesGlob(path, glob)),
      );
    });

    let queryEmbedding: number[] | null = null;
    if (this.#embedder && input.reviewContext.trim().length > 0) {
      try {
        queryEmbedding = await this.#embedder.embed(
          input.reviewContext,
          "query",
        );
      } catch {
        queryEmbedding = null;
      }
    }

    const now = this.#now();
    const ranked = filtered
      .map((entry) => ({
        entry,
        score: scoreEntry({
          entry,
          queryEmbedding,
          now,
        }),
      }))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.entry.usageCount - left.entry.usageCount;
      });

    const selected: MemoryEntry[] = [];
    let consumed = 0;
    const HARD_TOP = 3;
    for (let i = 0; i < ranked.length; i += 1) {
      const item = ranked[i];
      if (!item) {
        continue;
      }
      const cost = item.entry.summary.length;
      if (selected.length < HARD_TOP) {
        selected.push(item.entry);
        consumed += cost;
        continue;
      }
      if (consumed + cost > input.charBudget) {
        break;
      }
      selected.push(item.entry);
      consumed += cost;
    }

    if (selected.length > 0 && this.#store.markUsage) {
      const nowIso = now.toISOString();
      this.#store
        .markUsage({
          ids: selected.map((entry) => entry.id),
          lastUsedAt: nowIso,
        })
        .catch(() => {
          // usage tracking is best-effort
        });
    }

    this.#logger.info("memory.select_for_review", {
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
      candidatesScanned: active.length,
      selected: selected.length,
      charBudget: input.charBudget,
      charBudgetUsed: consumed,
      queryEmbedded: queryEmbedding !== null,
      durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
    });
    return selected;
  }
}

export interface MemoryIngestionResult {
  acknowledgments: string[];
  savedEntries: MemoryEntry[];
}

export interface MemoryMaintenanceResult {
  evicted: number;
  merged: number;
}

function mergeUnique(left: string[], right: string[]): string[] {
  const set = new Set<string>();
  for (const v of left) set.add(v);
  for (const v of right) set.add(v);
  return [...set];
}

function matchesGlob(path: string, glob: string): boolean {
  if (glob.length === 0) {
    return false;
  }
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DSTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DSTAR::/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

function scoreEntry(input: {
  entry: MemoryEntry;
  queryEmbedding: number[] | null;
  now: Date;
}): number {
  const similarity =
    input.queryEmbedding && input.entry.embedding
      ? cosineSimilarity(input.queryEmbedding, input.entry.embedding)
      : 0;
  const updatedAt = Date.parse(input.entry.updatedAt);
  const ageMs = Number.isFinite(updatedAt)
    ? Math.max(0, input.now.getTime() - updatedAt)
    : RECENCY_HALF_LIFE_MS;
  const recency = Math.exp(-ageMs / RECENCY_HALF_LIFE_MS);
  return 0.5 * similarity + 0.3 * input.entry.confidence + 0.2 * recency;
}
