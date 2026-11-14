import { Chess } from "chess.js";
import type { StockfishAnalysis } from "@/lib/stockfish";
import { LlmError, type GenerateJson } from "@/lib/llm/ollama";
import {
  classifyMove,
  compareEvaluations,
  createFallbackExplanation,
  describeReply,
  formatEvaluation,
  pvToSan,
  uciToSan,
  verifyMove,
  verifyOpponentReply,
  type BlunderExplanation,
  type MoveQuality,
} from "./chess-facts";
import {
  parseExplanation,
  validateChessClaims,
  type ChessFacts,
} from "./validate";

export const ENGINE_DEPTH = 12;

/** Move qualities that are explained by the LLM; others use the engine text. */
export const LLM_EXPLAINED_QUALITIES: ReadonlySet<MoveQuality> = new Set([
  "Blunder",
]);

export class CoachInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoachInputError";
  }
}

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly timedOut: boolean
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export type Analyze = (
  fen: string,
  depth: number,
  searchMoves?: string[]
) => Promise<StockfishAnalysis>;

export type ExplanationSource = "llm" | "engine" | "fallback";

export type UsageStatus =
  | "success"
  | "not_applicable"
  | "fallback_llm_error"
  | "fallback_invalid_json"
  | "fallback_invalid_claims";

export type CoachResult = {
  body: BlunderExplanation & {
    moveQuality: MoveQuality;
    source: ExplanationSource;
    engine: {
      bestMove: string;
      evaluationBefore: string;
      evaluationAfter: string;
      evaluationDifference: string;
      depthBefore?: number;
      depthAfter?: number;
      principalVariation: string;
      playedVariation: string;
    };
  };
  usage: {
    promptTokens: number;
    completionTokens: number;
    status: UsageStatus;
    errorCode?: string;
    violations?: string[];
  };
};

export type CoachRequest = { fen: string; playedMove: string };

export function parseCoachRequest(data: unknown): CoachRequest {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new CoachInputError("Request body must be a JSON object.");
  }

  const body = data as Record<string, unknown>;

  if (
    typeof body.fen !== "string" ||
    body.fen.trim().length === 0 ||
    body.fen.length > 100
  ) {
    throw new CoachInputError("fen must be a FEN string (1-100 characters).");
  }

  if (
    typeof body.playedMove !== "string" ||
    body.playedMove.trim().length === 0 ||
    body.playedMove.length > 10
  ) {
    throw new CoachInputError(
      "playedMove must be a SAN or UCI move (1-10 characters)."
    );
  }

  return { fen: body.fen.trim(), playedMove: body.playedMove.trim() };
}

/** One plain sentence of verified fact that the explanation should build on. */
export function keyFact(facts: ChessFacts): string {
  const reply = facts.opponentReply;
  const side = facts.played.color === "w" ? "White" : "Black";
  const opponent = facts.played.color === "w" ? "Black" : "White";
  const names: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

  if (reply?.captured) {
    return `After ${facts.played.san}, ${opponent} replies ${reply.san} and captures ${side}'s ${names[reply.captured]}.`;
  }
  if (reply?.givesMate) return `After ${facts.played.san}, ${opponent} replies ${reply.san} with checkmate.`;
  if (reply?.givesCheck) return `After ${facts.played.san}, ${opponent} replies ${reply.san} with check.`;
  return `After ${facts.played.san}, Stockfish's evaluation for ${side} is much worse; the exact reason is not certain.`;
}

export function buildPrompt(facts: ChessFacts, extras: {
  evaluationBefore: string;
  evaluationAfter: string;
  evaluationDifference: string;
}): string {
  const line = (moves: string[]) => (moves.length ? moves.join(" ") : "Unavailable");

  return `You are TactiQ, a chess coach teaching beginners.
Explain the player's move using ONLY the facts below. Every fact was verified by Stockfish and chess.js.

POSITION FEN: ${facts.fen}
PLAYER MOVE: ${facts.played.san}
MOVE QUALITY: ${facts.quality}
STOCKFISH RECOMMENDATION (the player's better alternative): ${facts.bestMoveSan}
EVALUATION WITH BEST MOVE: ${extras.evaluationBefore}
EVALUATION AFTER PLAYER MOVE: ${extras.evaluationAfter}
EVALUATION DIFFERENCE: ${extras.evaluationDifference}
BEST VARIATION: ${line(facts.bestLine)}
PLAYED VARIATION: ${line(facts.playedLine)}
VERIFIED OPPONENT RESPONSE: ${describeReply(facts.opponentReply)}
KEY FACT: ${keyFact(facts)}

RULES:
- Plain English, at most three sentences per field. Build why_bad on the KEY FACT.
- No piece is "in check" unless the facts say "check". Only kings can be in check.
- Mention only moves that appear above. Do not invent moves, captures, checks or threats.
- Do not name tactical motifs (fork, pin, skewer, trapped, hanging piece, threats, king safety).
- Do not describe material trades ("X for Y") unless the player move itself captured Y.
- Describe captures or checks only if the VERIFIED OPPONENT RESPONSE or the player move confirms them.
- Do not contradict the move quality. Never praise a blunder.
- better_idea must recommend ${facts.bestMoveSan} for the player.
- If the reason is unclear, say so honestly.

Return JSON only, with exactly these keys:
{"move": "${facts.played.san}", "why_bad": "...", "better_idea": "..."}`;
}

