# MCP tools

Tool schemas and handlers are registered in `src/lib/tools.ts`. Each handler delegates graph work to `MemoryGraph` in `src/lib/graph.ts`. Inputs use strict Zod object schemas. Unknown fields are rejected; text fields are trimmed and must be nonempty unless noted.

## `search`

Input:

- `repository`: required identity of the client's current project. Inside a Git repository, the agent supplies its remote URL (for example, `git remote get-url origin`); if there is no remote, the agent must report an error, not fall back to a path. Outside a Git repository, use the absolute working-directory path. The server cannot discover the client's checkout and rejects a missing or empty identity.
- `query`: natural-language text, maximum 4,000 characters.
- `limit`: optional integer from 1 to 20; defaults to 10.

Returns `structuredContent` with `{ status: "ok", candidates }` and a text summary. A candidate is one task, not one vector match. It includes the matched attempt ID and preview, recorded verification and Git state, outdated status, similarity, and relevance score. Jev failure results in vector-ranked candidates with a null relevance score.

## `recall`

Input:

- `cypher`: nonempty Cypher text, maximum 10,000 characters.
- `parameters`: optional object, defaults to `{}`. Keys beginning with `__mentis` are reserved.

Returns JSON in `content[0].text` with `columns`, `rows`, `truncated`, and `truncationReason`. The reason is `row_limit`, `response_size_limit`, or `null`. Results are limited to 100 rows, 512,000 serialized bytes, and a five-second transaction timeout. Oversized metadata fails the request instead of returning a result.

Database execution wraps the caller query in a subquery and applies a 101-row limit to detect a 100-row truncation. It removes one trailing semicolon before wrapping the query. Neo4j values are converted for JSON: safe integers become numbers, larger integers and bigints become strings, dates become ISO strings, non-finite numbers become null, and circular references become `"[Circular]"`.

A Neo4j read transaction and these bounds do not make arbitrary caller-authored Cypher safe for untrusted users. See [mcp.md](./mcp.md#security-boundary).

## `record_attempt`

Required input:

- `repository`, `taskId`, `codeContext`, `action`, and `observation`: nonempty strings. Use the same repository identity rule as `search` so recorded attempts can be found.
- `affectedFiles`: nonempty array of nonempty strings.

Optional input:

- `inference`: string. If provided, it must be nonempty.
- `evidenceReferences`: array of nonempty strings; it may be empty.
- `check`: strict object with nonempty `method` and `result` equal to `passed` or `failed`.
- `gitCommit`: 4–64 hexadecimal characters.
- `gitDirty`: boolean.

The graph embeds the attempt text before writing. A missing check is recorded as `unverified`. Git metadata is agent-reported and is not discovered or verified by the server. Success returns structured status `recorded` and the created attempt.

## `mark_conclusion_outdated`

Input requires nonempty `repository`, `attemptId`, and `reason`. Optional `latestCommit` must contain 4–64 hexadecimal characters. The handler marks one attempt's inference as outdated without changing the original evidence. Success returns status `marked_outdated`, the attempt ID, and correction data. A missing attempt is an error.

## `forget_attempt`

Input requires nonempty `repository` and `attemptId`. It permanently removes the matching attempt from the live graph. Success returns status `forgotten` and the attempt ID. This does not remove external copies or backups.

## Errors and request IDs

Each handler creates a UUID request ID and includes it in applicable logs and graph calls. Errors from graph operations are wrapped with a tool-specific message and returned through the MCP SDK's tool error handling. `search` and `recall` also log elapsed time and result counts.

## Source and tests

- Schemas, descriptions, output shapes, logging, and dispatch: `src/lib/tools.ts`.
- Database result bounds and JSON conversion: `src/lib/db.ts`.
- Tool contract tests: `tests/tools.test.js` and `tests/graph.test.js`.
