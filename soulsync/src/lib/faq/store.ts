import "server-only";
import { cosineDistance, desc, gte, sql } from "drizzle-orm";
import { db } from "@/src/db";
import { faqChunks } from "@/src/db/schema";
import type { RetrievedChunk } from "./rag";

/**
 * pgvector similarity search. `<=>` is cosine distance, so similarity is
 * 1 - distance. The HNSW index (vector_cosine_ops) serves the ORDER BY.
 */
export function buildFaqSearchQuery(
  embedding: number[],
  options: { minSimilarity: number; limit: number }
) {
  const similarity = sql<number>`1 - (${cosineDistance(faqChunks.embedding, embedding)})`;

  return db
    .select({
      id: faqChunks.id,
      heading: faqChunks.heading,
      content: faqChunks.content,
      similarity,
    })
    .from(faqChunks)
    .where(gte(similarity, options.minSimilarity))
    .orderBy(desc(similarity))
    .limit(options.limit);
}

export async function searchFaqChunks(
  embedding: number[],
  options: { minSimilarity: number; limit: number }
): Promise<RetrievedChunk[]> {
  const rows = await buildFaqSearchQuery(embedding, options);
  return rows.map((row) => ({ ...row, similarity: Number(row.similarity) }));
}
