export type FaqChunk = {
  chunkIndex: number;
  heading: string;
  content: string;
};

export const MAX_CHUNK_CHARS = 1_200;

/**
 * Splits a markdown FAQ into one chunk per "## " section. Each chunk keeps its
 * heading so the retrieved text is self-contained. Sections longer than
 * MAX_CHUNK_CHARS are split on paragraph boundaries.
 */
export function chunkFaqMarkdown(markdown: string): FaqChunk[] {
  const chunks: FaqChunk[] = [];
  const sections = markdown.replace(/\r\n/g, "\n").split(/^## +/m).slice(1);

  for (const section of sections) {
    const newline = section.indexOf("\n");
    const heading = (newline === -1 ? section : section.slice(0, newline)).trim();
    const body = (newline === -1 ? "" : section.slice(newline + 1)).trim();

    if (!heading || !body) continue;

    const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    let current = "";

    const flush = () => {
      if (current) {
        chunks.push({ chunkIndex: chunks.length, heading, content: current });
        current = "";
      }
    };

    for (const paragraph of paragraphs) {
      if (current && current.length + paragraph.length + 2 > MAX_CHUNK_CHARS) {
        flush();
      }
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }

    flush();
  }

  return chunks;
}

/** Text that is embedded for a chunk (nomic-embed-text document prefix). */
export function documentEmbeddingText(chunk: Pick<FaqChunk, "heading" | "content">): string {
  return `search_document: ${chunk.heading}\n${chunk.content}`;
}

/** Text that is embedded for a user question (nomic-embed-text query prefix). */
export function queryEmbeddingText(question: string): string {
  return `search_query: ${question}`;
}
