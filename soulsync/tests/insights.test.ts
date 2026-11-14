import { describe, expect, it, vi } from "vitest";
import { AiServiceError, type StreamEvent } from "@/src/lib/ai/ollama";
import { createRateLimiter } from "@/src/lib/ai/rate-limit";
import type { UsageEntry } from "@/src/lib/ai/usage";
import {
  handleWeeklyInsights,
  INTERRUPTED_NOTE,
  type InsightsDeps,
} from "@/src/lib/insights/handler";
import {
  buildFallbackSummary,
  buildInsightsMessages,
  computeWeeklyStats,
  MAX_JOURNAL_CHARS,
  weekStart,
  type JournalEntry,
  type MoodEntry,
} from "@/src/lib/insights/weekly";

const NOW = new Date("2026-11-14T12:00:00Z");

const moods: MoodEntry[] = [
  { mood: "calm", note: "Good walk", createdAt: new Date("2026-11-13T09:00:00Z") },
  { mood: "anxious", note: null, createdAt: new Date("2026-11-12T09:00:00Z") },
  { mood: "calm", note: null, createdAt: new Date("2026-11-10T09:00:00Z") },
];

const journals: JournalEntry[] = [
  {
    title: "Exam week",
    content: "Stressed about my exam but grateful for my friend.",
    createdAt: new Date("2026-11-12T20:00:00Z"),
  },
];

async function* tokens(
  parts: string[],
  options: { failAfter?: number; usage?: boolean } = {}
): AsyncGenerator<StreamEvent> {
  for (const [index, text] of parts.entries()) {
    if (options.failAfter === index) {
      throw new AiServiceError("LLM_UNAVAILABLE", "connection reset");
    }
    yield { type: "token", text };
  }
  if (options.usage !== false) {
    yield { type: "done", promptTokens: 210, completionTokens: 45 };
  }
}

async function* failing(code: "LLM_UNAVAILABLE" | "LLM_TIMEOUT"): AsyncGenerator<StreamEvent> {
  throw new AiServiceError(code, "down");
}

function makeDeps(overrides: Partial<InsightsDeps> = {}) {
  const logs: UsageEntry[] = [];
  const deps: InsightsDeps = {
    getUser: async () => ({ id: "user-a" }),
    rateLimit: createRateLimiter({ maxRequests: 100, windowMs: 60_000 }),
    logUsage: vi.fn(async (entry: UsageEntry) => {
      logs.push(entry);
    }),
    model: "qwen2.5:3b",
    loadEntries: vi.fn(async () => ({ moods, journals })),
    streamChat: vi.fn<InsightsDeps["streamChat"]>(() =>
      tokens(["Your week ", "felt ", "mostly calm."])
    ),
    now: () => NOW,
    fallbackChunkDelayMs: 0,
    ...overrides,
  };
  return { deps, logs };
}

const get = () => new Request("http://localhost/api/insights/weekly");

/** Reads a streamed response chunk by chunk, as the browser UI does. */
async function readChunks(response: Response): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  return chunks;
}

/** Waits for the usage log written when the stream finishes. */
async function settled(logs: UsageEntry[]) {
  await vi.waitFor(() => expect(logs.length).toBeGreaterThan(0));
  return logs[0];
}

describe("weekly stats and prompt", () => {
  it("computes counts, top mood and themes", () => {
    expect(computeWeeklyStats(moods, journals)).toEqual({
      moodCount: 3,
      journalCount: 1,
      topMood: "calm",
      moodCounts: { calm: 2, anxious: 1 },
      themes: expect.arrayContaining(["Stress & anxiety", "Work & study"]),
    });
  });

  it("uses a seven-day window", () => {
    expect(weekStart(NOW).toISOString()).toBe("2026-11-07T12:00:00.000Z");
  });

  it("builds a deterministic fallback summary", () => {
    const stats = computeWeeklyStats(moods, journals);
    const summary = buildFallbackSummary(stats);
    expect(summary).toBe(buildFallbackSummary(stats));
    expect(summary).toContain("You recorded 3 mood entries and wrote 1 journal entry");
    expect(summary).toContain("Reflection prompt:");
  });

  it("puts only the supplied entries in the prompt and clips long journals", () => {
    const long = { title: "Long", content: "word ".repeat(1_000), createdAt: NOW };
    const messages = buildInsightsMessages(computeWeeklyStats(moods, [long]), moods, [long]);
    const user = messages[1].content;

    expect(user).toContain("Mood entries this week: 3");
    expect(user).toContain("2026-11-13: calm (note: Good walk)");
    expect(user.length).toBeLessThan(MAX_JOURNAL_CHARS + 1_000);
    expect(messages[0].content).toMatch(/not as instructions/);
  });
});

