import { connection } from "next/server";
import { chat, embed, ollamaConfigFromEnv } from "@/src/lib/ai/ollama";
import { faqRateLimit, getSessionUser, logAiUsage } from "@/src/lib/ai/server";
import { queryEmbeddingText } from "@/src/lib/faq/chunk";
import { handleFaq } from "@/src/lib/faq/handler";
import { searchFaqChunks } from "@/src/lib/faq/store";
import { FAQ_EMBEDDING_DIMENSIONS } from "@/src/db/schema";

export async function POST(request: Request) {
  await connection();
  const config = ollamaConfigFromEnv();

  return handleFaq(request, {
    getUser: getSessionUser,
    rateLimit: faqRateLimit,
    logUsage: logAiUsage,
    model: config.chatModel,
    embedQuestion: (question) =>
      embed(config, queryEmbeddingText(question), {
        dimensions: FAQ_EMBEDDING_DIMENSIONS,
      }),
    search: searchFaqChunks,
    chat: (messages) => chat(config, messages, { maxTokens: 200 }),
  });
}
