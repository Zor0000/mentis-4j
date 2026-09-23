import neo4j, { type Driver, type ManagedTransaction } from "neo4j-driver";

export interface DatabaseConfig {
  uri: string;
  password: string;
  database: string;
}

export type TransactionWork<T> = (
  transaction: ManagedTransaction,
) => Promise<T>;

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
  }

  async read<T>(work: TransactionWork<T>): Promise<T> {
    const session = this.driver.session({ database: this.database });
    try {
      return await session.executeRead(work);
    } finally {
      await session.close();
    }
  }

  async writeTx<T>(work: TransactionWork<T>): Promise<T> {
    const session = this.driver.session({ database: this.database });
    try {
      return await session.executeWrite(work);
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
