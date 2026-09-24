import { logger } from "./logger.js";

export const EMBEDDING_MODEL = "voyageai/voyage-4";
export const EMBEDDING_DIMENSIONS = 1024;

export type EmbeddingInputType = "document" | "query";

export async function embedText(
  text: string,
  inputType: EmbeddingInputType,
  requestId?: string,
  configuredApiKey?: string,
): Promise<number[]> {
  const apiKey = (configuredApiKey ?? process.env.OPENROUTER_API_KEY)?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");

  logger.debug(`embedding request started (${inputType})`, requestId);
  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      input_type: inputType,
    }),
  });

  if (!response.ok) {
    logger.debug(`embedding request returned ${response.status}`, requestId);
    throw new Error(`OpenRouter embedding request failed (${response.status})`);
  }

  const body: unknown = await response.json();
  if (!isEmbeddingResponse(body)) {
    throw new Error("OpenRouter returned an invalid embedding response");
  }

  const embedding = body.data[0].embedding;
  if (
    embedding.length !== EMBEDDING_DIMENSIONS ||
    !embedding.every((value) => Number.isFinite(value))
  ) {
    throw new Error(
      `OpenRouter returned an embedding with invalid dimensions (expected ${EMBEDDING_DIMENSIONS})`,
    );
  }
  logger.debug("embedding request completed", requestId);
  return embedding;
}

function isEmbeddingResponse(
  value: unknown,
): value is { data: Array<{ embedding: number[] }> } {
  if (typeof value !== "object" || value === null || !("data" in value)) {
    return false;
  }
  const data = value.data;
  if (!Array.isArray(data) || data.length !== 1) return false;
  const first = data[0];
  return (
    typeof first === "object" &&
    first !== null &&
    "embedding" in first &&
    Array.isArray(first.embedding) &&
    first.embedding.every((entry: unknown) => typeof entry === "number")
  );
}
