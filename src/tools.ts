import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryGraph } from "./graph.js";

const text = z.string().trim().min(1);
const files = z.array(text).min(1);

export function registerTools(server: McpServer, graph: MemoryGraph): void {
  server.registerTool(
    "search",
    {
      description:
        "Find candidate tasks by semantic similarity. Similarity is not a success rating; inspect attempts with recall before reusing anything.",
      inputSchema: z
        .object({
          query: text.max(4000).describe("Natural-language problem or context"),
          limit: z.number().int().min(1).max(20).default(10),
        })
        .strict(),
    },
    async (input) => {
      const requestId = randomUUID();
      const started = Date.now();
      logger.debug("search started", requestId);
      try {
        const candidates = await graph.search(input, requestId);
        logger.info(
          `search completed: ${candidates.length} candidates in ${Date.now() - started}ms`,
          requestId,
        );
        return {
          structuredContent: { status: "ok", candidates },
          content: [
            {
              type: "text" as const,
              text: `Found ${candidates.length} candidate task(s). Similarity is not a success rating.\n${JSON.stringify(candidates)}`,
            },
          ],
        };
      } catch (error) {
        logger.error(
          `search failed after ${Date.now() - started}ms`,
          requestId,
        );
        throw new Error(`Failed to search memory: ${errorMessage(error)}`);
      }
    },
  );

  server.registerTool(
    "recall",
    {
      description:
        "Run agent-authored Cypher in a bounded Neo4j read transaction. Results are limited by rows, bytes, and time. This trusted-local tool is not a complete read-only security boundary; do not expose it to untrusted agents.",
      inputSchema: z
        .object({
          cypher: text
            .max(10000)
            .describe("Cypher query to run against memory"),
          parameters: z.record(z.string(), z.unknown()).default({}),
        })
        .strict(),
    },
    async (input) => {
      const requestId = randomUUID();
      const started = Date.now();
      logger.debug("recall started", requestId);
      try {
        const result = await graph.recall(input, requestId);
        logger.info(
          `recall completed: ${result.rows.length} rows in ${Date.now() - started}ms`,
          requestId,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        logger.error(
          `recall failed after ${Date.now() - started}ms`,
          requestId,
        );
        throw new Error(`Failed to recall memory: ${errorMessage(error)}`);
      }
    },
  );

  server.registerTool(
    "record_attempt",
    {
      description:
        "Record one task-scoped action and its observation. Inference is separate; omit check when none ran (unverified).",
      inputSchema: z
        .object({
          repository: text.describe(
            "Stable repository identity, such as a Git remote",
          ),
          taskId: text.describe(
            "Identity of this investigation, not a symptom shared by tasks",
          ),
          codeContext: text.describe(
            "Revision, framework, or working-tree state when the action occurred",
          ),
          action: text,
          affectedFiles: files,
          observation: text.describe(
            "What was observed, not an inferred cause",
          ),
          check: z
            .object({
              method: text.describe(
                "Command or manual check actually performed",
              ),
              result: z.enum(["passed", "failed"]),
            })
            .strict()
            .optional(),
          inference: z
            .string()
            .optional()
            .describe("Revisable interpretation, distinct from observation"),
          evidenceReferences: z.array(text).optional(),
        })
        .strict(),
    },
    async (input) => {
      const requestId = randomUUID();
      const started = Date.now();
      logger.debug("record_attempt started", requestId);
      try {
        const attempt = await graph.recordAttempt(input, requestId);
        logger.info(
          `record_attempt completed in ${Date.now() - started}ms`,
          requestId,
        );
        return {
          structuredContent: { status: "recorded", recorded: true, attempt },
          content: [
            {
              type: "text" as const,
              text: `Recorded attempt ${attempt.id}; verification: ${attempt.verification}.`,
            },
          ],
        };
      } catch (error) {
        logger.error(
          `record_attempt failed after ${Date.now() - started}ms`,
          requestId,
        );
        throw new Error(`Failed to record attempt: ${errorMessage(error)}`);
      }
    },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
