import { z } from "zod";

import type { ReasoningEffort } from "../config/app-config.js";
import { type Logger, noopLogger } from "../logging/logger.js";
import {
  createTimeoutFetch,
  type FetchLike,
  isTimeoutError,
} from "./http-client.js";
import { normalizeModelBaseUrl } from "./model-base-url.js";
import {
  ModelOutputError,
  ModelServerStalledError,
  TruncatedOutputError,
} from "./model-output.js";

/**
 * Minimal client for the `/v1/chat/completions` protocol spoken by local
 * model servers (Ollama, llama-server, LM Studio, vLLM). Shared by the review
 * model and the memory classifier so transport, auth, timeouts and logging
 * behave the same everywhere.
 */
/**
 * Output cap for every call. Reviews need ~1-2k tokens; without a cap a model
 * stuck in a repetition loop keeps generating (Ollama shifts its context
 * instead of stopping) until the request timeout, which blocks the queue.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 6_000;

/** Ollama reports "qwen3.8" as "qwen3.8:latest"; compare like it does. */
function canonicalModelName(name: string): string {
  const lower = name.trim().toLowerCase();
  const lastSegment = lower.slice(lower.lastIndexOf("/") + 1);
  return lastSegment.includes(":") ? lower : `${lower}:latest`;
}

/** Give up after the model has been missing from Ollama for ~3 minutes. */
export const DEFAULT_STALL_WATCH = { intervalMs: 60_000, maxMissing: 3 };

export interface ChatCompletionClientConfig {
  baseUrl: string;
  model: string;
  /** Sent as a bearer token when set; local servers usually need none. */
  apiKey?: string | null;
  /** Sent as `reasoning_effort` when set (thinking models). */
  reasoningEffort?: ReasoningEffort | null;
  /** Abort the request after this many milliseconds. Unset = no client timeout. */
  timeoutMs?: number;
  /** Sent as `max_tokens`; defaults to DEFAULT_MAX_OUTPUT_TOKENS. */
  maxOutputTokens?: number;
  /**
   * While a request runs, check Ollama's `/api/ps` every `intervalMs`; give
   * up once the model has been missing `maxMissing` times in a row. Turns
   * itself off when the server has no such endpoint. `false` disables it.
   */
  stallWatch?: { intervalMs: number; maxMissing: number } | false;
  logger?: Logger;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** JSON Schema the reply must follow; `null` falls back to plain JSON mode. */
export interface ResponseJsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

/** JSON Schema for a zod schema, without the `$schema` meta key servers reject. */
export function toResponseSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _meta, ...jsonSchema } = z.toJSONSchema(schema);
  return jsonSchema;
}

export class ChatCompletionClient {
  readonly #config: ChatCompletionClientConfig;
  readonly #fetch: FetchLike;
  readonly #logger: Logger;
  readonly #endpoint: string;

  constructor(config: ChatCompletionClientConfig, fetchFn?: FetchLike) {
    this.#config = config;
    // Default transport honours the configured timeout end-to-end (see
    // createTimeoutFetch for why plain fetch caps out at ~300 s).
    this.#fetch =
      fetchFn ??
      (config.timeoutMs ? createTimeoutFetch(config.timeoutMs) : fetch);
    this.#logger = config.logger ?? noopLogger;
    this.#endpoint = `${normalizeModelBaseUrl(config.baseUrl)}/chat/completions`;
  }

  get model(): string {
    return this.#config.model;
  }