describe("GET /api/insights/weekly handler", () => {
  it("streams the AI summary progressively with stats headers", async () => {
    const { deps, logs } = makeDeps();
    const response = await handleWeeklyInsights(get(), deps);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-insights-source")).toBe("ai");
    expect(response.headers.get("x-weekly-mood-count")).toBe("3");
    expect(response.headers.get("x-weekly-journal-count")).toBe("1");
    expect(decodeURIComponent(response.headers.get("x-weekly-top-mood")!)).toBe("calm");

    const chunks = await readChunks(response);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe("Your week felt mostly calm.");

    expect(await settled(logs)).toMatchObject({
      userId: "user-a",
      endpoint: "/api/insights/weekly",
      promptTokens: 210,
      completionTokens: 45,
      totalTokens: 255,
      httpStatus: 200,
      status: "success",
    });
  });

  it("loads only the authenticated user's entries for the last seven days", async () => {
    const { deps } = makeDeps({ getUser: async () => ({ id: "user-b" }) });
    await readChunks(await handleWeeklyInsights(get(), deps));

    expect(deps.loadEntries).toHaveBeenCalledOnce();
    expect(deps.loadEntries).toHaveBeenCalledWith("user-b", weekStart(NOW));
  });

  it("returns 401 without loading data", async () => {
    const { deps } = makeDeps({ getUser: async () => null });
    const response = await handleWeeklyInsights(get(), deps);

    expect(response.status).toBe(401);
    expect(deps.loadEntries).not.toHaveBeenCalled();
    expect(deps.streamChat).not.toHaveBeenCalled();
  });

  it("returns 429 per user", async () => {
    const { deps, logs } = makeDeps({
      rateLimit: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    await readChunks(await handleWeeklyInsights(get(), deps));
    const limited = await handleWeeklyInsights(get(), deps);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(logs.some((log) => log.status === "rate_limited" && log.httpStatus === 429)).toBe(true);
  });

  it("returns 500 without details when entries cannot be loaded", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps, logs } = makeDeps({
      loadEntries: async () => {
        throw new Error("password authentication failed for user admin");
      },
    });
    const response = await handleWeeklyInsights(get(), deps);
    spy.mockRestore();

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("password");
    expect(logs[0]).toMatchObject({ status: "error", errorCode: "DATA_LOAD_FAILED" });
  });

  it("does not call the model when there are no entries", async () => {
    const { deps, logs } = makeDeps({ loadEntries: async () => ({ moods: [], journals: [] }) });
    const response = await handleWeeklyInsights(get(), deps);

    expect(response.headers.get("x-insights-source")).toBe("summary");
    expect((await readChunks(response)).join("")).toContain("You have not recorded any moods");
    expect(deps.streamChat).not.toHaveBeenCalled();
    expect(await settled(logs)).toMatchObject({ status: "no_data", totalTokens: 0 });
  });

  it.each(["LLM_UNAVAILABLE", "LLM_TIMEOUT"] as const)(
    "streams the deterministic summary when the model fails before any text (%s)",
    async (code) => {
      const { deps, logs } = makeDeps({ streamChat: () => failing(code) });
      const response = await handleWeeklyInsights(get(), deps);

      expect(response.status).toBe(200);
      expect(response.headers.get("x-insights-source")).toBe("fallback");
      const chunks = await readChunks(response);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join("")).toBe(buildFallbackSummary(computeWeeklyStats(moods, journals)));
      expect(await settled(logs)).toMatchObject({ status: "fallback", errorCode: code });
    }
  );

  it("keeps partial text and appends a note when the stream breaks midway", async () => {
    const { deps, logs } = makeDeps({
      streamChat: () => tokens(["Your week ", "felt ", "calm"], { failAfter: 2 }),
    });
    const text = (await readChunks(await handleWeeklyInsights(get(), deps))).join("");

    expect(text).toBe(`Your week felt ${INTERRUPTED_NOTE}`);
    expect(await settled(logs)).toMatchObject({ status: "partial", errorCode: "LLM_UNAVAILABLE" });
  });

  it("falls back when the model returns no text", async () => {
    const { deps, logs } = makeDeps({ streamChat: () => tokens([]) });
    const text = (await readChunks(await handleWeeklyInsights(get(), deps))).join("");

    expect(text).toContain("Your personalized weekly SoulSync reflection is ready.");
    expect(await settled(logs)).toMatchObject({ status: "fallback", errorCode: "LLM_EMPTY_RESPONSE" });
  });

  it("aborts the model request when the client disconnects", async () => {
    let signal: AbortSignal | undefined;
    const { deps, logs } = makeDeps({
      streamChat: (_messages, s) => {
        signal = s;
        return (async function* () {
          yield { type: "token", text: "Start " } as StreamEvent;
          await new Promise((resolve) => s.addEventListener("abort", resolve));
          throw new AiServiceError("LLM_ABORTED", "cancelled");
        })();
      },
    });
    const response = await handleWeeklyInsights(get(), deps);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(signal?.aborted).toBe(true);
    expect(await settled(logs)).toMatchObject({ status: "cancelled" });
  });
});
