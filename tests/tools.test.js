import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const canRun = Boolean(process.env.NEO4J_PASSWORD);

test(
  "stdio tools record and recall qualified attempts",
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
      },
    });
    const repository = `mcp-test-${randomUUID()}`;

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map(({ name }) => name).sort(), [
        "recall",
        "record_attempt",
      ]);

      const recorded = await client.callTool({
        name: "record_attempt",
        arguments: {
          repository,
          taskId: "api-url",
          codeContext: "Vite at abc123",
          action: "use VITE_API_URL",
          affectedFiles: ["src/config.ts"],
          observation: "The client reads the configured API URL",
          check: { method: "npm test", result: "passed" },
        },
      });
      assert.notEqual(recorded.isError, true);
      assert.equal(recorded.structuredContent.status, "recorded");
      assert.equal(recorded.structuredContent.recorded, true);
      assert.equal(recorded.structuredContent.attempt.verification, "passed");

      const recalled = await client.callTool({
        name: "recall",
        arguments: {
          repository,
          symptom: "API URL",
          codeContext: "Next.js at def456",
        },
      });
      assert.notEqual(recalled.isError, true);
      assert.equal(
        recalled.structuredContent.currentContext,
        "Next.js at def456",
      );
      assert.equal(
        recalled.structuredContent.attempts[0].codeContext,
        "Vite at abc123",
      );
      assert.match(recalled.content[0].text, /Vite at abc123/);
      assert.match(recalled.content[0].text, /Next\.js at def456/);

      const invalid = await client.callTool({
        name: "recall",
        arguments: { repository },
      });
      assert.equal(invalid.isError, true);
      assert.match(invalid.content[0].text, /Input validation error/);
    } finally {
      await client.close();
    }
  },
);
