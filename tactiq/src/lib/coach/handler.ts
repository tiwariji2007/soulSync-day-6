import { NextRequest, NextResponse } from "next/server";
import { analyzePosition } from "@/lib/stockfish";
import { createOllamaJsonGenerator } from "@/lib/llm/ollama";
import { checkRateLimit, type RateLimiter } from "@/lib/rate-limit";
import { buildUsageRecord, logUsage } from "@/lib/usage-logger";
import {
  CoachInputError,
  EngineError,
  explainMove,
  parseCoachRequest,
  type Analyze,
} from "@/lib/coach/explain";
import type { GenerateJson } from "@/lib/llm/ollama";

const ENDPOINT = "/api/explain-blunder";
const MAX_BODY_BYTES = 4_096;

const MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:3b";

function clientKey(request: NextRequest): string {
  // Behind a trusted proxy, x-forwarded-for identifies the client. Without a
  // proxy these headers can be spoofed, so deploy behind one in production.
  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "local-client"
  );
}

export type RouteDeps = {
  analyze: Analyze;
  generate: GenerateJson;
  rateLimit: RateLimiter;
  log: typeof logUsage;
};

export const defaultDeps: RouteDeps = {
  analyze: analyzePosition,
  generate: createOllamaJsonGenerator({
    baseUrl: process.env.OLLAMA_URL,
    model: MODEL,
  }),
  rateLimit: checkRateLimit,
  log: logUsage,
};

/** Route logic with injectable dependencies so it can be tested offline. */
export async function handleExplainBlunder(
  request: NextRequest,
  deps: RouteDeps
): Promise<NextResponse> {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();

  const finish = async (
    response: NextResponse,
    usage: {
      status: string;
      promptTokens?: number;
      completionTokens?: number;
      errorCode?: string;
    }
  ) => {
    await deps.log(
      buildUsageRecord({
        requestId,
        endpoint: ENDPOINT,
        model: MODEL,
        promptTokens: usage.promptTokens ?? 0,
        completionTokens: usage.completionTokens ?? 0,
        startedAt,
        httpStatus: response.status,
        status: usage.status,
        errorCode: usage.errorCode,
      })
    );
    response.headers.set("X-Request-Id", requestId);
    return response;
  };

  const error = (status: number, message: string, code: string) =>
    NextResponse.json({ error: message, code }, { status });

  const limit = deps.rateLimit(clientKey(request));

  if (!limit.allowed) {
    const response = error(429, "Too many requests. Please wait a minute.", "RATE_LIMITED");
    response.headers.set("Retry-After", String(limit.retryAfter));
    return finish(response, { status: "rate_limited", errorCode: "RATE_LIMITED" });
  }

  if (!request.headers.get("content-type")?.includes("application/json")) {
    return finish(
      error(415, "Content-Type must be application/json.", "UNSUPPORTED_MEDIA_TYPE"),
      { status: "invalid_request", errorCode: "UNSUPPORTED_MEDIA_TYPE" }
    );
  }

  const rawBody = await request.text();

  if (rawBody.length > MAX_BODY_BYTES) {
    return finish(error(413, "Request body is too large.", "PAYLOAD_TOO_LARGE"), {
      status: "invalid_request",
      errorCode: "PAYLOAD_TOO_LARGE",
    });
  }

  let payload: unknown;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return finish(error(400, "Request body must be valid JSON.", "INVALID_JSON"), {
      status: "invalid_request",
      errorCode: "INVALID_JSON",
    });
  }

  try {
    const result = await explainMove(parseCoachRequest(payload), deps);

    if (result.usage.violations) {
      // Logged for debugging; never returned to the client.
      console.warn("Rejected LLM explanation:", result.usage.violations);
    }

    return finish(NextResponse.json(result.body), result.usage);
  } catch (caught) {
    if (caught instanceof CoachInputError) {
      return finish(error(400, caught.message, "INVALID_CHESS_INPUT"), {
        status: "invalid_request",
        errorCode: "INVALID_CHESS_INPUT",
      });
    }

    if (caught instanceof EngineError) {
      return caught.timedOut
        ? finish(error(504, "The chess engine timed out.", "ENGINE_TIMEOUT"), {
            status: "error",
            errorCode: "ENGINE_TIMEOUT",
          })
        : finish(
            error(503, "The chess engine is temporarily unavailable.", "ENGINE_UNAVAILABLE"),
            { status: "error", errorCode: "ENGINE_UNAVAILABLE" }
          );
    }

    console.error(
      "TactiQ coach error:",
      caught instanceof Error ? caught.message : "unknown error"
    );

    return finish(
      error(500, "Unable to generate the chess explanation.", "INTERNAL_ERROR"),
      { status: "error", errorCode: "INTERNAL_ERROR" }
    );
  }
}

