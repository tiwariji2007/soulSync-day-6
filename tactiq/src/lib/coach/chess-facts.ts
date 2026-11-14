import { Chess, type Move } from "chess.js";

export type Side = "w" | "b";

export type EngineScore = {
  type: "cp" | "mate";
  value: number;
};

export type MoveQuality =
  | "Best"
  | "Good"
  | "Inaccuracy"
  | "Mistake"
  | "Blunder"
  | "Needs review";

export type BlunderExplanation = {
  move: string;
  why_bad: string;
  better_idea: string;
};

/** Facts about one move, verified with chess.js (never taken from the LLM). */
export type VerifiedMove = {
  san: string;
  color: Side;
  piece: string;
  from: string;
  to: string;
  captured: string | null;
  promotion: string | null;
  givesCheck: boolean;
  givesMate: boolean;
};

const PIECE_NAMES: Record<string, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

const UCI_REGEX = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

export function pieceName(piece: string | null): string {
  return piece ? (PIECE_NAMES[piece] ?? piece) : "piece";
}

export function sideName(color: Side): string {
  return color === "w" ? "White" : "Black";
}

/** Plays a move given in UCI ("e2e4") or SAN ("e4"). Returns null when illegal. */
export function playMove(chess: Chess, moveText: string): Move | null {
  try {
    const match = moveText.match(UCI_REGEX);

    if (match) {
      return chess.move({
        from: match[1],
        to: match[2],
        ...(match[3]
          ? { promotion: match[3] as "q" | "r" | "b" | "n" }
          : {}),
      });
    }

    return chess.move(moveText);
  } catch {
    return null;
  }
}

function toVerifiedMove(chess: Chess, move: Move): VerifiedMove {
  return {
    san: move.san,
    color: move.color,
    piece: move.piece,
    from: move.from,
    to: move.to,
    captured: move.captured ?? null,
    promotion: move.promotion ?? null,
    givesCheck: chess.isCheck(),
    givesMate: chess.isCheckmate(),
  };
}

/** Verifies a move in a position. Returns null when the move is illegal. */
export function verifyMove(fen: string, moveText: string): VerifiedMove | null {
  const chess = new Chess(fen);
  const move = playMove(chess, moveText);
  return move ? toVerifiedMove(chess, move) : null;
}

export function uciToSan(fen: string, uci: string): string {
  if (!UCI_REGEX.test(uci)) {
    throw new Error("Stockfish returned an invalid move.");
  }

  const verified = verifyMove(fen, uci);

  if (!verified) {
    throw new Error("Stockfish returned an illegal move.");
  }

  return verified.san;
}

/** Converts a UCI principal variation to SAN, stopping at the first illegal move. */
export function pvToSan(fen: string, pv: string[] | undefined): string[] {
  if (!pv) return [];

  const chess = new Chess(fen);
  const moves: string[] = [];

  for (const uci of pv) {
    const move = playMove(chess, uci);
    if (!move) break;
    moves.push(move.san);
  }

  return moves;
}

export function formatEvaluation(
  score: EngineScore | undefined,
  turn: Side
): string {
  if (!score) return "Unavailable";

  const whitePerspective = score.value * (turn === "w" ? 1 : -1);

  if (score.type === "mate") {
    if (whitePerspective > 0) {
      return `Mate in ${Math.abs(whitePerspective)} for White`;
    }

    if (whitePerspective < 0) {
      return `Mate in ${Math.abs(whitePerspective)} for Black`;
    }

    return "Mate score unavailable";
  }

  return `${(whitePerspective / 100).toFixed(2)} pawns from White's perspective`;
}

/**
 * Stockfish scores (from the side to move) converted to a comparable
 * centipawn number. Mate scores are mapped far beyond any material score.
 */
export function scoreToCentipawns(score: EngineScore): number {
  if (score.type === "cp") return score.value;
  const sign = score.value >= 0 ? 1 : -1;
  return sign * (100_000 - Math.abs(score.value) * 100);
}

export function evaluationLoss(
  bestScore: EngineScore | undefined,
  playedScore: EngineScore | undefined
): number | null {
  if (!bestScore || !playedScore) return null;
  return Math.max(
    0,
    scoreToCentipawns(bestScore) - scoreToCentipawns(playedScore)
  );
}

export function compareEvaluations(
  bestScore: EngineScore | undefined,
  playedScore: EngineScore | undefined
): string {
  if (!bestScore || !playedScore) {
    return "The engine could not provide a complete evaluation comparison.";
  }

  if (bestScore.type === "cp" && playedScore.type === "cp") {
    const loss = Math.max(0, bestScore.value - playedScore.value);
    return `Evaluation loss: ${(loss / 100).toFixed(2)} pawns.`;
  }

  return `Best-line score: ${bestScore.type} ${bestScore.value}. Played-line score: ${playedScore.type} ${playedScore.value}.`;
}

export function classifyMove(
  bestScore: EngineScore | undefined,
  playedScore: EngineScore | undefined,
  isBestMove: boolean
): MoveQuality {
  if (isBestMove) return "Best";

  // Both lines are forced mates for the same side: the game outcome is
  // unchanged, so a slower mate is not a blunder.
  if (
    bestScore?.type === "mate" &&
    playedScore?.type === "mate" &&
    Math.sign(bestScore.value) === Math.sign(playedScore.value)
  ) {
    return "Good";
  }

  const loss = evaluationLoss(bestScore, playedScore);

  if (loss === null) return "Needs review";

  // A move that turns a winning mate into a non-mate (or allows mate)
  // produces a huge loss and is classified as a blunder below.
  if (loss <= 20) return "Good";
  if (loss <= 50) return "Inaccuracy";
  if (loss <= 100) return "Mistake";

  return "Blunder";
}

