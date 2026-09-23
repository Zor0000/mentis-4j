import { randomUUID } from "node:crypto";
import type { Record as Neo4jRecord } from "neo4j-driver";
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
  repository: string;
  symptom?: string;
  affectedFiles?: string[];
  codeContext?: string;
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

const recallQuery = `
  MATCH (r:Repository {identity: $repository})-[:HAS_TASK]->(t:Task)-[:HAS_ATTEMPT]->(a:Attempt)
  WHERE ($symptom IS NULL OR any(value IN [a.action, a.observation, coalesce(a.inference, '')]
    WHERE toLower(value) CONTAINS toLower($symptom)))
    AND ($affectedFiles IS NULL OR any(file IN $affectedFiles WHERE file IN a.affectedFiles))
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
  ORDER BY a.recordedAt ASC
`;

export class MemoryGraph {
  constructor(private readonly database: Database) {}

  async recordAttempt(input: RecordAttemptInput): Promise<AttemptRecord> {
    validateRecordAttempt(input);
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
        recordedAt,
      }),
    );

    return mapAttempt(result.records[0]);
  }

  async recall(input: RecallInput): Promise<AttemptRecord[]> {
    validateRecall(input);
    const result = await this.database.read((transaction) =>
      transaction.run(recallQuery, {
        repository: input.repository,
        symptom: input.symptom ?? null,
        affectedFiles: input.affectedFiles ?? null,
      }),
    );

    return result.records.map(mapAttempt);
  }
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

function validateRecall(input: RecallInput): void {
  requireText(input.repository);
  if (input.symptom === undefined && input.affectedFiles === undefined) {
    throw new Error("Provide a symptom or affectedFiles");
  }
  if (input.symptom !== undefined) requireText(input.symptom);
  if (input.affectedFiles !== undefined) requireTextList(input.affectedFiles);
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
