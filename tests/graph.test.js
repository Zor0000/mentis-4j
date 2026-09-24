import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Database } from "../dist/lib/db.js";
import { MemoryGraph } from "../dist/lib/graph.js";

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

function searchRecord(candidate) {
  const action =
    candidate.action ?? candidate.matchedAttemptPreview ?? "action";
  const observation = candidate.observation ?? "observation";
  const values = {
    repository: candidate.repository,
    taskId: candidate.taskId,
    id: candidate.id ?? `${candidate.taskId}-attempt`,
    codeContext: candidate.codeContext ?? "test context",
    action,
    affectedFiles: candidate.affectedFiles ?? ["src/test.ts"],
    observation,
    inference: candidate.inference ?? null,
    checkMethod: candidate.checkMethod ?? null,
    checkResult: candidate.checkResult ?? "unverified",
    evidenceReferences: candidate.evidenceReferences ?? [],
    recordedAt: candidate.recordedAt ?? "2025-01-01T00:00:00.000Z",
    matchedAttemptPreview:
      candidate.matchedAttemptPreview ??
      `${action} — ${observation}`.slice(0, 240),
    similarity: candidate.similarity,
  };
  return { get: (key) => values[key] };
}

function graphForSearch(rows, relevance) {
  const database = {
    read: (work) =>
      work({
        run: async () => ({ records: rows.map(searchRecord) }),
      }),
  };
  return new MemoryGraph(database, async () => embedding(), relevance);
}

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
    writeTx: (work, requestId) => {
      assert.equal(requestId, "request-1");
      return work({
        run: async (_query, parameters) => {
          written = parameters;
          return { records: [{ get: (key) => values[key] }] };
        },
      });
    },
  };
  const graph = new MemoryGraph(
    database,
    async (text, inputType, requestId) => {
      assert.equal(requestId, "request-1");
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
    },
  );

  const recorded = await graph.recordAttempt(attempt, "request-1");
  assert.equal(written.embedding.length, 1024);
  assert.equal(recorded.id, "attempt-id");
  assert.equal(recorded.verification, "failed");
});

test("search uses a bounded vector pool without stopping at the task limit", async () => {
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
              .map(searchRecord),
          };
        },
      }),
  };
  const graph = new MemoryGraph(
    database,
    async () => embedding(),
    async () => 1,
  );

  const candidates = await graph.search({ query: "test", limit: 10 });

  assert.deepEqual(candidateLimits, [200]);
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
  assert.equal(candidates[0].relevanceScore, 1);
  assert.ok(
    candidates.some(
      ({ repository, taskId }) =>
        repository !== attempt.repository && taskId === "many-attempts",
    ),
  );
  assert.ok(candidates.some(({ taskId }) => taskId === "other-task-0"));
});

test("filters and ranks distinct tasks by Jev relevance", async () => {
  const fullAction = "matched action ".repeat(30);
  const rows = [
    {
      repository: attempt.repository,
      taskId: "task-a",
      id: "a-first",
      action: fullAction,
      similarity: 0.99,
    },
    {
      repository: attempt.repository,
      taskId: "task-a",
      id: "a-duplicate",
      action: "duplicate task action",
      similarity: 0.98,
    },
    {
      repository: attempt.repository,
      taskId: "task-b",
      id: "b",
      similarity: 0.9,
    },
    {
      repository: attempt.repository,
      taskId: "task-c",
      id: "c",
      similarity: 0.8,
    },
    {
      repository: attempt.repository,
      taskId: "task-d",
      id: "d",
      similarity: 0.85,
    },
    {
      repository: attempt.repository,
      taskId: "task-e",
      id: "e",
      similarity: 0.7,
    },
  ];
  const probabilities = {
    "a-first": 0.6,
    "a-duplicate": 0.7,
    b: 0.5,
    c: 0.8,
    d: 0.8,
    e: 0.49,
  };
  const scoredAttempts = [];
  const graph = graphForSearch(rows, async (query, matchedAttempt) => {
    assert.equal(query, "search query");
    if (matchedAttempt.id === "a-first") {
      assert.equal(matchedAttempt.action, fullAction);
      assert.ok(matchedAttempt.action.length > 240);
    }
    scoredAttempts.push(matchedAttempt.id);
    return probabilities[matchedAttempt.id];
  });

  const candidates = await graph.search({ query: "search query", limit: 10 });

  assert.deepEqual(scoredAttempts, [
    "a-first",
    "a-duplicate",
    "b",
    "c",
    "d",
    "e",
  ]);
  assert.deepEqual(
    candidates.map(({ taskId, relevanceScore }) => [taskId, relevanceScore]),
    [
      ["task-d", 0.8],
      ["task-c", 0.8],
      ["task-a", 0.7],
      ["task-b", 0.5],
    ],
  );
});

