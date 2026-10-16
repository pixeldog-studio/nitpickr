import { describe, expect, it } from "vitest";

import {
  type MemoryClassifier,
  type MemoryEmbedder,
  type MemoryEntry,
  type MemoryKind,
  MemoryService,
  type MemoryStore,
} from "../../src/memory/memory-service.js";

class InMemoryMemoryStore implements MemoryStore {
  readonly entries: MemoryEntry[] = [];
  readonly supersededOps: Array<{
    supersededId: string;
    supersededBy: string;
  }> = [];
  readonly usageOps: Array<{ ids: string[]; lastUsedAt: string }> = [];

  async save(entries: MemoryEntry[]): Promise<void> {
    for (const entry of entries) {
      const idx = this.entries.findIndex((e) => e.id === entry.id);
      if (idx >= 0) {
        this.entries[idx] = entry;
      } else {
        this.entries.push(entry);
      }
    }
  }

  async listByRepository(input: {
    tenantId: string;
    repositoryId: string;
  }): Promise<MemoryEntry[]> {
    return this.entries.filter(
      (entry) =>
        entry.tenantId === input.tenantId &&
        entry.repositoryId === input.repositoryId,
    );
  }

  async findNearestNeighbors(input: {
    tenantId: string;
    repositoryId: string;
    embedding: number[];
    kind?: MemoryKind;
    limit: number;
  }): Promise<Array<{ entry: MemoryEntry; similarity: number }>> {
    const active = this.entries.filter(
      (entry) =>
        entry.tenantId === input.tenantId &&
        entry.repositoryId === input.repositoryId &&
        entry.supersededBy === null &&
        entry.embedding !== null,
    );
    const candidates = input.kind
      ? active.filter((entry) => entry.kind === input.kind)
      : active;
    return candidates
      .map((entry) => ({
        entry,
        similarity: cosine(entry.embedding ?? [], input.embedding),
      }))
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, input.limit);
  }

  async markSuperseded(input: {
    supersededId: string;
    supersededBy: string;
    updatedAt: string;
  }): Promise<void> {
    this.supersededOps.push({
      supersededId: input.supersededId,
      supersededBy: input.supersededBy,
    });
    const target = this.entries.find(
      (entry) => entry.id === input.supersededId,
    );
    if (target) {
      target.supersededBy = input.supersededBy;
      target.updatedAt = input.updatedAt;
    }
  }

  async markUsage(input: { ids: string[]; lastUsedAt: string }): Promise<void> {
    this.usageOps.push(input);
    for (const id of input.ids) {
      const target = this.entries.find((entry) => entry.id === id);
      if (target) {
        target.usageCount += 1;
        target.lastUsedAt = input.lastUsedAt;
      }
    }
  }
}

function cosine(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let ln = 0;
  let rn = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    dot += a * b;
    ln += a * a;
    rn += b * b;
  }
  if (ln === 0 || rn === 0) return 0;
  return dot / (Math.sqrt(ln) * Math.sqrt(rn));
}

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "mem_x",
    tenantId: "tenant_1",
    repositoryId: "repo_1",
    kind: "preferred_pattern",
    summary: "",
    path: null,
    tags: [],
    globs: [],
    confidence: 0.8,
    usageCount: 0,
    lastUsedAt: null,
    embedding: null,
    supersededBy: null,
    source: "discussion",
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    ...overrides,
  };
}

