
import { NextRequest, NextResponse } from "next/server";
import { analyzePosition } from "@/lib/stockfish";
export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json();

    if (
      !body ||
      typeof body !== "object" ||
      !("fen" in body) ||
      typeof body.fen !== "string"
    ) {
      return NextResponse.json(
        { error: "Please provide a valid FEN string." },
        { status: 400 }
      );
    }

    const analysis = await analyzePosition(body.fen, 12);

    return NextResponse.json({
      success: true,
      analysis,
    });
  } catch (error) {
    console.error("Stockfish test error:", error);

    return NextResponse.json(
      { error: "Stockfish analysis failed." },
      { status: 500 }
    );
  }
}
