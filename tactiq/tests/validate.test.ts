import { describe, expect, it } from "vitest";
import { verifyMove, verifyOpponentReply } from "@/lib/coach/chess-facts";
import {
  normalizeSan,
  parseExplanation,
  validateChessClaims,
  type ChessFacts,
} from "@/lib/coach/validate";
import { QUEEN_BLUNDER_FEN, VALID_LLM_JSON } from "./fixtures";

function blunderFacts(): ChessFacts {
  const played = verifyMove(QUEEN_BLUNDER_FEN, "Qg4");
  if (!played) throw new Error("fixture move must be legal");
  const playedLine = ["Qg4", "Bxg4", "Nf3"];
  return {
    fen: QUEEN_BLUNDER_FEN,
    quality: "Blunder",
    played,
    bestMoveSan: "exd5",
    bestLine: ["exd5", "Qxd5", "Nc3"],
    playedLine,
    opponentReply: verifyOpponentReply(QUEEN_BLUNDER_FEN, "Qg4", playedLine),
  };
}

const explanation = (why_bad: string, better_idea = "Play exd5 instead.") => ({
  move: "Qg4",
  why_bad,
  better_idea,
});

describe("normalizeSan", () => {
  it("strips check, mate and annotation suffixes", () => {
    expect(normalizeSan("Qxf7#")).toBe("Qxf7");
    expect(normalizeSan("Nf3+")).toBe("Nf3");
    expect(normalizeSan(" e4!? ")).toBe("e4");
  });
});

describe("parseExplanation", () => {
  it("accepts the exact JSON contract", () => {
    const result = parseExplanation(VALID_LLM_JSON, "Qg4");
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ move: "Qg4" }),
    });
  });

  it("accepts the move with a check suffix difference", () => {
    const raw = JSON.stringify({ move: "Qg4+", why_bad: "x", better_idea: "y" });
    expect(parseExplanation(raw, "Qg4").ok).toBe(true);
  });

  it.each([
    ["not json", "invalid_json"],
    ["[1,2]", "not_an_object"],
    ["null", "not_an_object"],
    [JSON.stringify({ why_bad: "a", better_idea: "b" }), "missing_move"],
    [JSON.stringify({ move: "Qg4", better_idea: "b" }), "missing_why_bad"],
    [JSON.stringify({ move: "Qg4", why_bad: "a" }), "missing_better_idea"],
    [JSON.stringify({ move: "Qg4", why_bad: "  ", better_idea: "b" }), "empty_or_non_string_why_bad"],
    [JSON.stringify({ move: "Qg4", why_bad: 3, better_idea: "b" }), "empty_or_non_string_why_bad"],
    [JSON.stringify({ move: "Qg4", why_bad: "a".repeat(801), better_idea: "b" }), "too_long_why_bad"],
    [JSON.stringify({ move: "Qg4", why_bad: "a", better_idea: "b", extra: 1 }), "unexpected_keys"],
    [JSON.stringify({ move: "Qh5", why_bad: "a", better_idea: "b" }), "move_mismatch"],
  ])("rejects %s with reason %s", (raw, reason) => {
    expect(parseExplanation(raw, "Qg4")).toEqual({ ok: false, reason });
  });
});

describe("validateChessClaims", () => {
  it("accepts an explanation grounded in verified facts", () => {
    const parsed = parseExplanation(VALID_LLM_JSON, "Qg4");
    if (!parsed.ok) throw new Error("fixture must parse");
    expect(validateChessClaims(parsed.value, blunderFacts())).toEqual({ ok: true });
  });

  it.each([
    ["an invented move", "After Qg4 Black plays Nxe4 and wins.", "unknown_move:Nxe4"],
    ["an unsupported check", "Qg4 allows Bxg4 which gives check.", "unsupported_check_claim"],
    ["an unverifiable motif", "Qg4 walks into a fork.", "unverifiable_motif:fork"],
    ["a piece that is not on that square", "Your knight on e5 is left alone.", "wrong_piece_location:knight on e5"],
    ["praise for a blunder", "This is a strong move but risky.", "contradicts_engine_evaluation"],
    ["a capture of the wrong piece", "Bxg4 captures your rook.", "unsupported_capture_of_rook"],
    // Regression: real qwen2.5:3b output for this position (2026-11-14).
    [
      "an invented material trade",
      "The move Qg4 loses a queen for a pawn, resulting in a significant evaluation loss.",
      "unsupported_trade_for_pawn",
    ],
    // Regression: real qwen2.5:3b output before the KEY FACT prompt line.
    [
      "a false check claim about a non-king piece",
      "The move Qg4 puts the queen in check, leading to a loss of material.",
      "unsupported_check_claim",
    ],
    [
      "a loss that only the recommended move's capture could explain",
      "The move Qg4 loses a pawn.",
      "unsupported_loss_of_pawn",
    ],
    [
      "an unverified king-safety claim",
      "This allows Bxg4, putting White's king in danger.",
      "unverifiable_motif:king in danger",
    ],
  ])("rejects %s", (_label, whyBad, violation) => {
    const result = validateChessClaims(explanation(whyBad), blunderFacts());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations).toContain(violation);
  });

  it("rejects a better_idea that does not recommend the engine move", () => {
    const result = validateChessClaims(
      explanation("Qg4 loses the queen to Bxg4.", "Develop with Nf3."),
      blunderFacts()
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toContain("better_idea_missing_engine_move");
    }
  });

  it("accepts the validated real qwen2.5:3b output", () => {
    expect(
      validateChessClaims(
        explanation(
          "The move Qg4 allows Black to capture the queen on g4 with Bxg4, resulting in a significant loss of material and a positional disadvantage for White.",
          "exd5"
        ),
        blunderFacts()
      )
    ).toEqual({ ok: true });
    expect(
      validateChessClaims(explanation("Qg4 loses the queen to Bxg4."), blunderFacts())
    ).toEqual({ ok: true });
  });

  it("accepts true claims about the reply position and the recommended move", () => {
    // Regression for false rejections seen with real qwen2.5:3b output.
    expect(
      validateChessClaims(
        explanation(
          "After Bxg4 the bishop on g4 has captured your queen.",
          "Play exd5, which captures a pawn in the center."
        ),
        blunderFacts()
      )
    ).toEqual({ ok: true });
  });

  it("rejects capture claims when no capture was verified", () => {
    // Neither the played move, the reply, nor the recommended Nf3 captures.
    const facts = {
      ...blunderFacts(),
      opponentReply: null,
      bestMoveSan: "Nf3",
      bestLine: ["Nf3"],
    };
    const result = validateChessClaims(
      explanation("Qg4 loses material immediately.", "Play Nf3 instead."),
      facts
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations).toContain("unsupported_capture_claim");
  });

  it("rejects the engine move being attributed to the opponent", () => {
    const result = validateChessClaims(
      explanation("Your opponent can now play exd5 here."),
      blunderFacts()
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toContain("engine_move_attributed_to_opponent");
    }
  });
});
