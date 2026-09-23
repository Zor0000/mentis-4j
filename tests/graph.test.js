import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Database } from "../dist/db.js";
import { MemoryGraph } from "../dist/graph.js";

const canRun = Boolean(process.env.NEO4J_PASSWORD);

test(
  "records and recalls checked and unverified attempts",
  { skip: !canRun },
  async () => {
    const database = new Database();
    const graph = new MemoryGraph(database);
    const repository = `graph-test-${randomUUID()}`;
    const base = {
      repository,
      taskId: "login-loop",
      codeContext: "Vite at abc123, local HTTP",
      affectedFiles: ["src/Login.tsx"],
    };

    try {
      await database.verifyConnectivity();
      await graph.recordAttempt({
        ...base,
        action: "edit redirect",
        observation: "login still loops",
        check: { method: "browser test", result: "failed" },
      });
      await graph.recordAttempt({
        ...base,
        action: "change local cookie setting",
        observation: "login works over local HTTP",
        check: { method: "browser test", result: "passed" },
        evidenceReferences: ["test://browser-login"],
      });
      await graph.recordAttempt({
        ...base,
        action: "inspect cookie configuration",
        observation: "inspection recorded before a check ran",
      });

      const attempts = await graph.recall({
        repository,
        affectedFiles: base.affectedFiles,
      });
      assert.equal(attempts.length, 3);
      assert.deepEqual(
        attempts.map(({ observation }) => observation),
        [
          "login still loops",
          "login works over local HTTP",
          "inspection recorded before a check ran",
        ],
      );
      assert.deepEqual(
        attempts.map(({ verification }) => verification),
        ["failed", "passed", "unverified"],
      );
      assert.equal(attempts[1].evidenceReferences[0], "test://browser-login");
      assert.equal(attempts[2].check, undefined);
    } finally {
      await database.close();
    }
  },
);
