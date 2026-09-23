import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const canRun = Boolean(
  process.env.NEO4J_PASSWORD && process.env.OPENROUTER_API_KEY,
);

test(
  "stdio tools search tasks, record attempts, and run agent-authored recall",
  { skip: !canRun },
  async () => {
    const client = new Client({ name: "mcp-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/server.js"],
      env: {
        NEO4J_PASSWORD: process.env.NEO4J_PASSWORD,
        NEO4J_URI: process.env.NEO4J_URI ?? "bolt://127.0.0.1:7687",
        NEO4J_DATABASE: process.env.NEO4J_DATABASE ?? "neo4j",
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      },
    });
    const repository = `mcp-test-${randomUUID()}`;
    const shared = {
      repository,
      taskId: "login-cookie-investigation",
      codeContext: "Vite at abc123, local HTTP",
      affectedFiles: ["src/Login.tsx"],
    };

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map(({ name }) => name).sort(), [
        "recall",
        "record_attempt",
        "search",
      ]);

      for (const attempt of [
        {
          ...shared,
          action: "Change the login redirect",
          observation: "Authentication still returns to the sign-in page",
          check: { method: "browser test", result: "failed" },
        },
        {
          ...shared,
          action: "Retain the session cookie over local HTTP",
          observation: "The browser stays signed in after login",
          check: { method: "browser test", result: "passed" },
        },
        {
          ...shared,
          taskId: "new-login-investigation",
          action: "Inspect session cookie retention",
          observation: "The user is redirected to sign-in after authenticating",
        },
      ]) {
        const recorded = await client.callTool({
          name: "record_attempt",
          arguments: attempt,
        });
        assert.notEqual(recorded.isError, true);
        assert.equal(recorded.structuredContent.status, "recorded");
        assert.equal(recorded.structuredContent.recorded, true);
      }

      const searched = await client.callTool({
        name: "search",
        arguments: {
          query: "users keep landing back on the login screen after signing in",
          limit: 20,
        },
      });
      assert.notEqual(searched.isError, true);
      const candidates = searched.structuredContent.candidates;
      assert.ok(candidates.some(({ taskId }) => taskId === shared.taskId));
      assert.equal(
        candidates.filter(({ taskId }) => taskId === shared.taskId).length,
        1,
      );

      const recalled = await client.callTool({
        name: "recall",
        arguments: {
          cypher: `MATCH (t:Task {identity: $taskId, repositoryIdentity: $repository})-[:HAS_ATTEMPT]->(a:Attempt)
                   RETURN t.identity AS taskId, a.action AS action, a.checkResult AS result
                   ORDER BY a.recordedAt`,
          parameters: { taskId: shared.taskId, repository },
        },
      });
      assert.notEqual(recalled.isError, true);
      assert.equal(recalled.structuredContent, undefined);
      assert.equal(recalled.content.length, 1);
      const recalledJson = JSON.parse(recalled.content[0].text);
      assert.deepEqual(Object.keys(recalledJson).sort(), [
        "columns",
        "rows",
        "truncated",
        "truncationReason",
      ]);
      assert.deepEqual(recalledJson.columns, ["taskId", "action", "result"]);
      assert.deepEqual(recalledJson.rows.map((row) => row[2]).sort(), [
        "failed",
        "passed",
      ]);
      assert.equal(recalledJson.truncated, false);
      assert.equal(recalledJson.truncationReason, null);

      const boundedResult = await client.callTool({
        name: "recall",
        arguments: { cypher: "UNWIND range(1, 110) AS n RETURN n AS value" },
      });
      assert.notEqual(boundedResult.isError, true);
      assert.equal(boundedResult.structuredContent, undefined);
      const bounded = JSON.parse(boundedResult.content[0].text);
      assert.equal(bounded.rows.length, 100);
      assert.equal(bounded.truncated, true);
      assert.equal(bounded.truncationReason, "row_limit");

      const invalid = await client.callTool({
        name: "recall",
        arguments: { parameters: {} },
      });
      assert.equal(invalid.isError, true);
      assert.match(invalid.content[0].text, /Input validation error/);

      const invalidLimit = await client.callTool({
        name: "search",
        arguments: { query: "login issue", limit: 1000 },
      });
      assert.equal(invalidLimit.isError, true);
    } finally {
      await client.close();
    }
  },
);
