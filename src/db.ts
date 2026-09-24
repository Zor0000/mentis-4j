import { logger } from "./logger.js";
import neo4j, {
  type Driver,
  type Integer,
  type ManagedTransaction,
} from "neo4j-driver";

export interface DatabaseConfig {
  uri: string;
  password: string;
  database: string;
}

export type TransactionWork<T> = (
  transaction: ManagedTransaction,
) => Promise<T>;

export interface ReadQueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  truncationReason: "row_limit" | "response_size_limit" | null;
}

const MAX_READ_ROWS = 100;
const MAX_READ_RESPONSE_BYTES = 512_000;
const READ_TIMEOUT_MS = 5_000;

export function databaseConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  const password = env.NEO4J_PASSWORD?.trim();
  if (!password) {
    throw new Error("NEO4J_PASSWORD is required");
  }

  return {
    uri: env.NEO4J_URI ?? "bolt://127.0.0.1:7687",
    password,
    database: env.NEO4J_DATABASE ?? "neo4j",
  };
}

export class Database {
  private readonly driver: Driver;
  private readonly database: string;

  constructor(config: DatabaseConfig = databaseConfigFromEnv()) {
    this.driver = neo4j.driver(
      config.uri,
      neo4j.auth.basic("neo4j", config.password),
    );
    this.database = config.database;
  }

  async verifyConnectivity(): Promise<void> {
    await this.driver.verifyConnectivity();
    logger.debug("Neo4j connectivity verified");
  }

  async read<T>(
    work: TransactionWork<T>,
    config?: { timeout: number },
    requestId?: string,
  ): Promise<T> {
    logger.debug("Neo4j read started", requestId);
    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.executeRead(work, config);
      logger.debug("Neo4j read completed", requestId);
      return result;
    } finally {
      await session.close();
    }
  }

  async readCypher(
    cypher: string,
    parameters: Record<string, unknown>,
    requestId?: string,
  ): Promise<ReadQueryResult> {
    if ("__mentisRowLimit" in parameters) {
      throw new Error("parameter name __mentisRowLimit is reserved");
    }
    const statement = `CALL {\n${cypher.replace(/;\s*$/, "")}\n}\nRETURN * LIMIT $__mentisRowLimit`;
    return this.read(
      (transaction) =>
        new Promise<ReadQueryResult>((resolve, reject) => {
          const columns: string[] = [];
          const rows: unknown[][] = [];
          let truncated = false;
          let truncationReason: ReadQueryResult["truncationReason"] = null;
          let metadataTooLarge = false;
          let bytes = 0;
          const responseHeaderBytes = () =>
            Buffer.byteLength(
              JSON.stringify({
                columns,
                rows: [],
                truncated: true,
                truncationReason: "response_size_limit",
              }),
            ) - 2;
          const result = transaction.run(statement, {
            ...parameters,
            __mentisRowLimit: neo4j.int(MAX_READ_ROWS + 1),
          });

          result.subscribe({
            onKeys: (keys) => {
              columns.push(...keys);
              bytes = responseHeaderBytes();
              metadataTooLarge = bytes + 2 > MAX_READ_RESPONSE_BYTES;
            },
            onNext: (record) => {
              if (truncated || metadataTooLarge) return;
              if (rows.length >= MAX_READ_ROWS) {
                truncated = true;
                truncationReason = "row_limit";
                return;
              }
              const row = Array.from(record.values()).map((value) =>
                toJsonValue(value),
              );
              const rowBytes =
                Buffer.byteLength(JSON.stringify(row)) +
                (rows.length > 0 ? 1 : 0);
              if (bytes + rowBytes + 2 > MAX_READ_RESPONSE_BYTES) {
                truncated = true;
                truncationReason = "response_size_limit";
                return;
              }
              bytes += rowBytes;
              rows.push(row);
            },
            onCompleted: () => {
              if (metadataTooLarge) {
                reject(
                  new Error("Recall response metadata exceeds byte limit"),
                );
              } else {
                resolve({ columns, rows, truncated, truncationReason });
              }
            },
            onError: reject,
          });
        }),
      { timeout: READ_TIMEOUT_MS },
      requestId,
    );
  }

  async writeTx<T>(work: TransactionWork<T>, requestId?: string): Promise<T> {
    logger.debug("Neo4j write started", requestId);
    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.executeWrite(work);
      logger.debug("Neo4j write completed", requestId);
      return result;
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
    logger.debug("Neo4j connection closed");
  }
}

function toJsonValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || value === undefined) return null;
  if (neo4j.isInt(value)) return integerToJson(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return objectToJson(value, seen);
  return primitiveToJson(value);
}

function primitiveToJson(value: unknown): unknown {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

function integerToJson(value: Integer): number | string {
  return value.inSafeRange() ? value.toNumber() : value.toString();
}

function objectToJson(value: object, seen: Set<object>): unknown {
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const converted = Array.isArray(value)
    ? value.map((entry) => toJsonValue(entry, seen))
    : Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          toJsonValue(entry, seen),
        ]),
      );
  seen.delete(value);
  return converted;
}