describe("MemoryService", () => {
  it("extracts durable preferences from discussion comments", async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store, {
      now: () => new Date("2026-03-09T10:00:00.000Z"),
      createId: () => "memory_1",
    });

    await service.ingestDiscussion({
      tenantId: "tenant_1",
      repositoryId: "repo_1",
      discussions: [
        {
          authorLogin: "maintainer",
          body: "Prefer stable ordering in queue implementations under src/queue.",
          path: "src/queue/queue-scheduler.ts",
        },
      ],
    });

    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]?.kind).toBe("preferred_pattern");
    expect(store.entries[0]?.summary).toContain("Prefer stable ordering");
  });

  it("extracts false positive feedback", async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store, {
      now: () => new Date("2026-03-09T10:00:00.000Z"),
      createId: () => "memory_1",
    });

    await service.ingestDiscussion({
      tenantId: "tenant_1",
      repositoryId: "repo_1",
      discussions: [
        {
          authorLogin: "maintainer",
          body: "This is a false positive; this path intentionally allows unstable ordering.",
          path: "src/queue/queue-scheduler.ts",
        },
      ],
    });

    expect(store.entries[0]?.kind).toBe("false_positive");
  });

  it("retrieves only path-relevant memories", async () => {
    const store = new InMemoryMemoryStore();
    store.entries.push(
      {
        id: "memory_1",
        tenantId: "tenant_1",
        repositoryId: "repo_1",
        kind: "preferred_pattern",
        summary: "Prefer stable ordering.",
        path: "src/queue",
        tags: [],
        globs: [],
        confidence: 0.9,
        usageCount: 0,
        lastUsedAt: null,
        embedding: null,
        supersededBy: null,
        source: "discussion",
        createdAt: "2026-03-09T10:00:00.000Z",
        updatedAt: "2026-03-09T10:00:00.000Z",
      },
      {
        id: "memory_2",
        tenantId: "tenant_1",
        repositoryId: "repo_1",
        kind: "preferred_pattern",
        summary: "Use typed HTTP clients.",
        path: "src/api",
        tags: [],
        globs: [],
        confidence: 0.6,
        usageCount: 0,
        lastUsedAt: null,
        embedding: null,
        supersededBy: null,
        source: "discussion",
        createdAt: "2026-03-09T10:00:00.000Z",
        updatedAt: "2026-03-09T10:00:00.000Z",
      },
    );
    const service = new MemoryService(store);

    const relevant = await service.getRelevantMemories({
      tenantId: "tenant_1",
      repositoryId: "repo_1",
      paths: ["src/queue/queue-scheduler.ts"],
      limit: 5,
    });

    expect(relevant).toHaveLength(1);
    expect(relevant[0]?.id).toBe("memory_1");
  });

  it("uses the classifier when provided and returns an acknowledgment", async () => {
    const store = new InMemoryMemoryStore();
    const classifier: MemoryClassifier = {
      async extract() {
        return {
          entries: [
            {
              kind: "coding_convention",
              summary: "Use zod for runtime input validation.",
              tags: ["language:typescript"],
              globs: ["src/api/**"],
              confidence: 0.9,
            },
          ],
          acknowledgment:
            "Got it — I'll remember that zod is preferred for input validation.",
        };
      },
    };
    let idCounter = 0;
    const service = new MemoryService(store, {
      classifier,
      now: () => new Date("2026-03-09T10:00:00.000Z"),
      createId: () => {
        idCounter += 1;
        return `mem_${idCounter}`;
      },
    });

    const result = await service.ingestDiscussion({
      tenantId: "tenant_1",
      repositoryId: "repo_1",
      discussions: [
        {
          authorLogin: "maintainer",
          body: "Please use zod everywhere we parse external input.",
          path: "src/api/server.ts",
        },
      ],
    });

    expect(result.acknowledgments[0]).toContain("zod is preferred");
    expect(result.savedEntries).toHaveLength(1);
    expect(store.entries[0]?.kind).toBe("coding_convention");
    expect(store.entries[0]?.globs).toEqual(["src/api/**"]);
  });

  it("dedups semantically-similar memory entries on write and bumps confidence", async () => {
    const store = new InMemoryMemoryStore();
    store.entries.push(
      makeEntry({
        id: "mem_existing",
        kind: "coding_convention",
        summary: "Use zod for runtime input validation.",
        confidence: 0.8,
        embedding: [1, 0, 0],
      }),
    );

    const classifier: MemoryClassifier = {
      async extract() {
        return {
          entries: [
            {
              kind: "coding_convention",
              summary: "Prefer zod for parsing external inputs.",
              tags: [],
              globs: [],
              confidence: 0.9,
            },
          ],
          acknowledgment: "ack",
        };
      },
    };
    const embedder: MemoryEmbedder = {
      async embed() {
        return [1, 0, 0];
      },
    };
    let idCounter = 0;
    const service = new MemoryService(store, {
      classifier,
      embedder,
      now: () => new Date("2026-04-01T10:00:00.000Z"),
      createId: () => {
        idCounter += 1;
        return `mem_new_${idCounter}`;
      },
    });

    await service.ingestDiscussion({
      tenantId: "tenant_1",
      repositoryId: "repo_1",
      discussions: [
        {
          authorLogin: "maintainer",
          body: "Prefer zod for parsing external inputs.",
          path: null,
        },
      ],
    });

    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]?.id).toBe("mem_existing");
    expect(store.entries[0]?.confidence).toBeGreaterThan(0.8);
  });

  it("supersedes an older entry when supersedesHint matches", async () => {
    const store = new InMemoryMemoryStore();
    store.entries.push(
      makeEntry({
        id: "mem_old",
        kind: "coding_convention",
        summary: "Use yup for validation.",
        confidence: 0.6,
        embedding: [1, 0, 0],
      }),
    );

    const classifier: MemoryClassifier = {
      async extract() {
        return {
          entries: [
            {
              kind: "coding_convention",
              summary: "Use zod for validation now (we replaced yup).",
              tags: [],
              globs: [],
              confidence: 0.95,
              supersedesHint: "yup for validation",
            },
          ],
          acknowledgment: "ack",
        };
      },
    };
    const embedder: MemoryEmbedder = {
      async embed() {
        return [1, 0, 0];
      },
    };
    const service = new MemoryService(store, {
      classifier,
      embedder,
      now: () => new Date("2026-04-01T10:00:00.000Z"),
      createId: () => "mem_new",
    });

    // Use a different embedding direction to bypass dedup
    const directionalEmbedder: MemoryEmbedder = {
      async embed() {
        return [0, 1, 0];
      },
    };
    service.configureBackends({ embedder: directionalEmbedder });

    await service.ingestDiscussion({
      tenantId: "tenant_1",
      repositoryId: "repo_1",
      discussions: [{ authorLogin: "user", body: "switch to zod", path: null }],
    });

    const oldEntry = store.entries.find((entry) => entry.id === "mem_old");
    expect(oldEntry?.supersededBy).toBe("mem_new");
  });

  it("selectMemoriesForReview ranks by combined score and marks usage", async () => {
    const store = new InMemoryMemoryStore();
    const baseEntries: MemoryEntry[] = [
      makeEntry({
        id: "mem_a",
        summary: "Auth tokens must use HS256.",
        confidence: 0.95,
        embedding: [1, 0, 0],
        updatedAt: "2026-04-01T10:00:00.000Z",
      }),
      makeEntry({
        id: "mem_b",
        summary: "Queue scheduler must preserve insertion order.",
        confidence: 0.5,
        embedding: [0, 1, 0],
        updatedAt: "2025-12-01T10:00:00.000Z",
      }),
      makeEntry({
        id: "mem_c",
        summary: "Old preference that nobody uses.",
        confidence: 0.3,
        embedding: [0, 0, 1],
        updatedAt: "2025-01-01T10:00:00.000Z",
      }),
    ];
    store.entries.push(...baseEntries);

    const embedder: MemoryEmbedder = {
      async embed() {
        // Query is similar to mem_a's embedding direction.
        return [0.99, 0.1, 0];
      },
    };
    const service = new MemoryService(store, {
      embedder,
      now: () => new Date("2026-04-15T10:00:00.000Z"),
    });

    const selected = await service.selectMemoriesForReview({
      tenantId: "tenant_1",
      repositoryId: "repo_1",
      reviewedPaths: ["src/auth/login.ts"],
      reviewContext: "Improve auth token handling",
      charBudget: 10_000,
    });

    expect(selected[0]?.id).toBe("mem_a");
    // wait a tick for usage update fire-and-forget
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.usageOps).toHaveLength(1);
    expect(store.usageOps[0]?.ids).toContain("mem_a");
  });

  it("runMaintenance evicts unused low-confidence entries and merges duplicates", async () => {
    const store = new InMemoryMemoryStore();
    store.entries.push(
      makeEntry({
        id: "mem_stale",
        summary: "Old unused preference.",
        confidence: 0.2,
        lastUsedAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      }),
      makeEntry({
        id: "mem_dup_a",
        summary: "Prefer zod for validation.",
        confidence: 0.9,
        embedding: [1, 0, 0],
      }),
      makeEntry({
        id: "mem_dup_b",
        summary: "prefer ZOD for validation.",
        confidence: 0.7,
        embedding: [1, 0, 0],
      }),
    );
    const service = new MemoryService(store, {
      now: () => new Date("2026-04-15T10:00:00.000Z"),
    });

    const result = await service.runMaintenance({
      tenantId: "tenant_1",
      repositoryId: "repo_1",
    });

    expect(result.evicted).toBe(1);
    expect(result.merged).toBe(1);
    const stale = store.entries.find((entry) => entry.id === "mem_stale");
    expect(stale?.supersededBy).toBe("mem_stale");
    const dupB = store.entries.find((entry) => entry.id === "mem_dup_b");
    expect(dupB?.supersededBy).toBe("mem_dup_a");
  });

  it("ignores non-durable discussion comments", async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store, {
      now: () => new Date("2026-03-09T10:00:00.000Z"),
      createId: () => "memory_1",
    });

    await service.ingestDiscussion({
      tenantId: "tenant_1",
      repositoryId: "repo_1",
      discussions: [
        {
          authorLogin: "maintainer",
          body: "Thanks, looks good.",
          path: null,
        },
      ],
    });

    expect(store.entries).toEqual([]);
  });
});