test("search scores up to five attempts per task and selects its most useful match", async () => {
  const rows = [
    {
      repository: attempt.repository,
      taskId: "resolved",
      id: "failed",
      similarity: 0.99,
      matchedAttemptPreview: "failed check",
    },
    {
      repository: attempt.repository,
      taskId: "rejected",
      id: "rejected",
      similarity: 0.98,
    },
    {
      repository: attempt.repository,
      taskId: "resolved",
      id: "passed",
      similarity: 0.97,
      matchedAttemptPreview: "verified fix",
    },
    ...Array.from({ length: 5 }, (_, index) => ({
      repository: attempt.repository,
      taskId: "resolved",
      id: `later-${index}`,
      similarity: 0.96 - index / 100,
    })),
  ];
  const scores = {
    failed: 0.41,
    rejected: 0.34,
    passed: 0.74,
    "later-0": 0.54,
    "later-1": 0.2,
    "later-2": 0.2,
    "later-3": 0.9,
    "later-4": 0.9,
  };
  const scored = [];
  const graph = graphForSearch(rows, async (_query, matchedAttempt) => {
    scored.push(matchedAttempt.id);
    return scores[matchedAttempt.id];
  });

  const candidates = await graph.search({ query: "login loop", limit: 1 });

  assert.deepEqual(scored, [
    "failed",
    "passed",
    "later-0",
    "later-1",
    "later-2",
    "rejected",
  ]);
  assert.deepEqual(candidates, [
    {
      repository: attempt.repository,
      taskId: "resolved",
      matchedAttemptPreview: "verified fix",
      similarity: 0.97,
      relevanceScore: 0.74,
    },
  ]);
});

test("empty vector results do not call Jev", async () => {
  let relevanceCalls = 0;
  const graph = graphForSearch([], async () => relevanceCalls++);

  assert.deepEqual(await graph.search({ query: "no matches" }), []);
  assert.equal(relevanceCalls, 0);
});

test("Jev failures return all vector candidates with null relevance scores", async () => {
  const rows = [
    {
      repository: attempt.repository,
      taskId: "task-a",
      id: "a",
      similarity: 0.9,
    },
    {
      repository: attempt.repository,
      taskId: "task-a",
      id: "a-second",
      similarity: 0.85,
    },
    {
      repository: attempt.repository,
      taskId: "task-b",
      id: "b",
      similarity: 0.8,
    },
  ];
  const graph = graphForSearch(rows, async (_query, matchedAttempt) => {
    if (matchedAttempt.id === "b") throw new Error("invalid Jev response");
    return 0.1;
  });

  const candidates = await graph.search({ query: "search query" });

  assert.deepEqual(
    candidates.map(({ taskId, similarity, relevanceScore }) => [
      taskId,
      similarity,
      relevanceScore,
    ]),
    [
      ["task-a", 0.9, null],
      ["task-b", 0.8, null],
    ],
  );
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
          ({ matchedAttemptPreview, similarity, relevanceScore }) =>
            matchedAttemptPreview.length <= 240 &&
            Number.isFinite(similarity) &&
            (relevanceScore === null || Number.isFinite(relevanceScore)),
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
