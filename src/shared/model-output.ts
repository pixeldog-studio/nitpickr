/**
 * Helpers for tolerating imperfect structured output from OpenAI-compatible
 * models (notably local models served by Ollama/vLLM), which sometimes wrap
 * JSON in code fences, prepend `<think>` blocks, or add trailing prose even in
 * `json_object` mode.
 */

/**
 * Error class for model-side failures that are worth retrying at the job
 * level: malformed/empty output and client timeouts. Distinct from HTTP
 * failures so the worker can classify it without string matching.
 */
export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

/**
 * The reply hit the output-token cap. Retrying the same prompt usually
 * truncates the same way, so callers handle it instead of the job retry.
 */
export class TruncatedOutputError extends ModelOutputError {
  constructor(message: string) {
    super(message);
    this.name = "TruncatedOutputError";
  }
}

/**
 * The model server stopped serving the model (seen with Ollama: after a
 * swap to another client's model, its scheduler never loaded ours again and
 * every request hung until the timeout). Retryable: it usually recovers or
 * gets restarted.
 */
export class ModelServerStalledError extends ModelOutputError {
  constructor(message: string) {
    super(message);
    this.name = "ModelServerStalledError";
  }
}

export type JsonExtraction =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

const THINK_BLOCK = /^\s*<think>[\s\S]*?<\/think>\s*/i;
const CODE_FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i;

/**
 * Parse `content` as a JSON object, tolerating common decorations. Tries, in
 * order: raw parse; parse after stripping a leading `<think>` block and/or a
 * surrounding code fence; parse of the outermost `{...}` span.
 */
export function extractJsonObject(content: string): JsonExtraction {
  const attempts: string[] = [content];

  let stripped = content.replace(THINK_BLOCK, "");
  const fence = CODE_FENCE.exec(stripped);
  if (fence?.[1] !== undefined) {
    stripped = fence[1];
  }
  if (stripped !== content) {
    attempts.push(stripped);
  }

  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const span = stripped.slice(start, end + 1);
    if (span !== stripped) {
      attempts.push(span);
    }
  }

  let lastReason = "content is empty";
  for (const candidate of attempts) {
    if (candidate.trim().length === 0) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(candidate);
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        return { ok: true, value };
      }
      lastReason = "content is JSON but not an object";
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }

  return { ok: false, reason: lastReason };
}
