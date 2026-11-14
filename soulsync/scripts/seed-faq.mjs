/**
 * Embeds data/faq.md and stores the chunks in the pgvector table faq_chunks.
 *
 *   npm run db:migrate   # creates the vector extension and tables first
 *   npm run faq:seed
 *
 * Requires DATABASE_URL (from .env.local) and a running Ollama server with
 * the embedding model. Re-running replaces this source's chunks atomically.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";
import { chunkFaqMarkdown, documentEmbeddingText } from "../src/lib/faq/chunk.ts";

dotenv.config({ path: ".env.local" });

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text";
const DIMENSIONS = 768;
const SOURCE = "data/faq.md";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set (expected in .env.local).");
  process.exit(1);
}

async function embedAll(inputs) {
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: inputs }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) throw new Error(`Embedding request failed: HTTP ${response.status}`);

  const { embeddings } = await response.json();

  if (
    !Array.isArray(embeddings) ||
    embeddings.length !== inputs.length ||
    !embeddings.every(
      (vector) => Array.isArray(vector) && vector.length === DIMENSIONS && vector.every(Number.isFinite)
    )
  ) {
    throw new Error(`Expected ${inputs.length} embeddings with ${DIMENSIONS} dimensions.`);
  }

  return embeddings;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const markdown = readFileSync(path.join(here, "..", SOURCE), "utf8");
const chunks = chunkFaqMarkdown(markdown);

if (chunks.length === 0) throw new Error("The FAQ document produced no chunks.");

console.log(`Embedding ${chunks.length} FAQ chunks with ${MODEL}...`);
const vectors = await embedAll(chunks.map(documentEmbeddingText));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  await client.query("BEGIN");
  await client.query("DELETE FROM faq_chunks WHERE source = $1", [SOURCE]);

  for (const [i, chunk] of chunks.entries()) {
    await client.query(
      `INSERT INTO faq_chunks (source, chunk_index, heading, content, embedding)
       VALUES ($1, $2, $3, $4, $5::vector)`,
      [SOURCE, chunk.chunkIndex, chunk.heading, chunk.content, JSON.stringify(vectors[i])]
    );
  }

  await client.query("COMMIT");
  console.log(`Stored ${chunks.length} chunks in faq_chunks.`);
} catch (error) {
  await client.query("ROLLBACK");
  console.error("FAQ seeding failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
