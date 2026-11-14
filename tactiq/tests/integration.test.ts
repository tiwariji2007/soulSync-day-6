/**
 * Integration tests against real dependencies.
 *  - Stockfish runs by default (it ships as an npm package, no network needed).
 *  - The Ollama test runs only with RUN_LLM_TESTS=1 and a local Ollama server.
 */
import { describe, expect, it } from "vitest";
import { explainMove } from "@/lib/coach/explain";
import { LlmError, createOllamaJsonGenerator } from "@/lib/llm/ollama";
import { analyzePosition } from "@/lib/stockfish";
import { QUEEN_BLUNDER_FEN } from "./fixtures";

const request = { fen: QUEEN_BLUNDER_FEN, playedMove: "Qg4" };

describe("real Stockfish", () => {
  it("classifies 2.Qg4?? as a blunder and builds a verified fallback", async () => {
    const result = await explainMove(request, {
      analyze: analyzePosition,
      generate: async () => {
        throw new LlmError("LLM_UNAVAILABLE", "disabled in test");
      },
    });

    expect(result.body.moveQuality).toBe("Blunder");
    expect(result.body.source).toBe("fallback");
    expect(result.body.why_bad).toContain("capturing your queen on g4");
    expect(result.body.engine.depthBefore).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe.runIf(process.env.RUN_LLM_TESTS === "1")("real Ollama", () => {
  it("returns either a validated LLM explanation or the deterministic fallback", async () => {
    const result = await explainMove(request, {
      analyze: analyzePosition,
      generate: createOllamaJsonGenerator({
        baseUrl: process.env.OLLAMA_URL,
        model: process.env.OLLAMA_MODEL ?? "qwen2.5:3b",
      }),
    });

    console.info(
      "LLM outcome:",
      result.usage.status,
      result.usage.violations ?? "",
      JSON.stringify(result.body.why_bad)
    );
    expect(["llm", "fallback"]).toContain(result.body.source);
    expect(result.body.move).toBe("Qg4");
    if (result.body.source === "llm") {
      expect(result.usage.status).toBe("success");
      expect(result.usage.promptTokens).toBeGreaterThan(0);
    }
  }, 120_000);
});
