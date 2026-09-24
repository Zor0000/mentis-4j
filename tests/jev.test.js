import assert from "node:assert/strict";
import { test } from "node:test";
import { JEV_MODEL, jevRelevance } from "../dist/lib/jev.js";

const attempt = {
  id: "attempt-id",
  repository: "https://example.test/repo.git",
  taskId: "login-investigation",
  codeContext: "Vite at abc123",
  action: "Retain the session cookie",
  affectedFiles: ["src/Login.tsx"],
  observation: "The browser stays signed in after login",
  check: { method: "browser test", result: "passed" },
  verification: "passed",
  evidenceReferences: ["test://login"],
  recordedAt: "2025-01-01T00:00:00.000Z",
};

test("sends one Jev Noul usefulness decision with the full attempt", async () => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = "test-key";
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ answers: { usefulness: { noul: 0.75 } } }),
    };
  };

  try {
    assert.equal(await jevRelevance("login loop", attempt), 0.75);
    assert.equal(request.url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers.Authorization, "Bearer test-key");
    assert.deepEqual(request.body, {
      model: JEV_MODEL,
      state: { query: "login loop", attempt },
      questions: {
        usefulness: {
          type: "noul",
          instructions:
            "Is this matched attempt useful for solving the problem described by the search query?",
          criteria: {
            true: "The attempt provides relevant evidence, context, or a reusable approach for the query.",
            false:
              "The attempt is unrelated or provides no useful information for the query.",
          },
        },
      },
    });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  }
});

test("rejects Jev provider errors and invalid probabilities", async () => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = "test-key";
  try {
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(jevRelevance("query", attempt), /503/);

    for (const probability of [NaN, Infinity, -0.01, 1.01, "0.5"]) {
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ answers: { usefulness: { noul: probability } } }),
      });
      await assert.rejects(
        jevRelevance("query", attempt),
        /invalid Jev decision response/,
      );
    }

    for (const probability of [0, 1]) {
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ answers: { usefulness: { noul: probability } } }),
      });
      assert.equal(await jevRelevance("query", attempt), probability);
    }
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  }
});
