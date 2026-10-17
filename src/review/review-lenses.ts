/**
 * Review lenses: short, checkable questions per concern, picked by the stacks
 * present in a chunk. Small models follow short focused prompts better than
 * one long rule list, so only relevant lenses are rendered.
 *
 * Sources: Google eng-practices "What to look for", OWASP Top 10 (2025),
 * Swift concurrency migration guide, WWDC23/25 SwiftUI performance, Node.js
 * best practices, strong_migrations / squawk, Bandit/Ruff rule families.
 */

export type ReviewStack = "swift" | "typescript" | "python" | "sql";

interface Lens {
  name: string;
  /** Stacks this lens applies to; undefined = every stack. */
  stacks?: ReviewStack[];
  questions: string[];
}

const lenses: Lens[] = [
  {
    name: "Security",
    questions: [
      "Does every new route, action or RPC check authorization on the specific resource, not just that a user is signed in?",
      "Is untrusted input validated at the boundary before use?",
      "Is any query, shell command or template built by string interpolation of untrusted input?",
      "Can secrets, tokens or private fields leak into logs, responses or client bundles?",
      "Does an error path fail open (grant access or skip a check)?",
    ],
  },
  {
    name: "Reliability",
    questions: [
      "Does every network or database call have a timeout?",
      "Do retries back off, stop on non-retryable errors, and stay idempotent?",
      "Is an error swallowed, or a failure possible after state was already committed (data loss)?",
      "Is a promise or task left unawaited or unreferenced?",
    ],
  },
  {
    name: "Correctness and concurrency",
    questions: [
      "Do edge cases break: empty, null, zero, boundaries, off-by-one, units?",
      "Is there check-then-act across an await or without a transaction (race)?",
      "Is a variable read on a path where it was never assigned?",
    ],
  },
  {
    name: "Swift",
    stacks: ["swift"],
    questions: [
      "Is actor state assumed unchanged after an await (reentrancy)?",
      "Is blocking work (network, disk, heavy CPU) done on the main actor?",
      "Is a force unwrap or force try applied to external input?",
      "Is the data-race checker silenced (@unchecked Sendable, nonisolated(unsafe)) without reason?",
      "Is a SwiftData ModelContext or model passed across actors?",
    ],
  },
  {
    name: "TypeScript and Node",
    stacks: ["typescript"],
    questions: [
      "Does a Next.js server action or API route trust the caller without checking ownership?",
      "Is the event loop blocked by sync fs/crypto calls or unbounded JSON parsing in a request path?",
      "Is a list, query or payload unbounded (no limit or pagination)?",
    ],
  },
  {
    name: "Python",
    stacks: ["python"],
    questions: [
      "Is a blocking call (requests, time.sleep, sync DB) made inside async def?",
      "Is subprocess called with shell=True, or yaml.load/pickle used on untrusted data?",
      "Does a bare except or except Exception: pass hide failures?",
    ],
  },
  {
    name: "Data and migrations",
    stacks: ["sql"],
    questions: [
      "Is a new table in an exposed schema missing row level security?",
      "Is an index created without CONCURRENTLY on a large table, or a constraint added without NOT VALID?",
      "Is a large backfill done in one statement instead of batches?",
      "Does a rename, type change or drop break code that is still deployed?",
    ],
  },
];

const stackByExtension: Array<[RegExp, ReviewStack]> = [
  [/\.swift$/, "swift"],
  [/\.(ts|tsx|js|jsx|mjs|cjs|astro|vue|svelte)$/, "typescript"],
  [/\.py$/, "python"],
  [/\.sql$/, "sql"],
];

export function stacksForPaths(paths: string[]): Set<ReviewStack> {
  const stacks = new Set<ReviewStack>();
  for (const path of paths) {
    const stack = stackByExtension.find(([pattern]) => pattern.test(path))?.[1];
    if (stack) {
      stacks.add(stack);
    }
  }
  return stacks;
}

/** Render the lenses that apply to these files as a compact checklist. */
export function renderReviewLenses(paths: string[]): string {
  const stacks = stacksForPaths(paths);
  return lenses
    .filter(
      (lens) =>
        lens.stacks === undefined ||
        lens.stacks.some((stack) => stacks.has(stack)),
    )
    .map(
      (lens) =>
        `${lens.name}:\n${lens.questions.map((question) => `- ${question}`).join("\n")}`,
    )
    .join("\n");
}
