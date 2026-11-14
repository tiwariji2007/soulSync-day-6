/**
 * AI usage accounting. Records only metadata (tokens, cost, latency, status):
 * never prompts, model output, journal text, headers or environment values.
 */

export type UsageEntry = {
  userId: string | null;
  endpoint: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: string;
  latencyMs: number;
  httpStatus: number;
  status: string;
  errorCode: string | null;
};

export type UsageSink = (entry: UsageEntry) => Promise<void>;

function nonNegative(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * USD cost from per-million-token prices. Local Ollama models cost nothing,
 * so prices default to 0. Returned as a string to fit numeric(12, 8).
 */
export function calculateCostUsd(
  promptTokens: number,
  completionTokens: number,
  prices = {
    inputPerMTok: nonNegative(process.env.LLM_INPUT_COST_PER_MTOK),
    outputPerMTok: nonNegative(process.env.LLM_OUTPUT_COST_PER_MTOK),
  }
): string {
  const cost =
    (promptTokens * prices.inputPerMTok + completionTokens * prices.outputPerMTok) /
    1_000_000;
  return cost.toFixed(8);
}

export function buildUsageEntry(input: {
  userId: string | null;
  endpoint: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  startedAt: number;
  httpStatus: number;
  status: string;
  errorCode?: string | null;
  now?: number;
}): UsageEntry {
  const promptTokens = input.promptTokens ?? 0;
  const completionTokens = input.completionTokens ?? 0;

  return {
    userId: input.userId,
    endpoint: input.endpoint,
    model: input.model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costUsd: calculateCostUsd(promptTokens, completionTokens),
    latencyMs: Math.max(0, (input.now ?? Date.now()) - input.startedAt),
    httpStatus: input.httpStatus,
    status: input.status,
    errorCode: input.errorCode ?? null,
  };
}

/** Wraps a sink so that logging failures never break a request. */
export function safeSink(sink: UsageSink): UsageSink {
  return async (entry) => {
    try {
      await sink(entry);
    } catch (error) {
      console.error(
        "AI usage logging failed:",
        error instanceof Error ? error.name : "unknown error"
      );
    }
  };
}
