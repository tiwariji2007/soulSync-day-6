
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const nodeRequire = createRequire(`${process.cwd()}/package.json`);

const stockfishPackage = nodeRequire("stockfish") as {
  findEngine: (engineType: string) => string;
};

export type StockfishAnalysis = {
  bestMove: string;
  ponder?: string;
  depth?: number;
  score?: {
    type: "cp" | "mate";
    value: number;
  };
  principalVariation?: string[];
};

const UCI_MOVE_REGEX =
  /^[a-h][1-8][a-h][1-8][qrbn]?$/;

export async function analyzePosition(
  fen: string,
  depth = 12,
  searchMoves?: string[]
): Promise<StockfishAnalysis> {
  if (
    typeof fen !== "string" ||
    fen.trim().length === 0 ||
    fen.length > 200
  ) {
    throw new Error("Invalid FEN position.");
  }

  if (!Number.isInteger(depth) || depth < 1 || depth > 30) {
    throw new Error("Depth must be between 1 and 30.");
  }

  if (
    searchMoves &&
    (
      searchMoves.length === 0 ||
      searchMoves.some((move) => !UCI_MOVE_REGEX.test(move))
    )
  ) {
    throw new Error("Invalid Stockfish search move.");
  }

  const enginePath =
    stockfishPackage.findEngine("lite-single");

  const child = spawn(process.execPath, [enginePath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const readline = createInterface({
    input: child.stdout,
  });

  let latestInfo = "";
  let stderr = "";

  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  function send(command: string) {
    if (!child.stdin.writable) {
      throw new Error(
        "Stockfish input stream is not available."
      );
    }

    child.stdin.write(`${command}\n`);
  }

  function waitForLine(
    expected: (line: string) => boolean,
    timeoutMs = 15000
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error("Stockfish response timed out.")
        );
      }, timeoutMs);

      const onLine = (line: string) => {
        if (expected(line)) {
          cleanup();
          resolve(line);
        }
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const onClose = () => {
        cleanup();
        reject(
          new Error(
            `Stockfish process closed unexpectedly. ${stderr}`
          )
        );
      };

      function cleanup() {
        clearTimeout(timer);
        readline.off("line", onLine);
        child.off("error", onError);
        child.off("close", onClose);
      }

      readline.on("line", onLine);
      child.on("error", onError);
      child.on("close", onClose);
    });
  }

  try {
    const uciReady = waitForLine(
      (line) => line === "uciok"
    );

    send("uci");
    await uciReady;

    const engineReady = waitForLine(
      (line) => line === "readyok"
    );

    send("isready");
    await engineReady;

    const analysis = new Promise<StockfishAnalysis>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error("Stockfish analysis timed out.")
          );
        }, 60000);

        const onLine = (line: string) => {
          if (
            line.startsWith("info ") &&
            line.includes("score")
          ) {
            const currentDepth = Number(
              line.match(/\bdepth\s+(\d+)/)?.[1] ?? 0
            );

            const previousDepth = Number(
              latestInfo.match(/\bdepth\s+(\d+)/)?.[1] ?? 0
            );

            if (currentDepth >= previousDepth) {
              latestInfo = line;
            }
          }

          if (line.startsWith("bestmove ")) {
            clearTimeout(timer);
            readline.off("line", onLine);

            const bestMove = line.match(
              /^bestmove\s+(\S+)/
            )?.[1];

            const ponder = line.match(
              /\bponder\s+(\S+)/
            )?.[1];

            if (!bestMove || bestMove === "(none)") {
              reject(
                new Error(
                  "Stockfish did not find a best move."
                )
              );
              return;
            }

            const depthMatch = latestInfo.match(
              /\bdepth\s+(\d+)/
            );

            const scoreMatch = latestInfo.match(
              /\bscore\s+(cp|mate)\s+(-?\d+)/
            );

            const pvMatch = latestInfo.match(
              /\bpv\s+(.+)$/
            );

            resolve({
              bestMove,
              ...(ponder ? { ponder } : {}),
              ...(depthMatch
                ? {
                    depth: Number(depthMatch[1]),
                  }
                : {}),
              ...(scoreMatch
                ? {
                    score: {
                      type: scoreMatch[1] as
                        | "cp"
                        | "mate",
                      value: Number(scoreMatch[2]),
                    },
                  }
                : {}),
              ...(pvMatch
                ? {
                    principalVariation:
                      pvMatch[1].trim().split(/\s+/),
                  }
                : {}),
            });
          }
        };

        readline.on("line", onLine);
      }
    );

    send(`position fen ${fen}`);

    const searchCommand = searchMoves?.length
      ? `go depth ${depth} searchmoves ${searchMoves.join(" ")}`
      : `go depth ${depth}`;

    send(searchCommand);

    return await analysis;
  } finally {
    readline.close();

    if (!child.killed) {
      child.kill();
    }
  }
}
