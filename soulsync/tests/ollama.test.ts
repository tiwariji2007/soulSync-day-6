import { describe, expect, it, vi } from "vitest";
import {
  AiServiceError,
  chat,
  chatStream,
  embed,
  type OllamaConfig,
  type StreamEvent,
} from "@/src/lib/ai/ollama";

function config(fetchImpl: unknown): OllamaConfig {
  return {
    baseUrl: "http://llm",
    chatModel: "chat-model",
    embeddingModel: "embed-model",
    fetchImpl: fetchImpl as typeof fetch,
  };
}

/** A streaming Response that delivers the given raw chunks one by one. */
function ndjsonResponse(chunks: string[], options: { failAfter?: number } = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (options.failAfter !== undefined && index === options.failAfter) {
          controller.error(new TypeError("socket hang up"));
          return;
        }
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[index++]));
      },
    })
  );
}

async function collect(stream: AsyncIterable<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function errorCode(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AiServiceError);
  return (error as AiServiceError).code;
}

describe("embed", () => {
  it("returns a validated embedding", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ embeddings: [[0.1, 0.2, 0.3]], prompt_eval_count: 4 })
    );
    const result = await embed(config(fetchImpl), "hi", { dimensions: 3 });

    expect(result).toEqual({ embedding: [0.1, 0.2, 0.3], promptTokens: 4 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://llm/api/embed");
    expect(JSON.parse(init.body as string)).toEqual({ model: "embed-model", input: "hi" });
  });

  it.each([
    ["wrong dimensions", { embeddings: [[0.1, 0.2]] }],
    ["non-numeric values", { embeddings: [[0.1, "x", 0.3]] }],
    ["missing embeddings", {}],
  ])("rejects %s", async (_label, body) => {
    const code = await errorCode(
      embed(config(async () => Response.json(body)), "hi", { dimensions: 3 })
    );
    expect(code).toBe("LLM_BAD_RESPONSE");
  });
});

describe("chat", () => {
  it("returns text and token usage", async () => {
    const result = await chat(
      config(async () =>
        Response.json({ message: { content: "Hello" }, prompt_eval_count: 9, eval_count: 2 })
      ),
      [{ role: "user", content: "hi" }]
    );
    expect(result).toEqual({ text: "Hello", promptTokens: 9, completionTokens: 2 });
  });

  it.each([
    ["HTTP 500", async () => new Response("x", { status: 500 }), "LLM_HTTP_ERROR", 503],
    ["connection refused", async () => { throw new TypeError("fetch failed"); }, "LLM_UNAVAILABLE", 503],
    ["timeout", async () => { throw new DOMException("t", "TimeoutError"); }, "LLM_TIMEOUT", 504],
    ["no message", async () => Response.json({}), "LLM_BAD_RESPONSE", 503],
  ])("maps %s to %s / HTTP %i", async (_label, impl, code, status) => {
    const error = await chat(config(impl), []).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiServiceError);
    expect((error as AiServiceError).code).toBe(code);
    expect((error as AiServiceError).httpStatus).toBe(status);
  });

  it("does not leak the upstream body", async () => {
    const error = await chat(
      config(async () => new Response("Bearer sk-live-123", { status: 401 })),
      []
    ).catch((caught: unknown) => caught as Error);
    expect((error as Error).message).not.toContain("sk-live");
  });
});

describe("chatStream", () => {
  it("parses NDJSON split across arbitrary chunk boundaries", async () => {
    const lines = [
      JSON.stringify({ message: { content: "Hel" }, done: false }),
      JSON.stringify({ message: { content: "lo" }, done: false }),
      JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 11, eval_count: 3 }),
    ].join("\n");
    // Split mid-line to prove buffering works.
    const chunks = [lines.slice(0, 10), lines.slice(10, 47), lines.slice(47)];

    const events = await collect(
      chatStream(config(async () => ndjsonResponse(chunks)), [])
    );

    expect(events).toEqual([
      { type: "token", text: "Hel" },
      { type: "token", text: "lo" },
      { type: "done", promptTokens: 11, completionTokens: 3 },
    ]);
  });

  it("fails when the stream ends without done", async () => {
    const chunks = [JSON.stringify({ message: { content: "Hi" }, done: false }) + "\n"];
    const code = await errorCode(collect(chatStream(config(async () => ndjsonResponse(chunks)), [])));
    expect(code).toBe("LLM_BAD_RESPONSE");
  });

  it("fails on malformed chunks and upstream error objects", async () => {
    expect(
      await errorCode(collect(chatStream(config(async () => ndjsonResponse(["{oops\n"])), [])))
    ).toBe("LLM_BAD_RESPONSE");
    expect(
      await errorCode(
        collect(chatStream(config(async () => ndjsonResponse(['{"error":"model not found"}\n'])), []))
      )
    ).toBe("LLM_BAD_RESPONSE");
  });

  it("surfaces a mid-stream network failure after yielding earlier tokens", async () => {
    const first = JSON.stringify({ message: { content: "Partial" }, done: false }) + "\n";
    const received: StreamEvent[] = [];
    const error = await (async () => {
      for await (const event of chatStream(
        config(async () => ndjsonResponse([first], { failAfter: 1 })),
        []
      )) {
        received.push(event);
      }
    })().catch((caught: unknown) => caught);

    expect(received).toEqual([{ type: "token", text: "Partial" }]);
    expect(error).toBeInstanceOf(AiServiceError);
    expect((error as AiServiceError).code).toBe("LLM_UNAVAILABLE");
  });

  it("forwards the caller's abort signal to fetch", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const fetchImpl = async (_url: unknown, init: RequestInit) => {
      seen = init.signal ?? undefined;
      return ndjsonResponse([JSON.stringify({ done: true }) + "\n"]);
    };
    await collect(chatStream(config(fetchImpl), [], { signal: controller.signal }));

    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(seen?.aborted).toBe(true);
  });
});
