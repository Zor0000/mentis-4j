import { randomUUID } from "node:crypto";
import type { Record as Neo4jRecord } from "neo4j-driver";
import {
  EMBEDDING_DIMENSIONS,
  embedText,
  type EmbeddingInputType,
} from "./embeddings.js";
import type { Database } from "./db.js";

export type CheckResult = "passed" | "failed";
export type Verification = CheckResult | "unverified";

export interface CheckInput {
  method: string;
  result: CheckResult;
}

export interface RecordAttemptInput {
  repository: string;
  taskId: string;
  codeContext: string;
  action: string;
  affectedFiles: string[];
  observation: string;
  check?: CheckInput;
  inference?: string;
  evidenceReferences?: string[];
}

export interface RecallInput {
  cypher: string;
  parameters?: Record<string, unknown>;
}

export interface SearchInput {
  query: string;
  limit?: number;
}

export interface SearchCandidate {
  repository: string;
  taskId: string;
  matchedAttemptPreview: string;
  similarity: number;
}

export interface AttemptRecord {
  id: string;
  repository: string;
  taskId: string;
  codeContext: string;
  action: string;
  affectedFiles: string[];
  observation: string;
  inference?: string;
  check?: CheckInput;
  verification: Verification;
  evidenceReferences: string[];
  recordedAt: string;
}

const recordAttemptQuery = `
  MERGE (r:Repository {identity: $repository})
  MERGE (t:Task {identity: $taskId, repositoryIdentity: $repository})
  ON CREATE SET t.createdAt = $recordedAt
  SET t.updatedAt = $recordedAt
  MERGE (r)-[:HAS_TASK]->(t)
  CREATE (a:Attempt {
    id: $attemptId,
    codeContext: $codeContext,
    action: $action,
    affectedFiles: $affectedFiles,
    observation: $observation,
    embedding: $embedding,
    recordedAt: $recordedAt
  })
  SET a.inference = $inference,
      a.checkMethod = $checkMethod,
      a.checkResult = $checkResult,
      a.evidenceReferences = $evidenceReferences
  CREATE (t)-[:HAS_ATTEMPT]->(a)
  RETURN r.identity AS repository,
         t.identity AS taskId,
         a.id AS id,
         a.codeContext AS codeContext,
         a.action AS action,
         a.affectedFiles AS affectedFiles,
         a.observation AS observation,
         a.inference AS inference,
         a.checkMethod AS checkMethod,
         a.checkResult AS checkResult,
         a.evidenceReferences AS evidenceReferences,
         a.recordedAt AS recordedAt
`;

const searchQuery = `
  CALL db.index.vector.queryNodes('attempt_embedding', $candidateLimit, $embedding)
  YIELD node, score
  MATCH (t:Task)-[:HAS_ATTEMPT]->(node)
  MATCH (r:Repository {identity: t.repositoryIdentity})-[:HAS_TASK]->(t)
  RETURN r.identity AS repository,
         t.identity AS taskId,
         substring(trim(coalesce(node.action, '') + ' — ' + coalesce(node.observation, '')), 0, 240) AS matchedAttemptPreview,
         score AS similarity
  ORDER BY similarity DESC
`;

const MAX_SEARCH_LIMIT = 20;

export class MemoryGraph {
  constructor(
    private readonly database: Database,
    private readonly embed: (
      text: string,
      inputType: EmbeddingInputType,
    ) => Promise<number[]> = embedText,
  ) {}

  async recordAttempt(input: RecordAttemptInput): Promise<AttemptRecord> {
    validateRecordAttempt(input);
    const embedding = await this.embed(attemptEmbeddingText(input), "document");
    validateEmbedding(embedding);
    const recordedAt = new Date().toISOString();
    const result = await this.database.writeTx((transaction) =>
      transaction.run(recordAttemptQuery, {
        repository: input.repository,
        taskId: input.taskId,
        attemptId: randomUUID(),
        codeContext: input.codeContext,
        action: input.action,
        affectedFiles: input.affectedFiles,
        observation: input.observation,
        inference: input.inference ?? null,
        checkMethod: input.check?.method ?? null,
        checkResult: input.check?.result ?? "unverified",
        evidenceReferences: input.evidenceReferences ?? [],
        embedding,
        recordedAt,
      }),
    );

    return mapAttempt(result.records[0]);
  }

