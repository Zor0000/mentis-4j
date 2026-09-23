import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  embedText,
} from "../dist/embeddings.js";

test("sends the fixed model and input type; propagates provider failures", async () => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = "test-key";
  let request;
  try {
    globalThis.fetch = async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ embedding: Array(EMBEDDING_DIMENSIONS).fill(0.1) }],
        }),
      };
    };
    const vector = await embedText("login loops", "query");
    assert.equal(vector.length, EMBEDDING_DIMENSIONS);
    assert.equal(request.url, "https://openrouter.ai/api/v1/embeddings");
    assert.equal(request.options.headers.Authorization, "Bearer test-key");
    assert.deepEqual(request.body, {
      model: EMBEDDING_MODEL,
      input: "login loops",
      input_type: "query",
    });

    globalThis.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(embedText("attempt", "document"), /503/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  }
});