async function runEngine<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    throw new EngineError(
      "The chess engine could not analyze this position.",
      /timed out/i.test(message)
    );
  }
}

/**
 * Analyzes a move with Stockfish, asks the LLM for a blunder explanation,
 * validates the JSON and every chess claim, and falls back to a deterministic
 * engine explanation whenever the LLM output cannot be trusted.
 */
export async function explainMove(
  request: CoachRequest,
  deps: { analyze: Analyze; generate: GenerateJson }
): Promise<CoachResult> {
  let chess: Chess;

  try {
    chess = new Chess(request.fen);
  } catch {
    throw new CoachInputError("Invalid FEN position.");
  }

  if (chess.isGameOver()) {
    throw new CoachInputError("This chess position is already finished.");
  }

  const turn = chess.turn();
  const played = verifyMove(request.fen, request.playedMove);

  if (!played) {
    throw new CoachInputError("The submitted move is illegal in this position.");
  }

  const playedUci = `${played.from}${played.to}${played.promotion ?? ""}`;

  const bestAnalysis = await runEngine(() =>
    deps.analyze(request.fen, ENGINE_DEPTH)
  );
  const playedAnalysis = await runEngine(() =>
    deps.analyze(request.fen, ENGINE_DEPTH, [playedUci])
  );

  const bestMoveSan = await runEngine(async () =>
    uciToSan(request.fen, bestAnalysis.bestMove)
  );

  const quality = classifyMove(
    bestAnalysis.score,
    playedAnalysis.score,
    playedUci === bestAnalysis.bestMove
  );

  const bestLine = pvToSan(request.fen, bestAnalysis.principalVariation);
  const playedLine = pvToSan(request.fen, playedAnalysis.principalVariation);
  const opponentReply = verifyOpponentReply(request.fen, played.san, playedLine);

  const evaluationBefore = formatEvaluation(bestAnalysis.score, turn);
  const evaluationAfter = formatEvaluation(playedAnalysis.score, turn);
  const evaluationDifference = compareEvaluations(
    bestAnalysis.score,
    playedAnalysis.score
  );

  const facts: ChessFacts = {
    fen: request.fen,
    quality,
    played,
    bestMoveSan,
    bestLine,
    playedLine,
    opponentReply,
  };

  const fallback = createFallbackExplanation({
    quality,
    played,
    bestMoveSan,
    evaluationDifference,
    bestLine,
    playedLine,
    opponentReply,
  });

  const engine = {
    bestMove: bestMoveSan,
    evaluationBefore,
    evaluationAfter,
    evaluationDifference,
    depthBefore: bestAnalysis.depth,
    depthAfter: playedAnalysis.depth,
    principalVariation: bestLine.join(" ") || "Unavailable",
    playedVariation: playedLine.join(" ") || "Unavailable",
  };

  const respond = (
    explanation: BlunderExplanation,
    source: ExplanationSource,
    usage: CoachResult["usage"]
  ): CoachResult => ({
    body: { ...explanation, moveQuality: quality, source, engine },
    usage,
  });

  if (!LLM_EXPLAINED_QUALITIES.has(quality)) {
    return respond(fallback, "engine", {
      promptTokens: 0,
      completionTokens: 0,
      status: "not_applicable",
    });
  }

  const prompt = buildPrompt(facts, {
    evaluationBefore,
    evaluationAfter,
    evaluationDifference,
  });

  let completion;

  try {
    completion = await deps.generate(prompt);
  } catch (error) {
    return respond(fallback, "fallback", {
      promptTokens: 0,
      completionTokens: 0,
      status: "fallback_llm_error",
      errorCode: error instanceof LlmError ? error.code : "LLM_UNKNOWN_ERROR",
    });
  }

  const tokens = {
    promptTokens: completion.promptTokens,
    completionTokens: completion.completionTokens,
  };

  const parsed = parseExplanation(completion.text, played.san);

  if (!parsed.ok) {
    return respond(fallback, "fallback", {
      ...tokens,
      status: "fallback_invalid_json",
      errorCode: parsed.reason.toUpperCase(),
    });
  }

  const claims = validateChessClaims(parsed.value, facts);

  if (!claims.ok) {
    return respond(fallback, "fallback", {
      ...tokens,
      status: "fallback_invalid_claims",
      errorCode: "UNSUPPORTED_CHESS_CLAIM",
      violations: claims.violations,
    });
  }

  return respond(parsed.value, "llm", { ...tokens, status: "success" });
}
