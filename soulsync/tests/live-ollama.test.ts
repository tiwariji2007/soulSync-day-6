/**
 * Opt-in live tests against a local Ollama server (RUN_LLM_TESTS=1).
 * They exercise the real embedding/chat models and the real RAG/streaming
 * code. pgvector is replaced by an in-memory cosine search with the same
 * math (similarity = 1 - cosine distance); the SQL itself is NOT exercised.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { chat, chatStream, embed, ollamaConfigFromEnv } from "@/src/lib/ai/ollama";
import {
  chunkFaqMarkdown,
  documentEmbeddingText,
  queryEmbeddingText,
} from "@/src/lib/faq/chunk";
import { answerFaqQuestion, type FaqDeps, type RetrievedChunk } from "@/src/lib/faq/rag";
import { buildInsightsMessages, computeWeeklyStats } from "@/src/lib/insights/weekly";

const config = ollamaConfigFromEnv();

function cosine(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe.runIf(process.env.RUN_LLM_TESTS === "1")("live Ollama", () => {
  let deps: FaqDeps;

  beforeAll(async () => {
    const markdown = readFileSync(path.join(__dirname, "..", "data", "faq.md"), "utf8");
    const chunks = chunkFaqMarkdown(markdown);
    const stored: (RetrievedChunk & { vector: number[] })[] = [];

    for (const chunk of chunks) {
      const { embedding } = await embed(config, documentEmbeddingText(chunk), { dimensions: 768 });
      stored.push({ id: String(chunk.chunkIndex), heading: chunk.heading, content: chunk.content, similarity: 0, vector: embedding });
    }

    deps = {
      embedQuestion: (q) => embed(config, queryEmbeddingText(q), { dimensions: 768 }),
      search: async (vector, { minSimilarity, limit }) =>
        stored
          .map(({ vector: v, ...chunk }) => ({ ...chunk, similarity: cosine(vector, v) }))
          .filter((c) => c.similarity >= minSimilarity)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, limit),
      chat: (messages) => chat(config, messages, { maxTokens: 200 }),
    };
  }, 120_000);

  it.each([
    "Can other people read my journal?",
    "What do weekly insights show?",
    "How do I create an account?",
  ])("answers the supported question %j from the FAQ", async (question) => {
    const result = await answerFaqQuestion(question, deps);
    console.info("FAQ", JSON.stringify(question), "->", result.status, JSON.stringify(result.answer), result.sources);
    expect(result.status).toBe("success");
    expect(result.answer).not.toBe("I don't know.");
    expect(result.sources.length).toBeGreaterThan(0);
  }, 120_000);

  it.each([
    "What is the capital of France?",
    "How do I bake sourdough bread?",
    "Does SoulSync have an Android app?",
    "Can I export my journal to PDF?",
  ])("returns exactly I don't know. for unsupported %j", async (question) => {
    const result = await answerFaqQuestion(question, deps);
    console.info("FAQ", JSON.stringify(question), "->", result.status, JSON.stringify(result.answer));
    expect(result.answer).toBe("I don't know.");
  }, 120_000);

  it("streams a weekly summary token by token", async () => {
    const moods = [
      { mood: "calm", note: "Long walk", createdAt: new Date() },
      { mood: "anxious", note: null, createdAt: new Date() },
    ];
    const journals = [
      { title: "Exams", content: "Worried about exams but my friend helped me study.", createdAt: new Date() },
    ];
    const messages = buildInsightsMessages(computeWeeklyStats(moods, journals), moods, journals);

    let tokens = 0;
    let text = "";
    let done: { promptTokens: number; completionTokens: number } | undefined;
    for await (const event of chatStream(config, messages, { maxTokens: 250 })) {
      if (event.type === "token") {
        tokens += 1;
        text += event.text;
      } else {
        done = event;
      }
    }

    console.info("INSIGHTS", tokens, "chunks", done, JSON.stringify(text.slice(0, 300)));
    expect(tokens).toBeGreaterThan(10);
    expect(text.length).toBeGreaterThan(50);
    expect(done?.promptTokens).toBeGreaterThan(0);
    expect(done?.completionTokens).toBeGreaterThan(0);
  }, 180_000);
});
