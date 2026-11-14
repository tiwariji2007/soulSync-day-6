import { describe, expect, it, vi } from "vitest";
import {
  CoachInputError,
  EngineError,
  explainMove,
  parseCoachRequest,
} from "@/lib/coach/explain";
import { LlmError, type GenerateJson } from "@/lib/llm/ollama";
import {
  BEST_ANALYSIS,
  PLAYED_ANALYSIS,
  QUEEN_BLUNDER_FEN,
  VALID_LLM_JSON,
  fakeAnalyze,
} from "./fixtures";

const request = { fen: QUEEN_BLUNDER_FEN, playedMove: "Qg4" };

const llmReturning = (text: string): GenerateJson =>
  vi.fn(async () => ({ text, promptTokens: 400, completionTokens: 80 }));

async function fallbackFor() {
  // The deterministic fallback for this position, produced via a failing LLM.
  const result = await explainMove(request, {
    analyze: fakeAnalyze(),
    generate: async () => {
      throw new LlmError("LLM_UNAVAILABLE", "down");
    },
  });
  return result.body;
}

describe("parseCoachRequest", () => {
  it.each([
    [null],
    [[]],
    [{}],
    [{ fen: "", playedMove: "e4" }],
    [{ fen: QUEEN_BLUNDER_FEN }],
    [{ fen: QUEEN_BLUNDER_FEN, playedMove: "" }],
    [{ fen: QUEEN_BLUNDER_FEN, playedMove: "x".repeat(11) }],
    [{ fen: "x".repeat(101), playedMove: "e4" }],
    [{ fen: 42, playedMove: "e4" }],
  ])("rejects %j", (body) => {
    expect(() => parseCoachRequest(body)).toThrow(CoachInputError);
  });
});

describe("explainMove", () => {
  it("returns the validated LLM explanation for a blunder", async () => {
    const generate = llmReturning(VALID_LLM_JSON);
    const result = await explainMove(request, { analyze: fakeAnalyze(), generate });

    expect(generate).toHaveBeenCalledOnce();
    const prompt = vi.mocked(generate).mock.calls[0][0];
    expect(prompt).toContain("PLAYER MOVE: Qg4");
    expect(prompt).toContain("VERIFIED OPPONENT RESPONSE: Bxg4: captures White's queen on g4.");
    expect(prompt).toContain("KEY FACT: After Qg4, Black replies Bxg4 and captures White's queen.");

    expect(result.body).toMatchObject({
      move: "Qg4",
      moveQuality: "Blunder",
      source: "llm",
      why_bad: expect.stringContaining("Bxg4"),
      engine: {
        bestMove: "exd5",
        principalVariation: "exd5 Qxd5 Nc3",
        playedVariation: "Qg4 Bxg4 Nf3",
      },
    });
    expect(result.usage).toEqual({ promptTokens: 400, completionTokens: 80, status: "success" });
  });

  it.each([
    ["invalid JSON", "{not json", "fallback_invalid_json"],
    ["missing better_idea", JSON.stringify({ move: "Qg4", why_bad: "bad" }), "fallback_invalid_json"],
    ["wrong move", JSON.stringify({ move: "Qh5", why_bad: "a", better_idea: "exd5" }), "fallback_invalid_json"],
    [
      "hallucinated tactic",
      JSON.stringify({ move: "Qg4", why_bad: "Black forks your king and rook with Nc2.", better_idea: "Play exd5." }),
      "fallback_invalid_claims",
    ],
  ])("falls back deterministically on %s", async (_label, text, status) => {
    const result = await explainMove(request, {
      analyze: fakeAnalyze(),
      generate: llmReturning(text),
    });

    expect(result.body.source).toBe("fallback");
    expect(result.usage.status).toBe(status);
    // Tokens were spent even though the output was rejected.
    expect(result.usage.promptTokens).toBe(400);

    const expected = await fallbackFor();
    expect(result.body).toEqual(expected);
  });

  it("falls back and records the error code when the LLM fails", async () => {
    const result = await explainMove(request, {
      analyze: fakeAnalyze(),
      generate: async () => {
        throw new LlmError("LLM_TIMEOUT", "timeout");
      },
    });

    expect(result.body.source).toBe("fallback");
    expect(result.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      status: "fallback_llm_error",
      errorCode: "LLM_TIMEOUT",
    });
  });

  it("does not call the LLM for non-blunders", async () => {
    const generate = llmReturning(VALID_LLM_JSON);
    const result = await explainMove(request, {
      analyze: fakeAnalyze(BEST_ANALYSIS, {
        ...PLAYED_ANALYSIS,
        score: { type: "cp", value: 20 },
      }),
      generate,
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.body).toMatchObject({ moveQuality: "Good", source: "engine" });
    expect(result.usage.status).toBe("not_applicable");
  });

  it("rejects illegal moves before calling the engine", async () => {
    const analyze = vi.fn(fakeAnalyze());
    await expect(
      explainMove({ fen: QUEEN_BLUNDER_FEN, playedMove: "Qh7" }, { analyze, generate: llmReturning("") })
    ).rejects.toThrow(CoachInputError);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("rejects invalid FEN and finished games", async () => {
    const deps = { analyze: fakeAnalyze(), generate: llmReturning("") };
    await expect(explainMove({ fen: "garbage", playedMove: "e4" }, deps)).rejects.toThrow(
      "Invalid FEN position."
    );
    // Fool's mate: White is checkmated.
    const mated = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    await expect(explainMove({ fen: mated, playedMove: "e4" }, deps)).rejects.toThrow(
      /already finished/
    );
  });

  it("wraps engine failures and flags timeouts", async () => {
    const failing = async () => {
      throw new Error("Stockfish analysis timed out.");
    };
    const error = await explainMove(request, {
      analyze: failing,
      generate: llmReturning(""),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).timedOut).toBe(true);
  });

  it("treats an illegal engine best move as an engine failure", async () => {
    const error = await explainMove(request, {
      analyze: fakeAnalyze({ ...BEST_ANALYSIS, bestMove: "a1a8" }),
      generate: llmReturning(""),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).timedOut).toBe(false);
  });
});
