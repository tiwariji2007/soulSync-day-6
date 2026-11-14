import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AiServiceError } from "@/src/lib/ai/ollama";
import { createRateLimiter } from "@/src/lib/ai/rate-limit";
import type { UsageEntry } from "@/src/lib/ai/usage";
import { chunkFaqMarkdown, documentEmbeddingText, queryEmbeddingText } from "@/src/lib/faq/chunk";
import { handleFaq, type FaqHandlerDeps } from "@/src/lib/faq/handler";
import {
  answerFaqQuestion,
  groundingRatio,
  I_DONT_KNOW,
  isIDontKnow,
  MIN_SIMILARITY,
  type FaqDeps,
  type RetrievedChunk,
} from "@/src/lib/faq/rag";

const weeklyChunk: RetrievedChunk = {
  id: "c1",
  heading: "What are Weekly Insights?",
  content:
    "Weekly Insights summarizes your mood entries and journal entries from the last seven days.",
  similarity: 0.84,
};

const privacyChunk: RetrievedChunk = {
  id: "c2",
  heading: "Who can see my moods and journal entries?",
  content: "Your moods and journal entries are private to your account.",
  similarity: 0.65,
};

function ragDeps(overrides: Partial<FaqDeps> = {}): FaqDeps {
  return {
    embedQuestion: vi.fn(async () => ({ embedding: [0.1, 0.2], promptTokens: 6 })),
    search: vi.fn(async () => [weeklyChunk, privacyChunk]),
    chat: vi.fn(async () => ({
      text: "Weekly Insights summarizes your mood entries and journal entries from the last seven days.",
      promptTokens: 120,
      completionTokens: 20,
    })),
    ...overrides,
  };
}

describe("chunkFaqMarkdown", () => {
  it("creates one chunk per ## section of the real FAQ document", () => {
    const markdown = readFileSync(path.join(__dirname, "..", "data", "faq.md"), "utf8");
    const chunks = chunkFaqMarkdown(markdown);

    expect(chunks.length).toBe(9);
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(chunks[0]).toMatchObject({ heading: "What is SoulSync?" });
    expect(chunks.every((c) => c.content.length > 0 && !c.content.includes("## "))).toBe(true);
  });

  it("skips empty sections, handles CRLF and splits long sections on paragraphs", () => {
    const long = Array.from({ length: 5 }, (_, i) => `Paragraph ${i} ${"x".repeat(400)}`).join("\r\n\r\n");
    const chunks = chunkFaqMarkdown(`# T\r\n\r\n## Empty\r\n\r\n## Long\r\n\r\n${long}`);

    expect(chunks.every((c) => c.heading === "Long")).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length <= 1_200)).toBe(true);
    expect(chunks.map((c) => c.content).join("\n\n")).toBe(long.replace(/\r\n/g, "\n"));
  });

  it("uses the nomic-embed-text task prefixes", () => {
    expect(documentEmbeddingText({ heading: "H", content: "C" })).toBe("search_document: H\nC");
    expect(queryEmbeddingText("q")).toBe("search_query: q");
  });
});

describe("answerFaqQuestion", () => {
  it("answers from retrieved chunks and reports sources and summed tokens", async () => {
    const deps = ragDeps();
    const result = await answerFaqQuestion("What are weekly insights?", deps);

    expect(deps.search).toHaveBeenCalledWith([0.1, 0.2], { minSimilarity: MIN_SIMILARITY, limit: 3 });
    const messages = vi.mocked(deps.chat).mock.calls[0][0];
    expect(messages[0].content).toContain(`reply with exactly: ${I_DONT_KNOW}`);
    expect(messages[1].content).toContain(weeklyChunk.content);
    expect(messages[1].content).toContain("Question: What are weekly insights?");

    expect(result).toEqual({
      answer: expect.stringContaining("Weekly Insights"),
      sources: [
        { heading: weeklyChunk.heading, similarity: 0.84 },
        { heading: privacyChunk.heading, similarity: 0.65 },
      ],
      status: "success",
      promptTokens: 126,
      completionTokens: 20,
    });
  });

  it("returns exactly I don't know. without calling the model when nothing passes the threshold", async () => {
    const deps = ragDeps({ search: vi.fn(async () => []) });
    const result = await answerFaqQuestion("What is the capital of France?", deps);

    expect(result).toEqual({
      answer: "I don't know.",
      sources: [],
      status: "no_match",
      promptTokens: 6,
      completionTokens: 0,
    });
    expect(deps.chat).not.toHaveBeenCalled();
  });

  it("drops chunks below the threshold even if the store returns them", async () => {
    const weak = { ...privacyChunk, similarity: MIN_SIMILARITY - 0.01 };
    const deps = ragDeps({ search: vi.fn(async () => [weak]) });

    expect((await answerFaqQuestion("q", deps)).answer).toBe("I don't know.");
    expect(deps.chat).not.toHaveBeenCalled();
  });

  it.each(["I don't know.", "I dont know", "I don’t know. The FAQ does not say.", "  "])(
    "normalizes the model declining (%j) to exactly I don't know.",
    async (text) => {
      const deps = ragDeps({ chat: vi.fn(async () => ({ text, promptTokens: 1, completionTokens: 1 })) });
      const result = await answerFaqQuestion("Does SoulSync have an Android app?", deps);
      expect(result.answer).toBe("I don't know.");
      expect(result.sources).toEqual([]);
      expect(result.status).toBe("model_declined");
    }
  );

  it("replaces an answer that is not grounded in the context", async () => {
    const deps = ragDeps({
      chat: vi.fn(async () => ({
        text: "Yes, download our Android application from Google Play today.",
        promptTokens: 1,
        completionTokens: 1,
      })),
    });
    const result = await answerFaqQuestion("Is there an Android app?", deps);
    expect(result).toMatchObject({ answer: "I don't know.", status: "ungrounded" });
  });

  it("propagates AI service failures", async () => {
    const deps = ragDeps({
      embedQuestion: async () => {
        throw new AiServiceError("LLM_UNAVAILABLE", "down");
      },
    });
    await expect(answerFaqQuestion("q", deps)).rejects.toBeInstanceOf(AiServiceError);
  });
});

