/**
 * Calibrates the FAQ similarity thresholds with the real embedding model.
 *
 * Embeds every FAQ chunk and a labelled set of questions (answerable vs.
 * unsupported) through Ollama, then prints the best cosine similarity for
 * each question. pgvector's `<=>` operator returns cosine distance
 * (1 - cosine similarity), so these numbers apply directly to the SQL search.
 *
 * Needs Ollama only (no database):  node scripts/calibrate-faq-thresholds.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chunkFaqMarkdown,
  documentEmbeddingText,
  queryEmbeddingText,
} from "../src/lib/faq/chunk.ts";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text";

const answerable = [
  "What is SoulSync?",
  "how do i sign up",
  "Can other people read my journal?",
  "What do weekly insights show?",
  "How do I track my mood?",
  "Is this app a substitute for a therapist?",
  "How much does pro cost and how do I pay?",
  "Where can I see my old journal entries?",
];

const unsupported = [
  "What is the capital of France?",
  "How do I bake sourdough bread?",
  "Who won the football world cup?",
  "Explain quantum entanglement",
  "Can I export my data to PDF?",
  "Does SoulSync have an Android app?",
  "What is the weather tomorrow?",
  "Write me a poem about cats",
];

async function embedAll(inputs) {
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: inputs }),
  });
  if (!response.ok) throw new Error(`Embedding failed: HTTP ${response.status}`);
  return (await response.json()).embeddings;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const here = path.dirname(fileURLToPath(import.meta.url));
const chunks = chunkFaqMarkdown(readFileSync(path.join(here, "..", "data", "faq.md"), "utf8"));
const chunkVectors = await embedAll(chunks.map(documentEmbeddingText));

async function report(label, questions) {
  const vectors = await embedAll(questions.map(queryEmbeddingText));
  const scores = [];
  console.log(`\n${label}`);
  questions.forEach((question, i) => {
    const ranked = chunkVectors
      .map((vector, j) => ({ heading: chunks[j].heading, score: cosine(vectors[i], vector) }))
      .sort((a, b) => b.score - a.score);
    scores.push(ranked[0].score);
    console.log(
      `  ${ranked[0].score.toFixed(3)}  ${question.padEnd(45)} -> ${ranked[0].heading}` +
        `  (2nd ${ranked[1].score.toFixed(3)})`
    );
  });
  return scores;
}

const good = await report("Answerable questions (best match):", answerable);
const bad = await report("Unsupported questions (best match):", unsupported);
console.log(
  `\nmin answerable = ${Math.min(...good).toFixed(3)}, max unsupported = ${Math.max(...bad).toFixed(3)}`
);
