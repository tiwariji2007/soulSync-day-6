import type { ChatMessage, ChatResult } from "@/src/lib/ai/ollama";

export const I_DONT_KNOW = "I don't know.";

/**
 * Cosine-similarity thresholds, calibrated with nomic-embed-text on
 * data/faq.md (see scripts/calibrate-faq-thresholds.mjs and the README):
 *   - answerable questions scored 0.615-0.897 for their best chunk
 *   - off-topic questions scored at most 0.554
 * Chunks below MIN_SIMILARITY are never retrieved; when nothing passes, the
 * answer is "I don't know." without calling the chat model.
 */
export const MIN_SIMILARITY = 0.6;
export const TOP_K = 3;
/** Minimum share of answer content words that must appear in the context. */
export const MIN_GROUNDING_RATIO = 0.6;
export const MAX_QUESTION_LENGTH = 500;

export type RetrievedChunk = {
  id: string;
  heading: string;
  content: string;
  similarity: number;
};

export type FaqDeps = {
  embedQuestion: (question: string) => Promise<{ embedding: number[]; promptTokens: number }>;
  search: (embedding: number[], options: { minSimilarity: number; limit: number }) => Promise<RetrievedChunk[]>;
  chat: (messages: ChatMessage[]) => Promise<ChatResult>;
};

export type FaqStatus = "success" | "no_match" | "model_declined" | "ungrounded";

export type FaqAnswer = {
  answer: string;
  sources: { heading: string; similarity: number }[];
  status: FaqStatus;
  promptTokens: number;
  completionTokens: number;
};

export const SYSTEM_PROMPT = [
  "You are SoulSync's FAQ assistant.",
  "Answer the question using ONLY the FAQ context provided.",
  "Do not use outside knowledge and do not add details that are not in the context.",
  `If the context does not clearly answer the question, reply with exactly: ${I_DONT_KNOW}`,
  "Answer in at most three sentences.",
].join(" ");

export function buildMessages(question: string, chunks: RetrievedChunk[]): ChatMessage[] {
  const context = chunks
    .map((chunk, index) => `[FAQ ${index + 1}] ${chunk.heading}\n${chunk.content}`)
    .join("\n\n");

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `FAQ context:\n${context}\n\nQuestion: ${question}` },
  ];
}

const STOP_WORDS = new Set(
  (
    "a an and are as at be been but by can could do does for from has have how i if in " +
    "into is it its me my of on or our so that the their them then there these they this " +
    "to was we were what when where which who why will with you your yes no not also any " +
    "all just only use used using about after before each more most than very"
  ).split(" ")
);

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (word) => word.length > 2 && !STOP_WORDS.has(word)
  );
}

/** Crude stemming so "entries"/"entry" and "tracking"/"track" match. */
function stem(word: string): string {
  return word.replace(/(ies|es|s|ing|ed)$/, "");
}

/**
 * Share of the answer's content words that also occur in the retrieved
 * context. A low ratio means the model used outside knowledge.
 */
export function groundingRatio(answer: string, chunks: RetrievedChunk[]): number {
  const words = contentWords(answer);
  if (words.length === 0) return 0;

  const context = new Set(
    contentWords(chunks.map((c) => `${c.heading} ${c.content}`).join(" ")).map(stem)
  );

  return words.filter((word) => context.has(stem(word))).length / words.length;
}

export function isIDontKnow(answer: string): boolean {
  return /^\W*i don['’]?t know\b/i.test(answer.trim());
}

/**
 * Retrieval-augmented FAQ answer. Retrieves chunks above MIN_SIMILARITY,
 * answers only from them, and returns exactly "I don't know." when the FAQ
 * does not support an answer. AI service errors propagate to the caller.
 */
export async function answerFaqQuestion(question: string, deps: FaqDeps): Promise<FaqAnswer> {
  const { embedding, promptTokens: embeddingTokens } = await deps.embedQuestion(question);

  const chunks = await deps.search(embedding, {
    minSimilarity: MIN_SIMILARITY,
    limit: TOP_K,
  });

  // Defensive: never trust the store to have applied the threshold.
  const relevant = chunks
    .filter((chunk) => chunk.similarity >= MIN_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, TOP_K);

  const sources = relevant.map((chunk) => ({
    heading: chunk.heading,
    similarity: Number(chunk.similarity.toFixed(4)),
  }));

  if (relevant.length === 0) {
    return {
      answer: I_DONT_KNOW,
      sources: [],
      status: "no_match",
      promptTokens: embeddingTokens,
      completionTokens: 0,
    };
  }

  const result = await deps.chat(buildMessages(question, relevant));
  const usage = {
    promptTokens: embeddingTokens + result.promptTokens,
    completionTokens: result.completionTokens,
  };
  const answer = result.text.trim();

  if (!answer || isIDontKnow(answer)) {
    return { answer: I_DONT_KNOW, sources: [], status: "model_declined", ...usage };
  }

  if (groundingRatio(answer, relevant) < MIN_GROUNDING_RATIO) {
    return { answer: I_DONT_KNOW, sources: [], status: "ungrounded", ...usage };
  }

  return { answer, sources, status: "success", ...usage };
}
