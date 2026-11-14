
"use client";

import { useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";

type MoveQuality =
  | "Best"
  | "Good"
  | "Inaccuracy"
  | "Mistake"
  | "Blunder"
  | "Needs review";

type LastMove = {
  fen: string;
  playedMove: string;
};

type Analysis = {
  move: string;
  moveQuality: MoveQuality;
  why_bad: string;
  better_idea: string;
  source?: "llm" | "engine" | "fallback";
  engine?: {
    bestMove: string;
    evaluationBefore: string;
    evaluationAfter: string;
    depthBefore: number;
    depthAfter: number;
  };
};

const qualityStyles: Record<MoveQuality, string> = {
  Best: "bg-green-100 text-green-800",
  Good: "bg-emerald-100 text-emerald-800",
  Inaccuracy: "bg-yellow-100 text-yellow-800",
  Mistake: "bg-orange-100 text-orange-800",
  Blunder: "bg-red-100 text-red-800",
  "Needs review": "bg-zinc-200 text-zinc-800",
};

export default function ChessBoard() {
  const [fen, setFen] = useState(new Chess().fen());
  const [moveHistory, setMoveHistory] = useState<string[]>([]);
  const [engineThinking, setEngineThinking] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [lastMove, setLastMove] = useState<LastMove | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState("");

  const gameSession = useRef(0);

  const currentGame = new Chess(fen);
  const gameOver = currentGame.isGameOver();
  const turn = currentGame.turn();

  async function playStockfishMove(
    position: string,
    history: string[],
    session: number
  ) {
    setEngineThinking(true);
    setError("");

    try {
      const response = await fetch("/api/test-stockfish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fen: position }),
      });

      const data = await response.json();

      if (!response.ok || !data.analysis?.bestMove) {
        throw new Error(
          data.error || "Stockfish could not find a move."
        );
      }

      if (session !== gameSession.current) return;

      const bestMove = data.analysis.bestMove;
      const engineGame = new Chess(position);

      const engineMove = engineGame.move({
        from: bestMove.slice(0, 2),
        to: bestMove.slice(2, 4),
        ...(bestMove.length > 4
          ? {
              promotion: bestMove[4].toLowerCase() as
                | "q"
                | "r"
                | "b"
                | "n",
            }
          : {}),
      });

      if (!engineMove) {
        throw new Error("Stockfish returned an invalid chess move.");
      }

      setFen(engineGame.fen());
      setMoveHistory([...history, engineMove.san]);
    } catch (err) {
      if (session === gameSession.current) {
        setError(
          err instanceof Error
            ? err.message
            : "Stockfish could not make its move."
        );
      }
    } finally {
      if (session === gameSession.current) {
        setEngineThinking(false);
      }
    }
  }

  function handlePieceDrop({
    sourceSquare,
    targetSquare,
  }: {
    sourceSquare: string;
    targetSquare: string | null;
  }) {
    if (
      !targetSquare ||
      turn !== "w" ||
      engineThinking ||
      analysisLoading ||
      gameOver
    ) {
      return false;
    }

    const game = new Chess(fen);
    const beforeFen = game.fen();

    try {
      const move = game.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: "q",
      });

      if (!move) return false;

      const afterFen = game.fen();
      const updatedHistory = [...moveHistory, move.san];

      setFen(afterFen);
      setMoveHistory(updatedHistory);

      setLastMove({
        fen: beforeFen,
        playedMove: move.san,
      });

      setAnalysis(null);
      setError("");

      if (!game.isGameOver()) {
        void playStockfishMove(
          afterFen,
          updatedHistory,
          gameSession.current
        );
      }

      return true;
    } catch {
      return false;
    }
  }

  async function analyzeLastMove() {
    if (!lastMove || analysisLoading || engineThinking) return;

    setAnalysisLoading(true);
    setAnalysis(null);
    setError("");

    try {
      const response = await fetch("/api/explain-blunder", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(lastMove),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Analysis failed.");
      }

      setAnalysis(data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong during analysis."
      );
    } finally {
      setAnalysisLoading(false);
    }
  }

  function resetGame() {
    gameSession.current++;

    const game = new Chess();

    setFen(game.fen());
    setMoveHistory([]);
    setLastMove(null);
    setAnalysis(null);
    setError("");
    setEngineThinking(false);
    setAnalysisLoading(false);
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-5">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">TactiQ Chess</h2>

        <span className="rounded-full bg-green-100 px-4 py-2 text-sm font-semibold text-green-800">
          {gameOver
            ? "Game Over"
            : engineThinking
              ? "Stockfish thinking..."
              : turn === "w"
                ? "Your turn (White)"
                : "Black to move"}
        </span>
      </div>

      <div className="w-full">
        <Chessboard
          options={{
            position: fen,
            boardOrientation: "white",
            allowDragging:
              turn === "w" &&
              !engineThinking &&
              !analysisLoading &&
              !gameOver,
            showNotation: true,
            animationDurationInMs: 200,
            onPieceDrop: handlePieceDrop,
            boardStyle: {
              borderRadius: "8px",
              overflow: "hidden",
            },
          }}
        />
      </div>

      {engineThinking && (
        <p className="text-center text-sm text-green-400">
          Stockfish is calculating Black&apos;s move...
        </p>
      )}

      {turn === "b" && !engineThinking && !gameOver && (
        <button
          onClick={() =>
            void playStockfishMove(
              fen,
              moveHistory,
              gameSession.current
            )
          }
          className="rounded-lg bg-blue-600 px-5 py-3 font-semibold text-white hover:bg-blue-700"
        >
          Retry Stockfish Move
        </button>
      )}

      {gameOver && (
        <p className="rounded-lg bg-green-100 p-3 text-center font-semibold text-green-800">
          {currentGame.isCheckmate()
            ? "Checkmate!"
            : "The game has ended in a draw."}
        </p>
      )}

      <div className="rounded-xl border border-zinc-200 p-4 text-zinc-900">
        <h3 className="mb-3 font-semibold">Move History</h3>

        {moveHistory.length === 0 ? (
          <p className="text-sm text-zinc-500">
            Make your first move to begin.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {moveHistory.map((move, index) => (
              <span
                key={index}
                className="rounded bg-zinc-100 px-3 py-1 text-sm"
              >
                {index % 2 === 0
                  ? `${Math.floor(index / 2) + 1}.`
                  : ""}
                {move}
              </span>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={analyzeLastMove}
        disabled={!lastMove || analysisLoading || engineThinking}
        className="rounded-lg bg-green-600 px-5 py-3 font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {analysisLoading ? "Analyzing..." : "Analyze Last Move"}
      </button>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {analysis && (
        <div className="space-y-4 rounded-xl border border-green-200 bg-green-50 p-4 text-zinc-900">
          <h3 className="text-lg font-bold text-green-800">
            AI Chess Coach
          </h3>

          <div>
            <p className="text-sm font-semibold text-zinc-500">
              Your move
            </p>
            <p className="font-semibold">{analysis.move}</p>
          </div>

          {analysis.moveQuality && (
            <div>
              <p className="mb-2 text-sm font-semibold text-zinc-600">
                Move quality
              </p>
              <span
                className={`inline-block rounded-full px-4 py-2 text-sm font-bold ${
                  qualityStyles[analysis.moveQuality] ??
                  qualityStyles["Needs review"]
                }`}
              >
                {analysis.moveQuality}
              </span>
            </div>
          )}

          <div>
            <p className="text-sm font-semibold text-zinc-700">
              Coach explanation
              {analysis.source && (
                <span className="ml-2 text-xs font-normal text-zinc-500">
                  {analysis.source === "llm"
                    ? "(AI coach, verified against Stockfish)"
                    : "(engine summary)"}
                </span>
              )}
            </p>
            <p className="text-sm">{analysis.why_bad}</p>
          </div>

          <div>
            <p className="text-sm font-semibold text-green-700">
              Better idea
            </p>
            <p className="text-sm">{analysis.better_idea}</p>
          </div>

          {analysis.engine && (
            <div className="border-t border-green-200 pt-3">
              <h4 className="mb-2 font-semibold">
                Stockfish Analysis
              </h4>

              <p className="text-sm">
                Recommended move: {analysis.engine.bestMove}
              </p>

              <p className="text-sm">
                Best-line evaluation:{" "}
                {analysis.engine.evaluationBefore}
              </p>

              <p className="text-sm">
                Played-move evaluation:{" "}
                {analysis.engine.evaluationAfter}
              </p>

              <p className="text-xs text-zinc-500">
                Analysis depth: {analysis.engine.depthBefore} /{" "}
                {analysis.engine.depthAfter}
              </p>
            </div>
          )}
        </div>
      )}

      <button
        onClick={resetGame}
        className="rounded-lg bg-zinc-900 px-5 py-3 font-semibold text-white hover:bg-zinc-700"
      >
        New Game
      </button>
    </div>
  );
}
