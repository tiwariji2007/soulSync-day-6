export type LlmErrorCode =
  | "LLM_TIMEOUT"
  | "LLM_UNAVAILABLE"
  | "LLM_HTTP_ERROR"
  | "LLM_BAD_RESPONSE";

/** Error with a stable code. The message never contains secrets or upstream bodies. */
export class LlmError extends Error {
  constructor(
    public readonly code: LlmErrorCode,
    message: string
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export type LlmCompletion = {
  text: string;
  promptTokens: number;
  completionTokens: number;
};

export type GenerateJson = (prompt: string) => Promise<LlmCompletion>;

export type OllamaOptions = {
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
};

function toTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/** Creates a JSON-mode completion function backed by Ollama's /api/generate. */
export function createOllamaJsonGenerator(options: OllamaOptions): GenerateJson {
  const baseUrl = options.baseUrl ?? "http://localhost:11434";
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (prompt) => {
    let response: Response;

    try {
      response = await fetchImpl(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: options.model,
          prompt,
          stream: false,
          format: "json",
          options: {
            temperature: 0,
            num_predict: options.maxTokens ?? 300,
          },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new LlmError("LLM_TIMEOUT", "The language model timed out.");
      }

      throw new LlmError(
        "LLM_UNAVAILABLE",
        "The language model service is unavailable."
      );
    }

    if (!response.ok) {
      throw new LlmError(
        "LLM_HTTP_ERROR",
        `The language model returned HTTP ${response.status}.`
      );
    }

    let data: Record<string, unknown>;

    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new LlmError(
        "LLM_BAD_RESPONSE",
        "The language model returned a malformed response."
      );
    }

    if (typeof data.response !== "string") {
      throw new LlmError(
        "LLM_BAD_RESPONSE",
        "The language model response had no text."
      );
    }

    return {
      text: data.response,
      promptTokens: toTokenCount(data.prompt_eval_count),
      completionTokens: toTokenCount(data.eval_count),
    };
  };
}