  async search(input: SearchInput): Promise<SearchCandidate[]> {
    const limit = input.limit ?? 10;
    validateSearch(input.query, limit);
    const embedding = await this.embed(input.query, "query");
    validateEmbedding(embedding);
    return this.database.read(async (transaction) => {
      let candidateLimit = Math.min(limit * 10, 100);
      let candidates: SearchCandidate[] = [];
      let hasMoreCandidates: boolean;
      do {
        const result = await transaction.run(searchQuery, {
          embedding,
          candidateLimit,
        });
        candidates = [];
        const seen = new Set<string>();
        for (const record of result.records) {
          const candidate = {
            repository: record.get("repository") as string,
            taskId: record.get("taskId") as string,
            matchedAttemptPreview: record.get(
              "matchedAttemptPreview",
            ) as string,
            similarity: record.get("similarity") as number,
          };
          const key = JSON.stringify([candidate.repository, candidate.taskId]);
          if (!seen.has(key)) {
            seen.add(key);
            candidates.push(candidate);
            if (candidates.length === limit) return candidates;
          }
        }
        hasMoreCandidates = result.records.length === candidateLimit;
        candidateLimit *= 2;
      } while (hasMoreCandidates);
      return candidates;
    });
  }

  async recall(input: RecallInput) {
    validateRecall(input);
    return this.database.readCypher(input.cypher, input.parameters ?? {});
  }
}

function attemptEmbeddingText(input: RecordAttemptInput): string {
  return [
    `Repository: ${input.repository}`,
    `Task: ${input.taskId}`,
    `Code context: ${input.codeContext}`,
    `Action: ${input.action}`,
    `Affected files: ${input.affectedFiles.join(", ")}`,
    `Observation: ${input.observation}`,
    `Inference: ${input.inference ?? "none"}`,
    `Check: ${input.check ? `${input.check.method} (${input.check.result})` : "unverified"}`,
    `Evidence references: ${input.evidenceReferences?.join(", ") ?? "none"}`,
  ].join("\n");
}

function validateRecordAttempt(input: RecordAttemptInput): void {
  for (const value of [
    input.repository,
    input.taskId,
    input.codeContext,
    input.action,
    input.observation,
  ]) {
    requireText(value);
  }
  requireTextList(input.affectedFiles);
  if (input.check) {
    requireText(input.check.method);
    if (input.check.result !== "passed" && input.check.result !== "failed") {
      throw new Error("check.result must be passed or failed");
    }
  }
  if (input.inference !== undefined) requireText(input.inference);
  if (input.evidenceReferences !== undefined)
    requireTextList(input.evidenceReferences, true);
}

function validateSearch(query: string, limit: number): void {
  requireText(query);
  if (query.length > 4000)
    throw new Error("query must be at most 4000 characters");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_SEARCH_LIMIT}`);
  }
}

function validateRecall(input: RecallInput): void {
  requireText(input.cypher);
  if (input.cypher.length > 10000) {
    throw new Error("cypher must be at most 10000 characters");
  }
  if (input.parameters !== undefined && typeof input.parameters !== "object") {
    throw new Error("parameters must be an object");
  }
  for (const key of Object.keys(input.parameters ?? {})) {
    if (key.startsWith("__mentis")) {
      throw new Error("parameter names starting with __mentis are reserved");
    }
  }
}

function validateEmbedding(embedding: number[]): void {
  if (
    !Array.isArray(embedding) ||
    embedding.length !== EMBEDDING_DIMENSIONS ||
    !embedding.every(Number.isFinite)
  ) {
    throw new Error(
      `Embedding must contain ${EMBEDDING_DIMENSIONS} finite numbers`,
    );
  }
}

function requireText(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Expected a non-empty string");
  }
}

function requireTextList(values: string[], allowEmpty = false): void {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    throw new Error("Expected a non-empty string array");
  }
  for (const value of values) requireText(value);
}

function mapAttempt(record: Neo4jRecord): AttemptRecord {
  const checkMethod = record.get("checkMethod") as string | null;
  const checkResult = record.get("checkResult") as Verification;
  if (
    checkResult !== "passed" &&
    checkResult !== "failed" &&
    checkResult !== "unverified"
  ) {
    throw new Error("Neo4j returned an invalid check result");
  }

  return {
    id: record.get("id") as string,
    repository: record.get("repository") as string,
    taskId: record.get("taskId") as string,
    codeContext: record.get("codeContext") as string,
    action: record.get("action") as string,
    affectedFiles: record.get("affectedFiles") as string[],
    observation: record.get("observation") as string,
    ...(record.get("inference") === null
      ? {}
      : { inference: record.get("inference") as string }),
    ...(checkMethod === null
      ? {}
      : { check: { method: checkMethod, result: checkResult as CheckResult } }),
    verification: checkResult,
    evidenceReferences: record.get("evidenceReferences") as string[],
    recordedAt: record.get("recordedAt") as string,
  };
}
