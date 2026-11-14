import { describe, expect, it, vi } from "vitest";
import { LlmError, createOllamaJsonGenerator } from "@/lib/llm/ollama";

function generatorWith(fetchImpl: unknown) {
  return createOllamaJsonGenerator({
    model: "test-model",
    baseUrl: "http://llm",
    fetchImpl: fetchImpl as typeof fetch,
  });
}

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(LlmError);
  return (error as LlmError).code;
}

describe("createOllamaJsonGenerator", () => {
  it("sends a JSON-mode request and maps token counts", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ response: "{}", prompt_eval_count: 12, eval_count: 7 })
    );
    const result = await generatorWith(fetchImpl)("prompt");

    expect(result).toEqual({ text: "{}", promptTokens: 12, completionTokens: 7 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://llm/api/generate");
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "test-model",
      prompt: "prompt",
      format: "json",
      stream: false,
      options: { temperature: 0 },
    });
  });

  it("defaults missing or invalid token counts to zero", async () => {
    const result = await generatorWith(async () =>
      Response.json({ response: "{}", eval_count: -3 })
    )("p");
    expect(result).toMatchObject({ promptTokens: 0, completionTokens: 0 });
  });

  const cases: [string, () => Promise<Response>, string][] = [
    ["HTTP errors", async () => new Response("boom", { status: 500 }), "LLM_HTTP_ERROR"],
    ["non-JSON bodies", async () => new Response("<html>"), "LLM_BAD_RESPONSE"],
    ["missing text", async () => Response.json({ eval_count: 1 }), "LLM_BAD_RESPONSE"],
    [
      "network failures",
      async () => {
        throw new TypeError("fetch failed");
      },
      "LLM_UNAVAILABLE",
    ],
    [
      "timeouts",
      async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
      "LLM_TIMEOUT",
    ],
  ];

  it.each(cases)("maps %s to a typed error", async (_label, impl, code) => {
    expect(await codeOf(generatorWith(impl)("p"))).toBe(code);
  });

  it("never includes the upstream body in the error message", async () => {
    const error = await generatorWith(
      async () => new Response("api_key=sk-secret", { status: 401 })
    )("p").catch((caught: unknown) => caught as Error);
    expect((error as Error).message).not.toContain("sk-secret");
  });
});
