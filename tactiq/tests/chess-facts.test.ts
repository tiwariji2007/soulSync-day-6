import { describe, expect, it } from "vitest";
import {
  classifyMove,
  createFallbackExplanation,
  formatEvaluation,
  pvToSan,
  uciToSan,
  verifyMove,
  verifyOpponentReply,
} from "@/lib/coach/chess-facts";
import { QUEEN_BLUNDER_FEN } from "./fixtures";

const cp = (value: number) => ({ type: "cp" as const, value });
const mate = (value: number) => ({ type: "mate" as const, value });

describe("classifyMove", () => {
  it.each([
    [cp(30), cp(30), true, "Best"],
    [cp(30), cp(10), false, "Good"],
    [cp(30), cp(-20), false, "Inaccuracy"],
    [cp(30), cp(-70), false, "Mistake"],
    [cp(30), cp(-71), false, "Blunder"],
    [cp(30), cp(-850), false, "Blunder"],
    [mate(2), cp(500), false, "Blunder"],
    [cp(0), mate(-3), false, "Blunder"],
    [mate(2), mate(4), false, "Good"],
    [undefined, cp(10), false, "Needs review"],
  ] as const)("best=%o played=%o isBest=%s -> %s", (best, played, isBest, expected) => {
    expect(classifyMove(best, played, isBest)).toBe(expected);
  });
});

describe("move verification", () => {
  it("verifies SAN and UCI input to the same move", () => {
    expect(verifyMove(QUEEN_BLUNDER_FEN, "Qg4")).toEqual(
      verifyMove(QUEEN_BLUNDER_FEN, "d1g4")
    );
  });

  it("returns null for illegal moves instead of throwing", () => {
    expect(verifyMove(QUEEN_BLUNDER_FEN, "Qh7")).toBeNull();
    expect(verifyMove(QUEEN_BLUNDER_FEN, "zz")).toBeNull();
  });

  it("verifies the opponent reply captures the queen", () => {
    const reply = verifyOpponentReply(QUEEN_BLUNDER_FEN, "Qg4", ["Qg4", "Bxg4"]);
    expect(reply).toMatchObject({ san: "Bxg4", captured: "q", to: "g4", color: "b" });
  });

  it("rejects illegal engine moves", () => {
    expect(() => uciToSan(QUEEN_BLUNDER_FEN, "e1e5")).toThrow(/illegal/);
    expect(() => uciToSan(QUEEN_BLUNDER_FEN, "bad")).toThrow(/invalid/);
  });

  it("stops a principal variation at the first illegal move", () => {
    expect(pvToSan(QUEEN_BLUNDER_FEN, ["e4d5", "a1a8", "d8d5"])).toEqual(["exd5"]);
  });
});

describe("formatEvaluation", () => {
  it("reports scores from White's perspective", () => {
    expect(formatEvaluation(cp(50), "b")).toBe("-0.50 pawns from White's perspective");
    expect(formatEvaluation(mate(3), "w")).toBe("Mate in 3 for White");
    expect(formatEvaluation(undefined, "w")).toBe("Unavailable");
  });
});

describe("createFallbackExplanation", () => {
  const played = verifyMove(QUEEN_BLUNDER_FEN, "Qg4")!;
  const input = {
    quality: "Blunder" as const,
    played,
    bestMoveSan: "exd5",
    evaluationDifference: "Evaluation loss: 8.80 pawns.",
    bestLine: ["exd5", "Qxd5"],
    playedLine: ["Qg4", "Bxg4"],
    opponentReply: verifyOpponentReply(QUEEN_BLUNDER_FEN, "Qg4", ["Qg4", "Bxg4"]),
  };

  it("is deterministic", () => {
    expect(createFallbackExplanation(input)).toEqual(createFallbackExplanation(input));
  });

  it("uses only verified facts", () => {
    const result = createFallbackExplanation(input);
    expect(result.move).toBe("Qg4");
    expect(result.why_bad).toContain("Black can respond with Bxg4, capturing your queen on g4.");
    expect(result.better_idea).toContain("Stockfish recommends exd5");
  });

  it("produces all three fields for every quality", () => {
    for (const quality of ["Best", "Good", "Inaccuracy", "Mistake", "Blunder", "Needs review"] as const) {
      const result = createFallbackExplanation({ ...input, quality });
      expect(Object.keys(result).sort()).toEqual(["better_idea", "move", "why_bad"]);
      expect(result.why_bad.length).toBeGreaterThan(0);
    }
  });
});