export function describeMove(move: VerifiedMove): string {
  const side = sideName(move.color);
  const piece = pieceName(move.piece);

  let description = `${side}'s ${piece} moves from ${move.from} to ${move.to}.`;

  if (move.captured) {
    const opponent = sideName(move.color === "w" ? "b" : "w");
    description += ` It captures ${opponent}'s ${pieceName(move.captured)}.`;
  } else {
    description += " It does not capture a piece.";
  }

  if (move.promotion) {
    description += ` The pawn promotes to a ${pieceName(move.promotion)}.`;
  }

  if (move.givesMate) {
    description += " This move gives checkmate.";
  } else if (move.givesCheck) {
    description += " This move gives check to the opponent.";
  }

  return description;
}

/**
 * The opponent's immediate reply in the engine's line after the played move,
 * verified with chess.js. Returns null when no legal reply is available.
 */
export function verifyOpponentReply(
  fen: string,
  playedSan: string,
  playedLine: string[]
): VerifiedMove | null {
  const chess = new Chess(fen);
  const played = playMove(chess, playedSan);
  if (!played) return null;

  const startIndex = playedLine[0] === played.san ? 1 : 0;
  const replySan = playedLine[startIndex];
  if (!replySan) return null;

  const reply = playMove(chess, replySan);
  return reply ? toVerifiedMove(chess, reply) : null;
}

export function describeReply(reply: VerifiedMove | null): string {
  if (!reply) return "Unavailable";

  if (reply.captured) {
    const capturedSide = sideName(reply.color === "w" ? "b" : "w");
    return `${reply.san}: captures ${capturedSide}'s ${pieceName(reply.captured)} on ${reply.to}.`;
  }

  if (reply.givesMate) return `${reply.san}: delivers checkmate.`;
  if (reply.givesCheck) return `${reply.san}: gives check.`;

  return `${reply.san}: no immediate capture or check.`;
}

function tacticalConsequence(reply: VerifiedMove | null): string {
  if (!reply) return "";

  const opponent = sideName(reply.color);

  if (reply.captured) {
    return `${opponent} can respond with ${reply.san}, capturing your ${pieceName(reply.captured)} on ${reply.to}.`;
  }

  if (reply.givesMate) {
    return `${opponent} can respond with ${reply.san}, delivering checkmate.`;
  }

  if (reply.givesCheck) {
    return `${opponent} can respond with ${reply.san}, giving check.`;
  }

  return "";
}

export type FallbackInput = {
  quality: MoveQuality;
  played: VerifiedMove;
  bestMoveSan: string;
  evaluationDifference: string;
  bestLine: string[];
  playedLine: string[];
  opponentReply: VerifiedMove | null;
};

function lineText(line: string[]): string {
  return line.length ? line.join(" ") : "Unavailable";
}

/**
 * Deterministic, engine-derived explanation. Used whenever the LLM is not
 * called, fails, or returns output that does not pass validation. The same
 * input always produces the same output.
 */
export function createFallbackExplanation(
  input: FallbackInput
): BlunderExplanation {
  const {
    quality,
    played,
    bestMoveSan,
    evaluationDifference,
    opponentReply,
  } = input;

  const bestVariation = lineText(input.bestLine);
  const playedVariation = lineText(input.playedLine);
  const moveDescription = describeMove(played);
  const kingNote =
    played.piece === "k"
      ? " Because this is a legal king move, it does not leave your own king in check."
      : "";
  const intro = `${moveDescription}${kingNote}`;

  switch (quality) {
    case "Best":
      return {
        move: played.san,
        why_bad: `${intro} This is Stockfish's preferred move. ${evaluationDifference}`,
        better_idea: `You found Stockfish's preferred move. Continue calculating your opponent's strongest response. Best continuation: ${bestVariation}.`,
      };
    case "Good":
      return {
        move: played.san,
        why_bad: `${intro} This is a good move. Stockfish finds only a small evaluation difference compared with its preferred move. ${evaluationDifference}`,
        better_idea: `Stockfish recommends ${bestMoveSan}. Compare the two continuations: ${bestVariation} versus ${playedVariation}.`,
      };
    case "Inaccuracy":
      return {
        move: played.san,
        why_bad: `${intro} Stockfish identifies this as a small inaccuracy. Another move would preserve a better position. ${evaluationDifference}`,
        better_idea: `Consider ${bestMoveSan}, Stockfish's preferred move. Its suggested continuation is ${bestVariation}.`,
      };
    case "Mistake":
      return {
        move: played.san,
        why_bad: `${intro} Stockfish identifies this as a mistake because the resulting evaluation is noticeably worse than its preferred continuation. ${evaluationDifference}`,
        better_idea: `Stockfish recommends ${bestMoveSan}. Study this continuation: ${bestVariation}. Compare it with your played line: ${playedVariation}.`,
      };
    case "Blunder": {
      const consequence = tacticalConsequence(opponentReply);
      return {
        move: played.san,
        why_bad: [
          intro,
          "Stockfish identifies this as a blunder because its evaluation is substantially worse than the best available continuation.",
          evaluationDifference,
          consequence,
        ]
          .filter(Boolean)
          .join(" "),
        better_idea: `Stockfish recommends ${bestMoveSan}. Its suggested continuation is ${bestVariation}. Compare it carefully with your played continuation: ${playedVariation}.`,
      };
    }
    default:
      return {
        move: played.san,
        why_bad: `${intro} Stockfish could not reliably classify this move using the available evaluation.`,
        better_idea: `Stockfish's top candidate is ${bestMoveSan}. Study the continuation ${bestVariation} before deciding on your plan.`,
      };
  }
}