  /**
   * Abort `stall` when Ollama reports the model as not loaded for too long.
   * A slow prompt still shows the model as loaded, so only a stuck server
   * (or one that unloaded the model mid-request) trips this.
   */
  #watchForStall(stall: AbortController): () => void {
    const watch =
      this.#config.stallWatch === undefined
        ? DEFAULT_STALL_WATCH
        : this.#config.stallWatch;
    if (watch === false) {
      return () => {};
    }
    const origin = this.#endpoint.replace(/\/v1\/chat\/completions$/, "");
    let missing = 0;
    let active = true;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const response = await this.#fetch(`${origin}/api/ps`, {
            method: "GET",
            signal: AbortSignal.timeout(5_000),
          });
          if (!response.ok) {
            // Not Ollama (or no such endpoint): nothing to watch.
            clearInterval(timer);
            return;
          }
          const payload = (await response.json()) as {
            models?: Array<{ name?: string; model?: string }>;
          };
          if (!Array.isArray(payload.models)) {
            clearInterval(timer);
            return;
          }
          const wanted = canonicalModelName(this.#config.model);
          const loaded = payload.models.some(
            (entry) =>
              canonicalModelName(entry.name ?? "") === wanted ||
              canonicalModelName(entry.model ?? "") === wanted,
          );
          if (!loaded && missing === 0) {
            this.#logger.warn("model.chat_completion model_not_loaded", {
              model: this.#config.model,
              loaded: payload.models.map((entry) => entry.name ?? entry.model),
            });
          }
          missing = loaded ? 0 : missing + 1;
          if (active && missing >= watch.maxMissing) {
            this.#logger.error("model.chat_completion stalled", {
              model: this.#config.model,
              missingChecks: missing,
            });
            stall.abort();
            clearInterval(timer);
          }
        } catch {
          // A failed probe proves nothing; the request timeout still applies.
        }
      })();
    }, watch.intervalMs);
    timer.unref?.();
    return () => {
      active = false;
      clearInterval(timer);
    };
  }

  async complete(input: {
    messages: ChatMessage[];
    temperature?: number;
    jsonSchema?: ResponseJsonSchema | null;
    /** "text" sends no response_format, for prose replies. */
    responseFormat?: "json" | "text";
    /** Overrides the client's output cap for this call. */
    maxOutputTokens?: number;
  }): Promise<{ content: string; usage: ChatUsage | undefined }> {
    const startedAt = process.hrtime.bigint();
    const elapsedMs = () =>
      Number((process.hrtime.bigint() - startedAt) / 1_000_000n);

    this.#logger.debug("model.chat_completion started", {});
    const stall = new AbortController();
    const stopWatch = this.#watchForStall(stall);
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          ...(this.#config.apiKey
            ? { authorization: `Bearer ${this.#config.apiKey}` }
            : {}),
          "content-type": "application/json",
        },
        signal: this.#config.timeoutMs
          ? AbortSignal.any([
              stall.signal,
              AbortSignal.timeout(this.#config.timeoutMs),
            ])
          : stall.signal,
        body: JSON.stringify({
          model: this.#config.model,
          max_tokens:
            input.maxOutputTokens ??
            this.#config.maxOutputTokens ??
            DEFAULT_MAX_OUTPUT_TOKENS,
          ...(input.temperature !== undefined
            ? { temperature: input.temperature }
            : {}),
          ...(this.#config.reasoningEffort
            ? { reasoning_effort: this.#config.reasoningEffort }
            : {}),
          ...(input.responseFormat === "text"
            ? {}
            : {
                response_format: input.jsonSchema
                  ? {
                      type: "json_schema",
                      json_schema: {
                        name: input.jsonSchema.name,
                        strict: true,
                        schema: input.jsonSchema.schema,
                      },
                    }
                  : { type: "json_object" },
              }),
          messages: input.messages,
        }),
      });
    } catch (error) {
      // Network/transport errors (incl. timeouts) that never produced a Response.
      this.#logger.error("model.chat_completion transport_error", {
        durationMs: elapsedMs(),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      if (stall.signal.aborted) {
        throw new ModelServerStalledError(
          `The model server stopped serving ${this.#config.model}.`,
        );
      }
      if (isTimeoutError(error)) {
        throw new ModelOutputError(
          `Model request timed out after ${this.#config.timeoutMs}ms.`,
        );
      }
      throw error;
    } finally {
      stopWatch();
    }

    if (!response.ok) {
      const details = await response.text();
      this.#logger.error("model.chat_completion failed", {
        status: response.status,
        durationMs: elapsedMs(),
        errorBody: details.slice(0, 500),
      });
      throw new Error(
        `Model request failed with status ${response.status}: ${details}`,
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string | null };
        finish_reason?: string | null;
      }>;
      usage?: ChatUsage;
    };
    const choice = payload.choices?.[0];
    if (choice?.finish_reason === "length") {
      this.#logger.error("model.chat_completion truncated", {
        durationMs: elapsedMs(),
        completionTokens: payload.usage?.completion_tokens,
        // The tail shows what the model was repeating.
        contentTail: choice.message?.content?.slice(-400) ?? null,
      });
      throw new TruncatedOutputError(
        "Model output hit the token cap before finishing (likely a repetition loop).",
      );
    }
    const content = choice?.message?.content;
    if (!content) {
      this.#logger.error("model.chat_completion empty_response", {
        durationMs: elapsedMs(),
      });
      throw new ModelOutputError(
        "Model response did not contain a message payload.",
      );
    }

    return { content, usage: payload.usage };
  }
}
