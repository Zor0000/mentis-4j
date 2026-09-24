import process from "node:process";
import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Database } from "./db.js";
import { MemoryGraph } from "./graph.js";
import { registerTools } from "./tools.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  let database: Database | undefined;

  try {
    if (existsSync(".env")) process.loadEnvFile(".env");
    database = new Database();
    await database.verifyConnectivity();
    logger.info("Mentis connected to Neo4j");

    const server = new McpServer({ name: "mentis-4j", version: "0.1.0" });
    registerTools(server, new MemoryGraph(database));

    let closePromise: Promise<void> | undefined;
    const closeDatabase = (): Promise<void> =>
      (closePromise ??= database!.close());
    const reportCloseError = (error: unknown): void => {
      logger.error(`Failed to close Mentis database: ${errorMessage(error)}`);
    };
    server.server.onclose = () => {
      void closeDatabase().catch(reportCloseError);
    };

    const shutdown = (): void => {
      logger.info("Mentis shutting down");
      void server
        .close()
        .then(closeDatabase)
        .catch((error: unknown) => {
          logger.error(
            `Failed to shut down Mentis MCP server: ${errorMessage(error)}`,
          );
          process.exitCode = 1;
        });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    await server.connect(new StdioServerTransport());
    logger.info("Mentis MCP server ready");
  } catch (error) {
    logger.error(`Failed to start Mentis MCP server: ${errorMessage(error)}`);
    if (database) {
      await database.close().catch((closeError: unknown) => {
        logger.error(
          `Failed to close Mentis database: ${errorMessage(closeError)}`,
        );
      });
    }
    process.exitCode = 1;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main();
