# Graph implementation

This document describes the Neo4j model and graph operations implemented in `src/lib/graph.ts`. Database sessions and query execution are implemented in `src/lib/db.ts`.

## Graph model

```text
(Repository)-[:HAS_TASK]->(Task)-[:HAS_ATTEMPT]->(Attempt)
```

`Repository.identity` stores the caller-provided repository identity. `Task.identity` stores a task ID, and `Task.repositoryIdentity` scopes that ID to a repository. Each task has `createdAt` and `updatedAt` timestamps. `Attempt` nodes store one recorded action and its evidence. Each attempt has a generated UUID and an embedding vector.

Attempt properties are:

- `codeContext`, `action`, `affectedFiles`, and `observation`.
- Optional `inference`.
- `checkMethod` and `checkResult`; `checkResult` is `passed`, `failed`, or `unverified`.
- `evidenceReferences`, an array that defaults to empty.
- `recordedAt`, an ISO timestamp.
- Optional agent-reported `gitCommit` and `gitDirty` values.
- Optional conclusion-correction fields: `outdatedReason`, `outdatedAt`, and `latestCommit`.
- `embedding`, a 1,024-number vector used by semantic search.

The implementation does not create uniqueness constraints or indexes. Search does not require a vector index; it scores embeddings within the requested repository. There is no migration or backfill command.

## Record an attempt

`MemoryGraph.recordAttempt()` validates the input, constructs embedding text, and requests a document embedding before opening a write transaction. If validation or embedding fails, it does not write to Neo4j. It also rejects embeddings that are not 1,024 finite numbers.

The transaction merges the repository and task, updates `Task.updatedAt`, creates a new attempt, and creates the `HAS_TASK` and `HAS_ATTEMPT` relationships. New tasks receive `createdAt`. Attempts are created rather than merged, so each call records a separate attempt. Missing checks are stored as `unverified`; missing inference and Git metadata are stored as null properties; missing evidence references are stored as an empty array.

Repository, task ID, code context, action, observation, affected files, check method, inference, and evidence references must be nonempty after trimming. The affected-files array must not be empty. A Git commit must be 4–64 hexadecimal characters; the server does not verify that it exists. `gitDirty` must be boolean when supplied.

## Mark a conclusion outdated

`markConclusionOutdated()` matches an attempt by repository identity and attempt ID. It sets the correction reason and timestamp without changing the original action, observation, inference, check, or Git state. A supplied `latestCommit` replaces the current correction commit. If omitted, the existing correction commit is retained. Repeated calls overwrite the correction reason and timestamp; correction history is not stored.

The query reads the older `outdatedGitCommit` property as a fallback and removes it when the attempt is updated. This supports records written by an earlier implementation.

## Forget an attempt

`forgetAttempt()` matches by repository identity and attempt ID, then uses `DETACH DELETE` on the attempt node. The attempt and its embedding are removed from the live graph. Other attempts, the task, and the repository remain. A missing attempt produces `Attempt not found in repository`.

Deletion does not retract previously returned tool responses or external backups.

## Recall

`MemoryGraph.recall()` validates the Cypher length and rejects parameter names beginning with `__mentis`. It delegates execution and output bounds to `Database.readCypher()` in `src/lib/db.ts`. Recall uses a Neo4j read transaction but does not provide a complete security boundary for arbitrary agent-authored Cypher. See [tools.md](./tools.md#recall) and [mcp.md](./mcp.md#security-boundary).

## Record mapping

Neo4j records are converted into `AttemptRecord` values. Missing optional values are omitted from the returned object. `verification` always contains the stored check result. The `check` object is included only when a check method exists. An invalid stored check result causes mapping to fail.

Correction data is returned only when both correction reason and timestamp exist. Search and graph mapping expose corrections as `outdated: null` when no correction is present.

## Source and tests

- Graph queries, input validation, attempt mapping, and semantic search: `src/lib/graph.ts`.
- Neo4j transaction and Cypher result handling: `src/lib/db.ts`.
- Graph behavior tests: `tests/graph.test.js` and `tests/db.test.js`.