/** Bag-of-words embedder: similar wording gives a high cosine. */
const wordEmbedder: MemoryEmbedder = {
  async embed(text: string) {
    const vector = new Array(64).fill(0);
    for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      let hash = 0;
      for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % 64;
      vector[hash] += 1;
    }
    return vector;
  },
};

describe("MemoryService dismissals", () => {
  it("records dismissed findings per repository and finds look-alikes", async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store, { embedder: wordEmbedder });

    const saved = await service.recordDismissedFinding({
      tenantId: "tenant_1",
      repositoryId: "repo_1",
      path: "src/users.ts",
      title: "fetch call has no timeout",
      body: "A slow upstream can hang the request.",
      signal: "thumbs_down",
    });
    expect(saved?.kind).toBe("dismissed_finding");
    expect(saved?.summary).toBe(
      "fetch call has no timeout. A slow upstream can hang the request.",
    );

    const similar = await service.findSimilarDismissals({
      tenantId: "tenant_1",
      repositoryId: "repo_1",
      text: "fetch call has no timeout. A hung upstream blocks the request.",
      minSimilarity: 0.3,
    });
    expect(similar).toHaveLength(1);

    const unrelated = await service.findSimilarDismissals({
      tenantId: "tenant_1",
      repositoryId: "repo_1",
      text: "SQL injection through string interpolation in search query",
      minSimilarity: 0.3,
    });
    expect(unrelated).toEqual([]);

    const otherRepo = await service.findSimilarDismissals({
      tenantId: "tenant_1",
      repositoryId: "repo_2",
      text: "fetch call has no timeout",
      minSimilarity: 0.3,
    });
    expect(otherRepo).toEqual([]);
  });

  it("finds nothing without an embedder", async () => {
    const service = new MemoryService(new InMemoryMemoryStore());
    expect(
      await service.findSimilarDismissals({
        tenantId: "t",
        repositoryId: "r",
        text: "x",
        minSimilarity: 0.1,
      }),
    ).toEqual([]);
  });
});
