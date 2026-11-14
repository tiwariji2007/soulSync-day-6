import type { NextRequest } from "next/server";
import { defaultDeps, handleExplainBlunder } from "@/lib/coach/handler";

export async function POST(request: NextRequest) {
  return handleExplainBlunder(request, defaultDeps);
}
