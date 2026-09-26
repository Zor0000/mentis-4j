import assert from "node:assert/strict";
import { test } from "node:test";
import { logger } from "../dist/lib/logger.js";
import { registerTools } from "../dist/lib/tools.js";

test("logs JSON to stderr, defaults to debug and filters by level", () => {
  const previousLevel = process.env.LOG_LEVEL;
  const previousWrite = process.stderr.write;
  const lines = [];
  process.stderr.write = (text) => {
    lines.push(JSON.parse(text));
    return true;
  };
  try {
    delete process.env.LOG_LEVEL;
    logger.debug("started", "request-1");
    process.env.LOG_LEVEL = "info";
    logger.debug("hidden", "request-1");
    logger.info("done", "request-1");
    process.env.LOG_LEVEL = "error";
    logger.info("hidden");
    logger.error("failed");
    assert.deepEqual(lines, [
      { level: "debug", message: "started", request_id: "request-1" },
      { level: "info", message: "done", request_id: "request-1" },
      { level: "error", message: "failed" },
    ]);
  } finally {
    process.stderr.write = previousWrite;
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  }
});

test("tool logs share the request ID passed to the graph", async () => {
  const handlers = {};
  registerTools(
    { registerTool: (name, _schema, handler) => (handlers[name] = handler) },
    {
      search: async (_input, requestId) => {
        assert.match(requestId, /^[0-9a-f-]{36}$/);
        return [];
      },
    },
  );
  const previousWrite = process.stderr.write;
  const previousLevel = process.env.LOG_LEVEL;
  const lines = [];
  process.env.LOG_LEVEL = "debug";
  process.stderr.write = (text) => {
    lines.push(JSON.parse(text));
    return true;
  };
  try {
    await handlers.search({ repository: "repo", query: "test" });
    assert.deepEqual(
      lines.map(({ message }) => message.split(" ")[0]),
      ["search", "search"],
    );
    assert.ok(lines[0].request_id);
    assert.equal(lines[0].request_id, lines[1].request_id);
  } finally {
    process.stderr.write = previousWrite;
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  }
});
