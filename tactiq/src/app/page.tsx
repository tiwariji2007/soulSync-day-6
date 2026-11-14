
import ChessBoard from "@/components/ChessBoard";

export default function Home() {
  return (
    <main className="min-h-screen bg-zinc-950 text-white">
      <header className="border-b border-zinc-800 px-6 py-5">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">
            Tacti<span className="text-green-400">Q</span>
          </h1>

          <span className="rounded-full border border-green-500/30 bg-green-500/10 px-4 py-2 text-sm text-green-400">
            AI Chess Coach
          </span>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-6 py-12">
        <div className="mb-10 text-center">
          <h2 className="text-3xl font-bold sm:text-4xl">
            Improve Your Chess. One Move at a Time.
          </h2>

          <p className="mt-3 text-zinc-400">
            Play chess, explore positions, and learn from your mistakes
            with TactiQ AI.
          </p>
        </div>

        <div className="mx-auto max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-900 p-4 shadow-2xl sm:p-8">
          <ChessBoard />
        </div>

        <div className="mt-10 grid gap-5 sm:grid-cols-3">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
            <h3 className="font-semibold text-green-400">
              Play Chess
            </h3>
            <p className="mt-2 text-sm text-zinc-400">
              Make moves on an interactive chessboard.
            </p>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
            <h3 className="font-semibold text-green-400">
              Engine Analysis
            </h3>
            <p className="mt-2 text-sm text-zinc-400">
              Use Stockfish to evaluate your positions.
            </p>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
            <h3 className="font-semibold text-green-400">
              AI Coaching
            </h3>
            <p className="mt-2 text-sm text-zinc-400">
              Understand your mistakes with Qwen AI.
            </p>
          </div>
        </div>
      </section>

      <footer className="border-t border-zinc-800 px-6 py-6 text-center text-sm text-zinc-500">
        TactiQ Chess Coach
      </footer>
    </main>
  );
}
