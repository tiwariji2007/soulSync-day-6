import { Chess } from "chess.js";
import { verifyMove } from "./chess-facts";
import type {
  BlunderExplanation,
  MoveQuality,
  VerifiedMove,
} from "./chess-facts";

export const MAX_FIELD_LENGTH = 800;

const REQUIRED_KEYS = ["move", "why_bad", "better_idea"] as const;

export type ParseResult =
  | { ok: true; value: BlunderExplanation }
  | { ok: false; reason: string };

/** Removes check/mate suffixes and annotation glyphs so SAN can be compared. */
export function normalizeSan(san: string): string {
  return san.trim().replace(/[+#!?]+$/g, "");
}

/**
 * Parses the raw model output and enforces the exact JSON contract:
 * an object with exactly `move`, `why_bad` and `better_idea`, all non-empty
 * strings, where `move` equals the move the player actually made.
 */
export function parseExplanation(
  raw: string,
  expectedSan: string
): ParseResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not_an_object" };
  }

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);

  for (const key of REQUIRED_KEYS) {
    if (!(key in record)) {
      return { ok: false, reason: `missing_${key}` };
    }

    const value = record[key];

    if (typeof value !== "string" || value.trim().length === 0) {
      return { ok: false, reason: `empty_or_non_string_${key}` };
    }

    if (value.length > MAX_FIELD_LENGTH) {
      return { ok: false, reason: `too_long_${key}` };
    }
  }

  if (keys.length !== REQUIRED_KEYS.length) {
    return { ok: false, reason: "unexpected_keys" };
  }

  const move = (record.move as string).trim();

  if (normalizeSan(move) !== normalizeSan(expectedSan)) {
    return { ok: false, reason: "move_mismatch" };
  }

  return {
    ok: true,
    value: {
      move: expectedSan,
      why_bad: (record.why_bad as string).trim(),
      better_idea: (record.better_idea as string).trim(),
    },
  };
}

/** Everything the validator is allowed to treat as true. */
export type ChessFacts = {
  fen: string;
  quality: MoveQuality;
  played: VerifiedMove;
  bestMoveSan: string;
  bestLine: string[];
  playedLine: string[];
  opponentReply: VerifiedMove | null;
};

export type ClaimCheck = { ok: true } | { ok: false; violations: string[] };

const PIECE_WORDS: Record<string, string> = {
  pawn: "p",
  knight: "n",
  bishop: "b",
  rook: "r",
  queen: "q",
  king: "k",
};

// SAN moves with a piece letter, a capture, a promotion or castling.
// Bare squares such as "e4" are deliberately not treated as moves because
// coaching text mentions squares all the time.
const SAN_TOKEN =
  /\b(?:O-O(?:-O)?|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=[QRBN])?|[a-h][18]=[QRBN])[+#]?(?![A-Za-z0-9])/g;

const UNVERIFIABLE_MOTIFS =
  /\b(fork(?:s|ed|ing)?|pin(?:s|ned|ning)?|skewer(?:s|ed|ing)?|discovered (?:attack|check)|double attack|deflect(?:ion|s|ed)?|decoy|trapped|traps?|hanging|undefended|en prise|zwischenzug|overload(?:ed)?|king (?:is )?in danger|attack(?:s|ing)? (?:on )?the king|threat(?:s|en|ens|ening)?|mating attack)\b/i;

// "loses the queen for a pawn": the piece after "for" must be what the
// player's move actually captured.
const TRADE_CLAIM =
  /\bfor (?:a|an|the|your|their|black's|white's|only a) (pawn|knight|bishop|rook|queen)\b/gi;

const CAPTURE_CLAIM =
  /\b(captur(?:e|es|ed|ing)|takes|taking|wins (?:the|your|a|an) \w+|loses (?:the|your|a|an) \w+|win(?:s|ning)? material|los(?:e|es|ing) material)\b/i;

const NAMED_CAPTURE =
  /\b(?:captur(?:e|es|ed|ing)|takes|wins)\s+(?:the|your|a|an|white's|black's|its|their|his|her)\s+(pawn|knight|bishop|rook|queen|king)\b/gi;

// "loses a pawn": the player's loss must be the opponent's verified capture.
const NAMED_LOSS =
  /\b(?:lose|loses|losing|lost|drops|hangs|gives up|gives away)\s+(?:the|your|a|an|white's|black's|its|their|his|her)\s+(pawn|knight|bishop|rook|queen)\b/gi;

const CHECK_CLAIM =
  /\b(checkmate|mates?\b|mate in \d+|gives? check|giving check|delivers? check|in check|checks the king)\b/i;

const PIECE_ON_SQUARE =
  /\b(pawn|knight|bishop|rook|queen|king) (?:on|at) ([a-h][1-8])\b/gi;

const PRAISE_FOR_BAD_MOVE =
  /\b(good|great|excellent|strong|best|brilliant|winning) move\b/i;

function allowedSanTokens(facts: ChessFacts): Set<string> {
  return new Set(
    [
      facts.played.san,
      facts.bestMoveSan,
      ...facts.bestLine,
      ...facts.playedLine,
      ...(facts.opponentReply ? [facts.opponentReply.san] : []),
    ].map(normalizeSan)
  );
}

function addPieces(chess: Chess, present: Set<string>) {
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell) present.add(`${cell.type}@${cell.square}`);
    }
  }
}