describe("groundingRatio / isIDontKnow", () => {
  it("measures overlap of content words with the context", () => {
    expect(groundingRatio("Your journal entries are private.", [privacyChunk])).toBe(1);
    expect(groundingRatio("Download the Android application.", [privacyChunk])).toBe(0);
    expect(groundingRatio("", [privacyChunk])).toBe(0);
  });

  it("detects declines only at the start of the answer", () => {
    expect(isIDontKnow("I don't know.")).toBe(true);
    expect(isIDontKnow("Mood tracking helps when I don't know how I feel.")).toBe(false);
  });
});

function handlerDeps(overrides: Partial<FaqHandlerDeps> = {}) {
  const logs: UsageEntry[] = [];
  const deps: FaqHandlerDeps = {
    ...ragDeps(),
    getUser: async () => ({ id: "user-1" }),
    rateLimit: createRateLimiter({ maxRequests: 100, windowMs: 60_000 }),
    logUsage: vi.fn(async (entry: UsageEntry) => {
      logs.push(entry);
    }),
    model: "qwen2.5:3b",
    ...overrides,
  };
  return { deps, logs };
}

const ask = (body: unknown) =>
  new Request("http://localhost/api/faq", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("POST /api/faq handler", () => {
  it("returns 200 with answer and sources and logs usage metadata", async () => {
    const { deps, logs } = handlerDeps();
    const response = await handleFaq(ask({ question: "What are weekly insights?" }), deps);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["answer", "sources"]);
    expect(logs).toEqual([
      expect.objectContaining({
        userId: "user-1",
        endpoint: "/api/faq",
        model: "qwen2.5:3b",
        promptTokens: 126,
        completionTokens: 20,
        totalTokens: 146,
        costUsd: "0.00000000",
        httpStatus: 200,
        status: "success",
        errorCode: null,
      }),
    ]);
  });

  it("returns 401 for anonymous users without calling any AI service", async () => {
    const { deps, logs } = handlerDeps({ getUser: async () => null });
    const response = await handleFaq(ask({ question: "hi" }), deps);

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("UNAUTHORIZED");
    expect(deps.embedQuestion).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it.each([
    ["malformed JSON", "{", "INVALID_JSON"],
    ["missing question", {}, "INVALID_QUESTION"],
    ["blank question", { question: "   " }, "INVALID_QUESTION"],
    ["non-string question", { question: 42 }, "INVALID_QUESTION"],
    ["too long question", { question: "x".repeat(501) }, "INVALID_QUESTION"],
  ])("returns 400 for %s", async (_label, body, code) => {
    const { deps } = handlerDeps();
    const response = await handleFaq(ask(body), deps);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe(code);
    expect(deps.embedQuestion).not.toHaveBeenCalled();
  });

  it("rate limits per user with 429 and Retry-After", async () => {
    let user = "user-1";
    const { deps, logs } = handlerDeps({
      getUser: async () => ({ id: user }),
      rateLimit: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });

    expect((await handleFaq(ask({ question: "q" }), deps)).status).toBe(200);
    const limited = await handleFaq(ask({ question: "q" }), deps);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(logs[1]).toMatchObject({ httpStatus: 429, status: "rate_limited" });

    user = "user-2";
    expect((await handleFaq(ask({ question: "q" }), deps)).status).toBe(200);
  });

  it.each([
    [new AiServiceError("LLM_UNAVAILABLE", "x"), 503, "LLM_UNAVAILABLE"],
    [new AiServiceError("LLM_TIMEOUT", "x"), 504, "LLM_TIMEOUT"],
    [new Error("relation \"faq_chunks\" does not exist at postgres://u:pw@db"), 500, "INTERNAL_ERROR"],
  ])("maps %s to HTTP %i without leaking details", async (error, status, code) => {
    const { deps, logs } = handlerDeps({
      search: async () => {
        throw error;
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handleFaq(ask({ question: "q" }), deps);
    spy.mockRestore();

    expect(response.status).toBe(status);
    const text = await response.text();
    expect(JSON.parse(text).code).toBe(code);
    expect(text).not.toMatch(/postgres|pw@|faq_chunks/);
    expect(logs[0]).toMatchObject({ httpStatus: status, status: "error", errorCode: code });
  });

  it("still answers when usage logging fails", async () => {
    const { safeSink } = await import("@/src/lib/ai/usage");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps } = handlerDeps({
      logUsage: safeSink(async () => {
        throw new Error("db down");
      }),
    });
    const response = await handleFaq(ask({ question: "q" }), deps);
    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
