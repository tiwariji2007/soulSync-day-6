import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type UsageRecord = {
  timestamp: string;
  requestId: string;
  project: string;
  endpoint: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  httpStatus: number;
  status: string;
  errorCode?: string;
};

function nonNegativeNumber(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Cost in USD from per-million-token prices. Local Ollama models are free,
 * so the defaults are 0; set LLM_INPUT_COST_PER_MTOK / LLM_OUTPUT_COST_PER_MTOK
 * when using a paid provider.
 */
export function calculateCostUsd(
  promptTokens: number,
  completionTokens: number,
  prices = {
    inputPerMTok: nonNegativeNumber(process.env.LLM_INPUT_COST_PER_MTOK),
    outputPerMTok: nonNegativeNumber(process.env.LLM_OUTPUT_COST_PER_MTOK),
  }
): number {
  const cost =
    (promptTokens * prices.inputPerMTok +
      completionTokens * prices.outputPerMTok) /
    1_000_000;
  return Number(cost.toFixed(8));
}

export function buildUsageRecord(input: {
  requestId: string;
  endpoint: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  startedAt: number;
  httpStatus: number;
  status: string;
  errorCode?: string;
  now?: number;
}): UsageRecord {
  const finishedAt = input.now ?? Date.now();

  return {
    timestamp: new Date(finishedAt).toISOString(),
    requestId: input.requestId,
    project: "TactiQ",
    endpoint: input.endpoint,
    model: input.model,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    totalTokens: input.promptTokens + input.completionTokens,
    costUsd: calculateCostUsd(input.promptTokens, input.completionTokens),
    latencyMs: Math.max(0, finishedAt - input.startedAt),
    httpStatus: input.httpStatus,
    status: input.status,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  };
}

/**
 * Appends one JSON line per request to data/ai-usage.jsonl. Only metadata is
 * logged: never prompts, model output, headers or environment values.
 * Logging failures never break the request.
 */
export async function logUsage(record: UsageRecord): Promise<void> {
  try {
    const directory =
      process.env.USAGE_LOG_DIR ?? path.join(process.cwd(), "data");
    await mkdir(directory, { recursive: true });
    await appendFile(
      path.join(directory, "ai-usage.jsonl"),
      `${JSON.stringify(record)}\n`,
      "utf8"
    );
  } catch (error) {
    console.error(
      "Usage logging failed:",
      error instanceof Error ? error.message : "unknown error"
    );
  }
}
