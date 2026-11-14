import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { handleExplainBlunder, type RouteDeps } from "@/lib/coach/handler";
import { createRateLimiter } from "@/lib/rate-limit";
import type { UsageRecord } from "@/lib/usage-logger";
import { QUEEN_BLUNDER_FEN, VALID_LLM_JSON, fakeAnalyze } from "./fixtures";

function makeDeps(overrides: Partial<RouteDeps> = {}) {
  const records: UsageRecord[] = [];
  const deps: RouteDeps = {
    analyze: fakeAnalyze(),
    generate: async () => ({ text: VALID_LLM_JSON, promptTokens: 500, completionTokens: 100 }),
    rateLimit: createRateLimiter({ maxRequests: 100, windowMs: 60_000 }),
    log: vi.fn(async (record: UsageRecord) => {
      records.push(record);
    }),
    ...overrides,
  };
  return { deps, records };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/explain-blunder", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const validBody = { fen: QUEEN_BLUNDER_FEN, playedMove: "Qg4" };

describe("POST /api/explain-blunder", () => {
  it("returns 200 with the explanation and logs full usage", async () => {
    const { deps, records } = makeDeps();
    const response = await handleExplainBlunder(post(validBody), deps);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({ move: "Qg4", source: "llm", moveQuality: "Blunder" });
    expect(response.headers.get("x-request-id")).toBe(records[0].requestId);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      endpoint: "/api/explain-blunder",
      promptTokens: 500,
      completionTokens: 100,
      totalTokens: 600,
      costUsd: 0,
      httpStatus: 200,
      status: "success",
    });
    expect(records[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns 200 with a fallback when the LLM is down", async () => {
    const { deps, records } = makeDeps({
      generate: async () => {
        throw new Error("ECONNREFUSED http://secret-host:11434");
      },
    });
    const response = await handleExplainBlunder(post(validBody), deps);

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text).source).toBe("fallback");
    expect(text).not.toContain("secret-host");
    expect(records[0]).toMatchObject({ status: "fallback_llm_error", errorCode: "LLM_UNKNOWN_ERROR" });
  });

  it("returns 429 with Retry-After once the limit is reached", async () => {
    const { deps, records } = makeDeps({
      rateLimit: createRateLimiter({ maxRequests: 1, windowMs: 30_000 }),
    });
    const headers = { "x-forwarded-for": "203.0.113.9" };

    expect((await handleExplainBlunder(post(validBody, headers), deps)).status).toBe(200);
    const limited = await handleExplainBlunder(post(validBody, headers), deps);

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({
      error: "Too many requests. Please wait a minute.",
      code: "RATE_LIMITED",
    });
    expect(records[1]).toMatchObject({ status: "rate_limited", httpStatus: 429, totalTokens: 0 });

    // A different client is not affected.
    const other = await handleExplainBlunder(post(validBody, { "x-forwarded-for": "198.51.100.1" }), deps);
    expect(other.status).toBe(200);
  });

  it.each([
    ["non-JSON content type", post("x", { "content-type": "text/plain" }), 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["oversized body", post({ fen: "x".repeat(5000), playedMove: "e4" }), 413, "PAYLOAD_TOO_LARGE"],
    ["malformed JSON", post("{bad"), 400, "INVALID_JSON"],
    ["missing playedMove", post({ fen: QUEEN_BLUNDER_FEN }), 400, "INVALID_CHESS_INPUT"],
    ["illegal move", post({ fen: QUEEN_BLUNDER_FEN, playedMove: "Ke3" }), 400, "INVALID_CHESS_INPUT"],
    ["invalid FEN", post({ fen: "not a fen", playedMove: "e4" }), 400, "INVALID_CHESS_INPUT"],
  ])("returns the right error for %s", async (_label, request, status, code) => {
    const { deps, records } = makeDeps();
    const response = await handleExplainBlunder(request, deps);

    expect(response.status).toBe(status);
    expect((await response.json()).code).toBe(code);
    expect(records[0]).toMatchObject({ httpStatus: status, errorCode: code, totalTokens: 0 });
  });

  it("returns 503 when the engine fails and 504 when it times out", async () => {
    const crash = makeDeps({
      analyze: async () => {
        throw new Error("Stockfish process closed unexpectedly. /usr/secret/path");
      },
    });
    const crashed = await handleExplainBlunder(post(validBody), crash.deps);
    expect(crashed.status).toBe(503);
    expect(await crashed.text()).not.toContain("/usr/secret/path");

    const slow = makeDeps({
      analyze: async () => {
        throw new Error("Stockfish analysis timed out.");
      },
    });
    const timedOut = await handleExplainBlunder(post(validBody), slow.deps);
    expect(timedOut.status).toBe(504);
    expect(slow.records[0].errorCode).toBe("ENGINE_TIMEOUT");
  });

  it("returns 500 without internal details for unexpected errors", async () => {
    const { deps, records } = makeDeps({
      // A malformed engine result makes the pipeline throw a TypeError.
      analyze: async () => ({
        bestMove: "e4d5",
        principalVariation: 42 as unknown as string[],
      }),
    });
    const response = await handleExplainBlunder(post(validBody), deps);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Unable to generate the chess explanation.",
      code: "INTERNAL_ERROR",
    });
    expect(records[0]).toMatchObject({ status: "error", errorCode: "INTERNAL_ERROR" });
  });
});
