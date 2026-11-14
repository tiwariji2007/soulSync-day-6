import { AiServiceError } from "@/src/lib/ai/ollama";
import {
  jsonError,
  rateLimitedResponse,
  type GetSessionUser,
} from "@/src/lib/ai/http";
import type { RateLimiter } from "@/src/lib/ai/rate-limit";
import { buildUsageEntry, type UsageSink } from "@/src/lib/ai/usage";
import { answerFaqQuestion, MAX_QUESTION_LENGTH, type FaqDeps } from "./rag";

export const FAQ_ENDPOINT = "/api/faq";

export type FaqHandlerDeps = FaqDeps & {
  getUser: GetSessionUser;
  rateLimit: RateLimiter;
  logUsage: UsageSink;
  model: string;
};

export async function handleFaq(request: Request, deps: FaqHandlerDeps): Promise<Response> {
  const startedAt = Date.now();
  const user = await deps.getUser(request.headers);

  if (!user) {
    return jsonError(401, "UNAUTHORIZED", "Please log in to use the FAQ assistant.");
  }

  const log = (httpStatus: number, status: string, extra: {
    promptTokens?: number;
    completionTokens?: number;
    errorCode?: string;
  } = {}) =>
    deps.logUsage(
      buildUsageEntry({
        userId: user.id,
        endpoint: FAQ_ENDPOINT,
        model: deps.model,
        startedAt,
        httpStatus,
        status,
        ...extra,
      })
    );

  const limit = deps.rateLimit(`faq:${user.id}`);

  if (!limit.allowed) {
    await log(429, "rate_limited", { errorCode: "RATE_LIMITED" });
    return rateLimitedResponse(limit);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  const question =
    body && typeof body === "object" && "question" in body && typeof body.question === "string"
      ? body.question.trim()
      : "";

  if (!question || question.length > MAX_QUESTION_LENGTH) {
    return jsonError(
      400,
      "INVALID_QUESTION",
      `Question must contain 1-${MAX_QUESTION_LENGTH} characters.`
    );
  }

  try {
    const result = await answerFaqQuestion(question, deps);

    await log(200, result.status, {
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    });

    return Response.json(
      { answer: result.answer, sources: result.sources },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof AiServiceError) {
      await log(error.httpStatus, "error", { errorCode: error.code });
      return jsonError(
        error.httpStatus,
        error.code,
        "The FAQ assistant is temporarily unavailable. Please try again shortly.",
        { "Retry-After": "30" }
      );
    }

    console.error("FAQ error:", error instanceof Error ? error.name : "unknown");
    await log(500, "error", { errorCode: "INTERNAL_ERROR" });
    return jsonError(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
  }
}
