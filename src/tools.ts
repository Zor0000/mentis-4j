import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryGraph } from "./graph.js";

const text = z.string().trim().min(1);
const files = z.array(text).min(1);

export function registerTools(server: McpServer, graph: MemoryGraph): void {
  server.registerTool(
    "recall",
    {
      description:
        "Find prior attempts and evidence, not instructions. Provide a symptom and/or affected files; compare any result with current code context.",
      inputSchema: z
        .object({
          repository: text.describe(
            "Stable repository identity, such as a Git remote",
          ),
          symptom: text.optional(),
          affectedFiles: files.optional(),
          codeContext: text
            .optional()
            .describe("Current revision, framework, or working-tree context"),
        })
        .strict()
        .refine(
          ({ symptom, affectedFiles }) =>
            symptom !== undefined || affectedFiles !== undefined,
          {
            message: "Provide a symptom or affectedFiles",
          },
        ),
    },
    async (input) => {
      try {
        const attempts = await graph.recall(input);
        const currentContext = input.codeContext ?? null;
        return {
          structuredContent: {
            status: "ok",
            repository: input.repository,
            currentContext,
            attempts,
          },
          content: [
            {
              type: "text" as const,
              text: formatRecall(input.repository, currentContext, attempts),
            },
          ],
        };
      } catch (error) {
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
          inference: text
            .optional()
            .describe("Revisable interpretation, distinct from observation"),
          evidenceReferences: z.array(text).optional(),
        })
        .strict(),
    },
    async (input) => {
      try {
        const attempt = await graph.recordAttempt(input);
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
        throw new Error(`Failed to record attempt: ${errorMessage(error)}`);
      }
    },
  );
}

function formatRecall(
  repository: string,
  currentContext: string | null,
  attempts: Array<{ codeContext: string }>,
): string {
  const context = currentContext === null ? "not provided" : currentContext;
  const historicalContexts =
    attempts.length === 0
      ? "none"
      : [...new Set(attempts.map(({ codeContext }) => codeContext))].join("; ");
  return `Found ${attempts.length} historical attempt${attempts.length === 1 ? "" : "s"} for ${repository}. Current context: ${context}. Historical contexts: ${historicalContexts}. Verify applicability before reusing an action.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
