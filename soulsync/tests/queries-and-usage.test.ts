/**
 * SQL-shape tests. These build queries with drizzle's .toSQL() and never
 * execute them, so they verify user scoping and the pgvector query text but
 * NOT runtime behaviour against PostgreSQL/pgvector.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "@/src/lib/ai/rate-limit";
import { buildUsageEntry, calculateCostUsd, safeSink } from "@/src/lib/ai/usage";
import { buildFaqSearchQuery } from "@/src/lib/faq/store";
import { weeklyEntriesQueries } from "@/src/lib/insights/queries";

describe("weeklyEntriesQueries", () => {
  it("filters moods and journals by user id and start date", () => {
    const since = new Date("2026-11-07T12:00:00Z");
    const { moods, journals } = weeklyEntriesQueries("user-42", since);

    for (const [query, table] of [
      [moods.toSQL(), "moods"],
      [journals.toSQL(), "journals"],
    ] as const) {
      expect(query.sql).toContain(`from "${table}"`);
      expect(query.sql).toMatch(
        new RegExp(`where \\("${table}"\\."user_id" = \\$1 and "${table}"\\."created_at" >= \\$2\\)`)
      );
      expect(query.params[0]).toBe("user-42");
      expect(query.params[1]).toBe(since.toISOString());
    }
  });
});

describe("buildFaqSearchQuery", () => {
  it("uses pgvector cosine distance with the threshold and limit as parameters", () => {
    const query = buildFaqSearchQuery([0.25, -0.5], { minSimilarity: 0.6, limit: 3 }).toSQL();

    expect(query.sql).toContain('from "faq_chunks"');
    expect(query.sql).toContain('1 - ("faq_chunks"."embedding" <=> $1)');
    expect(query.sql).toMatch(/where 1 - \("faq_chunks"\."embedding" <=> \$2\) >= \$3/);
    expect(query.sql).toMatch(/order by 1 - \("faq_chunks"\."embedding" <=> \$4\) desc limit \$5/);
    expect(query.params).toEqual(["[0.25,-0.5]", "[0.25,-0.5]", 0.6, "[0.25,-0.5]", 3]);
  });
});

describe("migration 0004", () => {
  const sql = readFileSync(
    path.join(__dirname, "..", "drizzle", "0004_faq_pgvector_and_ai_usage.sql"),
    "utf8"
  );

  it("enables pgvector before creating the vector column", () => {
    expect(sql.indexOf("CREATE EXTENSION IF NOT EXISTS vector")).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf("CREATE EXTENSION")).toBeLessThan(sql.indexOf('"embedding" vector(768)'));
    expect(sql).toContain("USING hnsw (\"embedding\" vector_cosine_ops)");
  });

  it("is additive only", () => {
    // "ON DELETE set null" is a foreign-key rule, not a destructive statement.
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+COLUMN\b/i);
    expect(sql).not.toMatch(/ALTER TABLE "(?!ai_usage_logs")/);
  });

  it("is registered in the drizzle journal", () => {
    const journal = JSON.parse(
      readFileSync(path.join(__dirname, "..", "drizzle", "meta", "_journal.json"), "utf8")
    );
    expect(journal.entries.at(-1).tag).toBe("0004_faq_pgvector_and_ai_usage");
  });
});

describe("usage accounting", () => {
  it("computes cost, totals and latency", () => {
    expect(calculateCostUsd(2_000, 1_000, { inputPerMTok: 0.5, outputPerMTok: 1.5 })).toBe("0.00250000");
    expect(
      buildUsageEntry({
        userId: "u",
        endpoint: "/e",
        model: "m",
        promptTokens: 3,
        completionTokens: 4,
        startedAt: 100,
        now: 350,
        httpStatus: 200,
        status: "success",
      })
    ).toEqual({
      userId: "u",
      endpoint: "/e",
      model: "m",
      promptTokens: 3,
      completionTokens: 4,
      totalTokens: 7,
      costUsd: "0.00000000",
      latencyMs: 250,
      httpStatus: 200,
      status: "success",
      errorCode: null,
    });
  });

  it("swallows sink failures without logging the error message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sink = safeSink(async () => {
      throw new Error("connect to postgres://admin:hunter2@db failed");
    });
    await expect(sink(buildUsageEntry({
      userId: null, endpoint: "/e", model: "m", startedAt: 0, httpStatus: 500, status: "error",
    }))).resolves.toBeUndefined();
    expect(JSON.stringify(spy.mock.calls)).not.toContain("hunter2");
    spy.mockRestore();
  });

  it("rate limiter blocks after the limit and recovers after the window", () => {
    let now = 0;
    const limit = createRateLimiter({ maxRequests: 2, windowMs: 1_000, now: () => now });
    expect([limit("k").allowed, limit("k").allowed, limit("k").allowed]).toEqual([true, true, false]);
    now = 1_000;
    expect(limit("k").allowed).toBe(true);
  });
});
