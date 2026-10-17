import { describe, expect, it } from "vitest";

import { ChatReviewModel } from "../../src/review/chat-review-model.js";

describe("ChatReviewModel", () => {
  it("calls the chat completions API and parses structured JSON", async () => {
    let requestedUrl = "";
    let requestedBody = "";
    const model = new ChatReviewModel(
      {
        apiKey: "sk-test",
        model: "gpt-4.1",
        baseUrl: "http://openai-stub:4020/v1",
      },
      async (input, init) => {
        requestedUrl = String(input);
        requestedBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "Queue fairness improved.",
                    mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
                    findings: [],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    );

    const result = await model.generateStructuredReview({
      system: "system prompt",
      user: "user prompt",
    });

    expect(requestedUrl).toBe("http://openai-stub:4020/v1/chat/completions");
    expect(requestedBody).toContain('"temperature":0.1');
    expect(result).toEqual({
      summary: "Queue fairness improved.",
      mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
      findings: [],
    });
  });

  it("caps output tokens and fails fast on a truncated reply", async () => {
    let requestedBody = "";
    const model = new ChatReviewModel(
      { model: "m", baseUrl: "http://stub/v1" },
      async (_input, init) => {
        requestedBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: '{"summary": "loop loop' },
                finish_reason: "length",
              },
            ],
            usage: { completion_tokens: 6000 },
          }),
          { status: 200 },
        );
      },
    );

    await expect(
      model.generateStructuredReview({ system: "s", user: "u" }),
    ).rejects.toThrow(/token cap/);
    expect(JSON.parse(requestedBody).max_tokens).toBe(6000);
  });

  it("normalizes custom base URLs without duplicating the version prefix", async () => {
    let requestedUrl = "";
    const model = new ChatReviewModel(
      {
        apiKey: "sk-test",
        model: "gpt-4.1",
        baseUrl: "http://openai-stub:4020/",
      },
      async (input) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "Queue fairness improved.",
                    mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
                    findings: [],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    );

    await model.generateStructuredReview({
      system: "system prompt",
      user: "user prompt",
    });

    expect(requestedUrl).toBe("http://openai-stub:4020/v1/chat/completions");
  });

  it("rejects non-successful model responses", async () => {
    const model = new ChatReviewModel(
      {
        baseUrl: "http://localhost:11434/v1",
        apiKey: "sk-test",
        model: "gpt-4.1",
      },
      async () =>
        new Response(
          JSON.stringify({
            error: { message: "bad request" },
          }),
          {
            status: 400,
          },
        ),
    );

    await expect(() =>
      model.generateStructuredReview({
        system: "system prompt",
        user: "user prompt",
      }),
    ).rejects.toThrow(/Model request failed/i);
  });

  it("rejects invalid JSON content from the model", async () => {
    const model = new ChatReviewModel(
      {
        baseUrl: "http://localhost:11434/v1",
        apiKey: "sk-test",
        model: "gpt-4.1",
      },
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "not-json",
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    await expect(() =>
      model.generateStructuredReview({
        system: "system prompt",
        user: "user prompt",
      }),
    ).rejects.toThrow(/valid JSON/i);
  });

  it("sends reasoning_effort only when configured", async () => {
    const bodies: string[] = [];
    const respond = async (_input: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"summary":"ok","findings":[]}' } }],
        }),
        { status: 200 },
      );
    };
    await new ChatReviewModel(
      {
        baseUrl: "http://localhost:11434/v1",
        apiKey: "ollama",
        model: "qwen3.6:35b-a3b-nvfp4",
        reasoningEffort: "none",
      },
      respond,
    ).generateStructuredReview({ system: "s", user: "u" });
    await new ChatReviewModel(
      { baseUrl: "http://localhost:11434/v1", model: "qwen3.6:35b-a3b-nvfp4" },
      respond,
    ).generateStructuredReview({ system: "s", user: "u" });

    expect(JSON.parse(bodies[0] ?? "{}").reasoning_effort).toBe("none");
    expect(JSON.parse(bodies[1] ?? "{}")).not.toHaveProperty(
      "reasoning_effort",
    );
  });

  it("aborts requests that exceed timeoutMs and reports a retryable ModelOutputError", async () => {
    const model = new ChatReviewModel(
      { baseUrl: "http://localhost:11434/v1", model: "local", timeoutMs: 20 },
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );

    await expect(() =>
      model.generateStructuredReview({ system: "s", user: "u" }),
    ).rejects.toThrow(/timed out after 20ms/);
  });

  it("accepts JSON wrapped in think blocks and code fences", async () => {
    const model = new ChatReviewModel(
      { baseUrl: "http://localhost:11434/v1", model: "local" },
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '<think>let me look</think>\n```json\n{"summary":"fenced","findings":[]}\n```',
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    await expect(
      model.generateStructuredReview({ system: "s", user: "u" }),
    ).resolves.toEqual({ summary: "fenced", findings: [] });
  });

  it("nudges the model once when the reply is not JSON, then succeeds", async () => {
    const bodies: string[] = [];
    let usageSeen: number | undefined;
    const model = new ChatReviewModel(
      {
        baseUrl: "http://localhost:11434/v1",
        apiKey: "ollama",
        model: "local",
        onCompletion: (info) => {
          usageSeen = info.attempts;
        },
      },
      async (_input, init) => {
        bodies.push(String(init?.body ?? ""));
        const content =
          bodies.length === 1
            ? "Sure! Here is my review in prose."
            : '{"summary":"second try","findings":[]}';
        return new Response(
          JSON.stringify({ choices: [{ message: { content } }] }),
          { status: 200 },
        );
      },
    );

    const result = await model.generateStructuredReview({
      system: "s",
      user: "u",
    });

    expect(result).toEqual({ summary: "second try", findings: [] });
    expect(bodies).toHaveLength(2);
    const retryMessages = JSON.parse(bodies[1] ?? "{}").messages as Array<{
      role: string;
      content: string;
    }>;
    expect(retryMessages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(retryMessages[3]?.content).toMatch(/only the JSON object/i);
    expect(usageSeen).toBe(2);
  });

  it("sends no authorization header without an API key and asks for strict JSON Schema output when given one", async () => {
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    const model = new ChatReviewModel(
      { baseUrl: "http://localhost:11434", model: "local" },
      async (_input, init) => {
        headers = init?.headers as Record<string, string>;
        body = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: '{"summary":"ok","findings":[]}' } },
            ],
          }),
          { status: 200 },
        );
      },
    );

    await model.generateStructuredReview({
      system: "s",
      user: "u",
      jsonSchema: { name: "review", schema: { type: "object" } },
    });

    expect(headers).not.toHaveProperty("authorization");
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "review", strict: true, schema: { type: "object" } },
    });
  });
});

describe("ChatCompletionClient text mode", () => {
  it("omits response_format for prose replies", async () => {
    const { ChatCompletionClient } = await import(
      "../../src/shared/chat-completion-client.js"
    );
    let body: Record<string, unknown> = {};
    const client = new ChatCompletionClient(
      { model: "m", baseUrl: "http://stub/v1" },
      async (_input, init) => {
        body = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "plain" } }] }),
          { status: 200 },
        );
      },
    );
    await client.complete({
      messages: [{ role: "user", content: "hi" }],
      responseFormat: "text",
      maxOutputTokens: 800,
    });
    expect(body).not.toHaveProperty("response_format");
    expect(body.max_tokens).toBe(800);
  });
});