/**
 * Pieces that stand on a square at some point in the verified sequence:
 * before the move, after the played move, and after the opponent's
 * verified reply. A "piece on square" claim must match one of them.
 */
function piecesOnBoard(facts: ChessFacts): Set<string> {
  const present = new Set<string>();
  const chess = new Chess(facts.fen);
  addPieces(chess, present);

  for (const san of [facts.played.san, facts.opponentReply?.san]) {
    if (!san) break;
    try {
      chess.move(san);
      addPieces(chess, present);
    } catch {
      break;
    }
  }

  return present;
}

/**
 * Checks every chess claim in an LLM explanation against facts verified by
 * chess.js and Stockfish. Any unsupported claim rejects the explanation.
 */
export function validateChessClaims(
  explanation: BlunderExplanation,
  facts: ChessFacts
): ClaimCheck {
  const violations: string[] = [];
  const text = `${explanation.why_bad} ${explanation.better_idea}`;

  // 1. Every move written in SAN must come from the verified move set.
  const allowed = allowedSanTokens(facts);
  for (const token of text.match(SAN_TOKEN) ?? []) {
    if (!allowed.has(normalizeSan(token))) {
      violations.push(`unknown_move:${token}`);
    }
  }

  // 2. Capture claims need a verified capture by the played move or the
  //    opponent's verified reply. A named piece must be the captured piece.
  // The recommended move is verified too, so "exd5 captures a pawn" is fine.
  const bestMove = verifyMove(facts.fen, facts.bestMoveSan);
  const verifiedCaptures = [
    facts.played.captured,
    facts.opponentReply?.captured ?? null,
    bestMove?.captured ?? null,
  ].filter((piece): piece is string => Boolean(piece));

  if (CAPTURE_CLAIM.test(text) && verifiedCaptures.length === 0) {
    violations.push("unsupported_capture_claim");
  }

  for (const match of text.matchAll(NAMED_CAPTURE)) {
    const piece = PIECE_WORDS[match[1].toLowerCase()];
    if (!verifiedCaptures.includes(piece)) {
      violations.push(`unsupported_capture_of_${match[1].toLowerCase()}`);
    }
  }

  for (const match of text.matchAll(NAMED_LOSS)) {
    const piece = PIECE_WORDS[match[1].toLowerCase()];
    if (facts.opponentReply?.captured !== piece) {
      violations.push(`unsupported_loss_of_${match[1].toLowerCase()}`);
    }
  }

  for (const match of text.matchAll(TRADE_CLAIM)) {
    const piece = PIECE_WORDS[match[1].toLowerCase()];
    if (facts.played.captured !== piece) {
      violations.push(`unsupported_trade_for_${match[1].toLowerCase()}`);
    }
  }

  // 3. Check / mate claims need a verified check.
  const verifiedCheck =
    facts.played.givesCheck ||
    facts.played.givesMate ||
    Boolean(facts.opponentReply?.givesCheck || facts.opponentReply?.givesMate) ||
    Boolean(bestMove?.givesCheck || bestMove?.givesMate);

  if (CHECK_CLAIM.test(text) && !verifiedCheck) {
    violations.push("unsupported_check_claim");
  }

  // 4. Tactical motifs cannot be verified by this pipeline, so they are
  //    rejected rather than trusted.
  const motif = text.match(UNVERIFIABLE_MOTIFS);
  if (motif) {
    violations.push(`unverifiable_motif:${motif[0].toLowerCase()}`);
  }

  // 5. "<piece> on <square>" must describe the real board.
  const board = piecesOnBoard(facts);
  for (const match of text.matchAll(PIECE_ON_SQUARE)) {
    const piece = PIECE_WORDS[match[1].toLowerCase()];
    if (!board.has(`${piece}@${match[2].toLowerCase()}`)) {
      violations.push(`wrong_piece_location:${match[1]} on ${match[2]}`);
    }
  }

  // 6. The text must not contradict Stockfish's classification.
  if (
    (facts.quality === "Blunder" || facts.quality === "Mistake") &&
    PRAISE_FOR_BAD_MOVE.test(explanation.why_bad)
  ) {
    violations.push("contradicts_engine_evaluation");
  }

  // 7. The improvement must be the engine's recommended move.
  const bestNormalized = normalizeSan(facts.bestMoveSan);
  const candidates: string[] = [
    ...(explanation.better_idea.match(SAN_TOKEN) ?? []),
    ...(explanation.better_idea.match(/\b[a-h][1-8]\b/g) ?? []),
  ];
  const mentionsBest = candidates.some(
    (token) => normalizeSan(token) === bestNormalized
  );

  if (!mentionsBest) {
    violations.push("better_idea_missing_engine_move");
  }

  // 8. The recommended move belongs to the player, not the opponent.
  const escapedBest = bestNormalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bestAsOpponent = new RegExp(
    `\\b(opponent|they|your rival)\\b[^.]{0,40}\\b${escapedBest}\\b`,
    "i"
  );
  if (bestNormalized !== normalizeSan(facts.opponentReply?.san ?? "") &&
      bestAsOpponent.test(text)) {
    violations.push("engine_move_attributed_to_opponent");
  }

  return violations.length ? { ok: false, violations } : { ok: true };
}
