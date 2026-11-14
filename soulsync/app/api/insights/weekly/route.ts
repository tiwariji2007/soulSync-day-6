import { connection } from "next/server";
import { chatStream, ollamaConfigFromEnv } from "@/src/lib/ai/ollama";
import {
  getSessionUser,
  insightsRateLimit,
  loadWeeklyEntries,
  logAiUsage,
} from "@/src/lib/ai/server";
import { handleWeeklyInsights } from "@/src/lib/insights/handler";

export async function GET(request: Request) {
  await connection();
  const config = ollamaConfigFromEnv();

  return handleWeeklyInsights(request, {
    getUser: getSessionUser,
    rateLimit: insightsRateLimit,
    logUsage: logAiUsage,
    model: config.chatModel,
    loadEntries: loadWeeklyEntries,
    streamChat: (messages, signal) => chatStream(config, messages, { signal }),
  });
}
