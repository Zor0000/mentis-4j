# Mentis-4j

Mentis is a stdio MCP server backed by Neo4j. It records task-scoped coding
attempts and uses embeddings to discover candidate tasks. Agents inspect the
history they need with their own Cypher; Mentis does not turn a similarity
match into a recommended fix.

## Setup

Install dependencies:

```sh
npm install
npm run build
```

Configure Neo4j and OpenRouter:

```sh
export NEO4J_PASSWORD=change-me
export OPENROUTER_API_KEY=your-openrouter-key
```

Start Neo4j:

```sh
docker compose up -d
```

Compose uses Neo4j `5.26.0-community`, persists `/data` in `neo4j_data`, and
binds ports `7474` and `7687` to localhost. `NEO4J_PASSWORD` supplies the
initial password for the default `neo4j` account. Changing it does not reset
an existing volume; use `docker compose down -v` only when intentionally
destroying local data.

Create the vector index once in Neo4j Browser at `http://127.0.0.1:7474`:

```cypher
CREATE VECTOR INDEX attempt_embedding IF NOT EXISTS
FOR (a:Attempt) ON (a.embedding)
OPTIONS {indexConfig: {
  `vector.dimensions`: 1024,
  `vector.similarity_function`: 'cosine'
}};
```

Wait for `SHOW VECTOR INDEXES` to report `attempt_embedding` as `ONLINE`.
The index is required for `search`; writes and `recall` do not require it.
There is no schema migration or automatic vector backfill command.

Start the MCP server with the same environment:

```sh
npm start
```

Database settings:

- `NEO4J_URI` — defaults to `bolt://127.0.0.1:7687`
- `NEO4J_PASSWORD` — required
- `NEO4J_DATABASE` — defaults to `neo4j`
- `OPENROUTER_API_KEY` — required for `search` and `record_attempt`

The server verifies Neo4j connectivity before accepting MCP requests. Startup
and shutdown diagnostics go to stderr; stdout is reserved for MCP messages.

## MCP tools

### `search`

Inputs: a natural-language `query` and optional `limit` (default 10, maximum
20). Mentis embeds the query, searches attempt vectors, and returns up to that
many distinct `(repository, taskId)` candidates with a matched-attempt preview
and similarity score. Search is graph-wide: the current schema has no project
membership. A similarity score is not evidence that an attempt worked.

### `recall`

Inputs: agent-authored `cypher` and optional `parameters`. The tool returns a
single JSON object in `content[0].text` with `columns`, JSON-compatible `rows`,
`truncated`, and `truncationReason` (`null` when not truncated). Execution is
limited to 100 rows, 512,000 bytes for the serialized JSON object, and five
seconds; truncation is reported. Query text is limited to 10,000 characters.
Parameter names beginning with `__mentis` are reserved. Use task IDs from
search to select a task and its attempts, or author another traversal. Mentis
does not substitute a symptom into a fixed query.

Recall runs through a Neo4j read transaction, but this is **not a complete
read-only security boundary**. The server still uses the default `neo4j`
credential. Do not expose this tool to untrusted agents or users. Configure and
verify an appropriately restricted Neo4j credential before treating
agent-authored Cypher as safely read-only or deploying beyond trusted local use.

### `record_attempt`

Inputs remain `repository`, agent-supplied `taskId`, `codeContext`, `action`,
`affectedFiles`, `observation`, optional `inference`, `evidenceReferences`, and
optional `check` (`method` and `passed`/`failed` result). Reuse a known task ID
only when continuing that investigation; a new investigation gets a new ID.
Reading first is useful workflow, not a prerequisite for recording.

Before the database transaction, Mentis sends one text assembled from the
existing attempt fields to OpenRouter and requests a document embedding. The
recorded fields and vector are written atomically. A provider failure means no
attempt is written or reported as recorded. Without a check, verification is
`unverified`. Action, observation, and inference remain separate.

## Embeddings and data handling

The fixed starting model is `voyageai/voyage-4` through OpenRouter, with
1,024-dimensional cosine vectors. Query text uses `input_type: "query"` and
attempt text uses `input_type: "document"`. The model, dimension, and text
construction must remain fixed for an index; changing any of them requires
re-embedding stored attempts. Verify OpenRouter's `input_type` routing with a
live API smoke test before relying on it. This is a reasoned starting choice,
not a demonstrated winner on Mentis data; the stated OpenRouter price is
$0.06 per million input tokens.

Attempt text is assembled in this fixed order: repository, task ID, code
context, action, affected files, observation, inference (or `none`), check
method and result (or `unverified`), and evidence references (or `none`).
Existing attempts have no vectors and will not appear in `search` until they
are backfilled using this exact model and text construction. No backfill tool
is currently implemented; old attempts remain available through `recall`.

Each `search` query and each new attempt's assembled text is sent to OpenRouter
for embedding. Those fields can disclose repository identities, paths, context,
and observations to an external provider. Do not include secrets, credentials,
or sensitive incident data. Mentis embeds attempt records, not repository
source-code chunks. `voyage-code-4` is not used; `voyage-4-lite` is an
unmeasured lower-cost comparison if later retrieval or cost tests justify it.

## Graph behavior

The stored shape remains:

```text
(Repository)-[:HAS_TASK]->(Task)-[:HAS_ATTEMPT]->(Attempt)
```

Each attempt has one vector. Tasks and relationships are not embedded. Search
matches attempts and returns at most one candidate per `(repository, taskId)`;
failed and passing attempts remain in the history and are not ranked as correct
or incorrect. Task identity is supplied by the agent and is scoped by
repository.

This is a local, single-user starting point. Keep secrets and full transcripts
out of memory; evidence references should point to information that can be
checked separately.

## Checks

```sh
npm run typecheck
npm run lint
npm test
```

Provider and database unit tests run without credentials. Neo4j-backed graph
and stdio MCP tests require `NEO4J_PASSWORD`, `OPENROUTER_API_KEY`, a reachable
Neo4j instance, and the vector index above. Skipped integration tests are not
provider or database verification.
