import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "@/lib/rate-limit";
import { buildUsageRecord, calculateCostUsd, logUsage } from "@/lib/usage-logger";

describe("createRateLimiter", () => {
  it("allows maxRequests per window, then blocks until the window resets", () => {
    let now = 1_000;
    const limit = createRateLimiter({ maxRequests: 2, windowMs: 10_000, now: () => now });

    expect(limit("a")).toEqual({ allowed: true, remaining: 1, retryAfter: 0 });
    expect(limit("a")).toEqual({ allowed: true, remaining: 0, retryAfter: 0 });
    expect(limit("a")).toEqual({ allowed: false, remaining: 0, retryAfter: 10 });

    now += 9_500;
    expect(limit("a").retryAfter).toBe(1);

    now += 500;
    expect(limit("a").allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const limit = createRateLimiter({ maxRequests: 1, windowMs: 1_000 });
    expect(limit("a").allowed).toBe(true);
    expect(limit("a").allowed).toBe(false);
    expect(limit("b").allowed).toBe(true);
  });
});

describe("usage logging", () => {
  let dir: string | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("calculates cost from per-million-token prices", () => {
    expect(calculateCostUsd(1_000, 500, { inputPerMTok: 3, outputPerMTok: 15 })).toBe(0.0105);
    expect(calculateCostUsd(1_000, 500, { inputPerMTok: 0, outputPerMTok: 0 })).toBe(0);
  });

  it("reads prices from the environment and ignores invalid values", () => {
    vi.stubEnv("LLM_INPUT_COST_PER_MTOK", "2");
    vi.stubEnv("LLM_OUTPUT_COST_PER_MTOK", "-5");
    expect(calculateCostUsd(1_000_000, 1_000_000)).toBe(2);
  });

  it("builds a record with totals and latency", () => {
    const record = buildUsageRecord({
      requestId: "r1",
      endpoint: "/x",
      model: "m",
      promptTokens: 10,
      completionTokens: 5,
      startedAt: 1_000,
      now: 1_250,
      httpStatus: 200,
      status: "success",
    });
    expect(record).toMatchObject({ totalTokens: 15, latencyMs: 250, httpStatus: 200 });
    expect(record).not.toHaveProperty("errorCode");
  });

  it("appends JSON lines and never throws", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "tactiq-usage-"));
    vi.stubEnv("USAGE_LOG_DIR", dir);
    const record = buildUsageRecord({
      requestId: "r2",
      endpoint: "/x",
      model: "m",
      promptTokens: 1,
      completionTokens: 2,
      startedAt: 0,
      now: 5,
      httpStatus: 503,
      status: "error",
      errorCode: "ENGINE_UNAVAILABLE",
    });

    await logUsage(record);
    await logUsage(record);

    const lines = (await readFile(path.join(dir, "ai-usage.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([record, record]);

    // A path below a regular file cannot be created: logging must not throw.
    vi.stubEnv("USAGE_LOG_DIR", path.join(dir, "ai-usage.jsonl", "nested"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(logUsage(record)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledOnce();
  });
});
