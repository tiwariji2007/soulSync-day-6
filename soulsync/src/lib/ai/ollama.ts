/**
 * Minimal Ollama client used by the AI features. Errors carry a stable code
 * and a generic message: upstream bodies, URLs and headers are never exposed.
 */

export type AiErrorCode =
  | "LLM_TIMEOUT"
  | "LLM_UNAVAILABLE"
  | "LLM_HTTP_ERROR"
  | "LLM_BAD_RESPONSE"
  | "LLM_ABORTED";

export class AiServiceError extends Error {
  constructor(
    public readonly code: AiErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AiServiceError";
  }

  get httpStatus(): number {
    return this.code === "LLM_TIMEOUT" ? 504 : 503;
  }
}

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
};

export type ChatResult = TokenUsage & { text: string };

export type StreamEvent =
  | { type: "token"; text: string }
  | ({ type: "done" } & TokenUsage);

export type OllamaConfig = {
  baseUrl: string;
  chatModel: string;
  embeddingModel: string;
  fetchImpl?: typeof fetch;
};

export function ollamaConfigFromEnv(): OllamaConfig {
  return {
    baseUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
    chatModel: process.env.OLLAMA_CHAT_MODEL ?? "qwen2.5:3b",
    embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text",
  };
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

async function post(
  config: OllamaConfig,
  path: string,
  body: unknown,
  signal: AbortSignal
): Promise<Response> {
  let response: Response;

  try {
    response = await (config.fetchImpl ?? fetch)(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw toAiError(error, signal);
  }

  if (!response.ok) {
    throw new AiServiceError(
      "LLM_HTTP_ERROR",
      `The AI service returned HTTP ${response.status}.`
    );
  }

  return response;
}

function toAiError(error: unknown, signal?: AbortSignal): AiServiceError {
  if (error instanceof AiServiceError) return error;

  const name = error instanceof Error ? error.name : "";

  if (name === "TimeoutError" || signal?.reason?.name === "TimeoutError") {
    return new AiServiceError("LLM_TIMEOUT", "The AI service timed out.");
  }

  if (name === "AbortError") {
    return new AiServiceError("LLM_ABORTED", "The AI request was cancelled.");
  }

  return new AiServiceError("LLM_UNAVAILABLE", "The AI service is unavailable.");
}

function combineSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

export async function embed(
  config: OllamaConfig,
  input: string,
  options: { dimensions: number; timeoutMs?: number }
): Promise<{ embedding: number[]; promptTokens: number }> {
  const signal = combineSignals(options.timeoutMs ?? 20_000);
  const response = await post(
    config,
    "/api/embed",
    { model: config.embeddingModel, input },
    signal
  );

  let data: { embeddings?: unknown; prompt_eval_count?: unknown };

  try {
    data = await response.json();
  } catch {
    throw new AiServiceError("LLM_BAD_RESPONSE", "Malformed embedding response.");
  }

  const embedding = Array.isArray(data.embeddings) ? data.embeddings[0] : null;

  if (
    !Array.isArray(embedding) ||
    embedding.length !== options.dimensions ||
    !embedding.every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    throw new AiServiceError("LLM_BAD_RESPONSE", "Invalid embedding returned.");
  }

  return { embedding, promptTokens: tokens(data.prompt_eval_count) };
}

export async function chat(
  config: OllamaConfig,
  messages: ChatMessage[],
  options: { timeoutMs?: number; maxTokens?: number } = {}
): Promise<ChatResult> {
  const signal = combineSignals(options.timeoutMs ?? 60_000);
  const response = await post(
    config,
    "/api/chat",
    {
      model: config.chatModel,
      stream: false,
      messages,
      options: { temperature: 0, num_predict: options.maxTokens ?? 300 },
    },
    signal
  );

  let data: Record<string, unknown>;

  try {
    data = await response.json();
  } catch {
    throw new AiServiceError("LLM_BAD_RESPONSE", "Malformed chat response.");
  }

  const message = data.message as { content?: unknown } | undefined;

  if (typeof message?.content !== "string") {
    throw new AiServiceError("LLM_BAD_RESPONSE", "The chat response had no text.");
  }

  return {
    text: message.content,
    promptTokens: tokens(data.prompt_eval_count),
    completionTokens: tokens(data.eval_count),
  };
}

/**
 * Streams a chat completion from Ollama's NDJSON stream. Yields text tokens
 * as they arrive and a final `done` event with token usage.
 */
export async function* chatStream(
  config: OllamaConfig,
  messages: ChatMessage[],
  options: { timeoutMs?: number; maxTokens?: number; signal?: AbortSignal } = {}
): AsyncGenerator<StreamEvent> {
  const signal = combineSignals(options.timeoutMs ?? 90_000, options.signal);
  const response = await post(
    config,
    "/api/chat",
    {
      model: config.chatModel,
      stream: true,
      messages,
      options: { temperature: 0.3, num_predict: options.maxTokens ?? 500 },
    },
    signal
  );

  if (!response.body) {
    throw new AiServiceError("LLM_BAD_RESPONSE", "The chat stream had no body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  const parseLine = (line: string): StreamEvent[] => {
    if (!line.trim()) return [];

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line);
    } catch {
      throw new AiServiceError("LLM_BAD_RESPONSE", "Malformed stream chunk.");
    }

    if (typeof data.error === "string") {
      throw new AiServiceError("LLM_BAD_RESPONSE", "The AI service reported an error.");
    }

    const events: StreamEvent[] = [];
    const content = (data.message as { content?: unknown } | undefined)?.content;

    if (typeof content === "string" && content.length > 0) {
      events.push({ type: "token", text: content });
    }

    if (data.done === true) {
      finished = true;
      events.push({
        type: "done",
        promptTokens: tokens(data.prompt_eval_count),
        completionTokens: tokens(data.eval_count),
      });
    }

    return events;
  };

  try {
    while (!finished) {
      let chunk: ReadableStreamReadResult<Uint8Array>;

      try {
        chunk = await reader.read();
      } catch (error) {
        throw toAiError(error, signal);
      }

      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        yield* parseLine(line);
        if (finished) return;
      }
    }

    buffer += decoder.decode();
    for (const event of parseLine(buffer)) yield event;

    if (!finished) {
      throw new AiServiceError("LLM_BAD_RESPONSE", "The chat stream ended early.");
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
