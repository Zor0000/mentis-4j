import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Database } from "../dist/db.js";
import { MemoryGraph } from "../dist/graph.js";

const canRun = Boolean(
  process.env.NEO4J_PASSWORD && process.env.OPENROUTER_API_KEY,
);
const embedding = () => Array(1024).fill(0.25);
const attempt = {
  repository: "https://example.test/repo.git",
  taskId: "cookie-session-loop",
  codeContext: "Vite, local HTTP",
  action: "Inspect cookie persistence",
  affectedFiles: ["src/Login.tsx"],
  observation: "Login returns to the sign-in page",
  check: { method: "browser test", result: "failed" },
};

test("an embedding failure never starts the attempt write", async () => {
  let writes = 0;
  const graph = new MemoryGraph({ writeTx: async () => writes++ }, async () => {
    throw new Error("provider unavailable");
  });

  await assert.rejects(graph.recordAttempt(attempt), /provider unavailable/);
  assert.equal(writes, 0);
});

test("embeds the typed attempt as a document before writing it", async () => {
  let written;
  const values = {
    id: "attempt-id",
    repository: attempt.repository,
    taskId: attempt.taskId,
    codeContext: attempt.codeContext,
    action: attempt.action,
    affectedFiles: attempt.affectedFiles,
    observation: attempt.observation,
    inference: null,
    checkMethod: attempt.check.method,
    checkResult: attempt.check.result,
    evidenceReferences: [],
    recordedAt: "2025-01-01T00:00:00.000Z",
  };
  const database = {
    writeTx: (work) =>
      work({
        run: async (_query, parameters) => {
          written = parameters;
          return { records: [{ get: (key) => values[key] }] };
        },
      }),
  };
  const graph = new MemoryGraph(database, async (text, inputType) => {
    assert.equal(inputType, "document");
    for (const field of [
      "Action:",
      "Observation:",
      "Check:",
      "Vite, local HTTP",
    ]) {
      assert.ok(text.includes(field));
    }
    return embedding();
  });

  const recorded = await graph.recordAttempt(attempt);
  assert.equal(written.embedding.length, 1024);
  assert.equal(recorded.id, "attempt-id");
  assert.equal(recorded.verification, "failed");
});

test("search expands its attempt pool to fill the distinct task limit", async () => {
  const matches = [
    ...Array.from({ length: 100 }, (_, index) => ({
      repository: attempt.repository,
      taskId: "many-attempts",
      matchedAttemptPreview: `attempt ${index}`,
      similarity: 0.99 - index / 1000,
    })),
    {
      repository: "https://example.test/another-repo.git",
      taskId: "many-attempts",
      matchedAttemptPreview: "same task ID in another repository",
      similarity: 0.85,
    },
    ...Array.from({ length: 10 }, (_, index) => ({
      repository: attempt.repository,
      taskId: `other-task-${index}`,
      matchedAttemptPreview: `other attempt ${index}`,
      similarity: 0.8 - index / 1000,
    })),
  ];
  const candidateLimits = [];
  const database = {
    read: (work) =>
      work({
        run: async (_query, parameters) => {
          candidateLimits.push(parameters.candidateLimit);
          return {
            records: matches
              .slice(0, parameters.candidateLimit)
              .map((values) => ({ get: (key) => values[key] })),
          };
        },
      }),
  };
  const graph = new MemoryGraph(database, async () => embedding());

  const candidates = await graph.search({ query: "test", limit: 10 });

  assert.deepEqual(candidateLimits, [100, 200]);
  assert.equal(candidates.length, 10);
  assert.equal(
    new Set(
      candidates.map(({ repository, taskId }) =>
        JSON.stringify([repository, taskId]),
      ),
    ).size,
    10,
  );
  assert.equal(candidates[0].taskId, "many-attempts");
  assert.ok(
    candidates.some(
      ({ repository, taskId }) =>
        repository !== attempt.repository && taskId === "many-attempts",
    ),
  );
  assert.ok(candidates.some(({ taskId }) => taskId === "other-task-0"));
});

test(
  "discovers paraphrased attempts, groups task history, and bounds recall",
  { skip: !canRun },
  async () => {
    const database = new Database();
    const graph = new MemoryGraph(database);
    const repository = `graph-test-${randomUUID()}`;
    const shared = {
      ...attempt,
      repository,
      taskId: "cookie-session-loop",
      codeContext: "Vite at abc123, local HTTP",
      affectedFiles: ["src/Login.tsx"],
    };

    try {
      await database.verifyConnectivity();
      await graph.recordAttempt({
        ...shared,
        action: "Change the login redirect",
        observation: "Authentication still cycles back to the sign-in page",
        check: { method: "browser test", result: "failed" },
      });
      await graph.recordAttempt({
        ...shared,
        action: "Retain the session cookie over local HTTP",
        observation: "The browser stays signed in after login",
        check: { method: "browser test", result: "passed" },
        evidenceReferences: ["test://browser-login"],
      });
      await graph.recordAttempt({
        ...shared,
        taskId: "separate-cookie-investigation",
        action: "Inspect whether the session cookie is retained",
        observation: "The user is sent back to sign-in after authenticating",
      });

      const candidates = await graph.search({
        query:
          "users are repeatedly returned to the login screen after signing in",
        limit: 20,
      });
      assert.ok(candidates.some(({ taskId }) => taskId === shared.taskId));
      assert.equal(
        candidates.filter(({ taskId }) => taskId === shared.taskId).length,
        1,
      );
      assert.ok(
        candidates.every(
          ({ matchedAttemptPreview, similarity }) =>
            matchedAttemptPreview.length <= 240 && Number.isFinite(similarity),
        ),
      );

      const history = await graph.recall({
        cypher: `MATCH (t:Task {identity: $taskId, repositoryIdentity: $repository})-[:HAS_ATTEMPT]->(a:Attempt)
                 RETURN t.identity AS taskId, a.action AS action, a.checkResult AS result
                 ORDER BY a.recordedAt`,
        parameters: { taskId: shared.taskId, repository },
      });
      assert.deepEqual(history.columns, ["taskId", "action", "result"]);
      assert.equal(history.rows.length, 2);
      assert.deepEqual(history.rows.map((row) => row[2]).sort(), [
        "failed",
        "passed",
      ]);

      const separateHistory = await graph.recall({
        cypher: `MATCH (t:Task {identity: $taskId, repositoryIdentity: $repository})-[:HAS_ATTEMPT]->(a:Attempt)
                 RETURN t.identity AS taskId, count(a) AS attempts`,
        parameters: { taskId: "separate-cookie-investigation", repository },
      });
      assert.deepEqual(separateHistory.rows[0], [
        "separate-cookie-investigation",
        1,
      ]);

      const bounded = await graph.recall({
        cypher: "UNWIND range(1, 110) AS value RETURN value",
      });
      assert.equal(bounded.rows.length, 100);
      assert.equal(bounded.truncated, true);
      assert.equal(bounded.truncationReason, "row_limit");
    } finally {
      await database.close();
    }
  },
);
