import type { StockfishAnalysis } from "@/lib/stockfish";
import type { Analyze } from "@/lib/coach/explain";

/** 1.e4 d5, White to move. 2.Qg4?? loses the queen to ...Bxg4. */
export const QUEEN_BLUNDER_FEN =
  "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2";

export const BEST_ANALYSIS: StockfishAnalysis = {
  bestMove: "e4d5",
  depth: 12,
  score: { type: "cp", value: 30 },
  principalVariation: ["e4d5", "d8d5", "b1c3"],
};

export const PLAYED_ANALYSIS: StockfishAnalysis = {
  bestMove: "d1g4",
  depth: 12,
  score: { type: "cp", value: -850 },
  principalVariation: ["d1g4", "c8g4", "g1f3"],
};

/** Fake Stockfish: returns the played-line analysis when searchMoves is set. */
export function fakeAnalyze(
  best: StockfishAnalysis = BEST_ANALYSIS,
  played: StockfishAnalysis = PLAYED_ANALYSIS
): Analyze {
  return async (_fen, _depth, searchMoves) =>
    searchMoves?.length ? { ...played, bestMove: searchMoves[0] } : best;
}

export const VALID_LLM_JSON = JSON.stringify({
  move: "Qg4",
  why_bad:
    "Qg4 lets Black answer with Bxg4, which can capture your queen on g4. Stockfish's evaluation drops by about 8.8 pawns.",
  better_idea: "Play exd5 instead to keep a solid center.",
});
