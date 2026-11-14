import { AiServiceError, type ChatMessage, type StreamEvent } from "@/src/lib/ai/ollama";
import { jsonError, rateLimitedResponse, type GetSessionUser } from "@/src/lib/ai/http";
import type { RateLimiter } from "@/src/lib/ai/rate-limit";
import { buildUsageEntry, type UsageSink } from "@/src/lib/ai/usage";
import {
  buildFallbackSummary,
  buildInsightsMessages,
  computeWeeklyStats,
  weekStart,
  type JournalEntry,
  type MoodEntry,
  type WeeklyStats,
} from "./weekly";

export const INSIGHTS_ENDPOINT = "/api/insights/weekly";
export const INTERRUPTED_NOTE =
  "\n\n(The summary was interrupted. Refresh to generate it again.)";

export type InsightsDeps = {
  getUser: GetSessionUser;
  rateLimit: RateLimiter;
  logUsage: UsageSink;
  model: string;
  /** Must return only rows owned by `userId` created at or after `since`. */
  loadEntries: (
    userId: string,
    since: Date
  ) => Promise<{ moods: MoodEntry[]; journals: JournalEntry[] }>;
  streamChat: (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<StreamEvent>;
  now?: () => Date;
  /** Delay between fallback chunks so the UI still renders progressively. */
  fallbackChunkDelayMs?: number;
};

type Source = "ai" | "fallback" | "summary";

function statsHeaders(stats: WeeklyStats, source: Source): HeadersInit {
  return {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Content-Type-Options": "nosniff",
    "X-Insights-Source": source,
    "X-Weekly-Mood-Count": String(stats.moodCount),
    "X-Weekly-Journal-Count": String(stats.journalCount),
    "X-Weekly-Top-Mood": encodeURIComponent(stats.topMood),
    "X-Weekly-Themes": encodeURIComponent(stats.themes.join(",")),
    "X-Weekly-Mood-Distribution": encodeURIComponent(JSON.stringify(stats.moodCounts)),
  };
}

const sleep = (ms: number) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export async function handleWeeklyInsights(
  request: Request,
  deps: InsightsDeps
): Promise<Response> {
  const startedAt = Date.now();
  const user = await deps.getUser(request.headers);

  if (!user) {
    return jsonError(401, "UNAUTHORIZED", "Please log in to view your weekly insights.");
  }

  const log = (
    httpStatus: number,
    status: string,
    extra: { promptTokens?: number; completionTokens?: number; errorCode?: string } = {}
  ) =>
    deps.logUsage(
      buildUsageEntry({
        userId: user.id,
        endpoint: INSIGHTS_ENDPOINT,
        model: deps.model,
        startedAt,
        httpStatus,
        status,
        ...extra,
      })
    );

  const limit = deps.rateLimit(`insights:${user.id}`);

  if (!limit.allowed) {
    await log(429, "rate_limited", { errorCode: "RATE_LIMITED" });
    return rateLimitedResponse(limit);
  }

  let moods: MoodEntry[];
  let journals: JournalEntry[];

  try {
    ({ moods, journals } = await deps.loadEntries(
      user.id,
      weekStart((deps.now ?? (() => new Date()))())
    ));
  } catch (error) {
    console.error("Weekly insights load error:", error instanceof Error ? error.name : "unknown");
    await log(500, "error", { errorCode: "DATA_LOAD_FAILED" });
    return jsonError(500, "DATA_LOAD_FAILED", "Unable to load your weekly entries.");
  }

  const stats = computeWeeklyStats(moods, journals);
  const encoder = new TextEncoder();
  const delay = deps.fallbackChunkDelayMs ?? 25;

  const streamText = (text: string, onDone: () => Promise<void>) =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const parts = text.split(/(\s+)/);
        for (let i = 0; i < parts.length; i += 6) {
          controller.enqueue(encoder.encode(parts.slice(i, i + 6).join("")));
          await sleep(delay);
        }
        controller.close();
        await onDone();
      },
    });

  // Nothing to summarize: no need to call the model.
  if (stats.moodCount === 0 && stats.journalCount === 0) {
    return new Response(
      streamText(buildFallbackSummary(stats), () => log(200, "no_data")),
      { headers: statsHeaders(stats, "summary") }
    );
  }

  const abort = new AbortController();
  request.signal?.addEventListener("abort", () => abort.abort(), { once: true });

  const iterator = deps
    .streamChat(buildInsightsMessages(stats, moods, journals), abort.signal)
    [Symbol.asyncIterator]();

  // Wait for the first event so an unavailable model degrades to the
  // deterministic summary with a correct X-Insights-Source header.
  let first: IteratorResult<StreamEvent>;

  try {
    first = await iterator.next();
  } catch (error) {
    const code = error instanceof AiServiceError ? error.code : "LLM_UNKNOWN_ERROR";
    return new Response(
      streamText(buildFallbackSummary(stats), () =>
        log(200, "fallback", { errorCode: code })
      ),
      { headers: statsHeaders(stats, "fallback") }
    );
  }

  let promptTokens = 0;
  let completionTokens = 0;
  let wroteText = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let status = "success";
      let errorCode: string | undefined;

      const handle = (event: StreamEvent) => {
        if (event.type === "token") {
          wroteText = true;
          controller.enqueue(encoder.encode(event.text));
        } else {
          promptTokens = event.promptTokens;
          completionTokens = event.completionTokens;
        }
      };

      try {
        if (!first.done) handle(first.value);

        while (!first.done) {
          const next = await iterator.next();
          if (next.done) break;
          handle(next.value);
        }

        if (!wroteText) {
          // The model finished without producing any text.
          status = "fallback";
          errorCode = "LLM_EMPTY_RESPONSE";
          controller.enqueue(encoder.encode(buildFallbackSummary(stats)));
        }
      } catch (error) {
        if (abort.signal.aborted) {
          status = "cancelled";
        } else {
          status = wroteText ? "partial" : "fallback";
          errorCode = error instanceof AiServiceError ? error.code : "LLM_UNKNOWN_ERROR";
          controller.enqueue(
            encoder.encode(wroteText ? INTERRUPTED_NOTE : buildFallbackSummary(stats))
          );
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Stream already cancelled by the client.
        }
        await log(200, status, { promptTokens, completionTokens, errorCode });
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, { headers: statsHeaders(stats, "ai") });
}
