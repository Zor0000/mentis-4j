# Mentis-4j

Mentis is a stdio MCP server backed by a local Neo4j graph. It records
coding-agent attempts with their evidence and recalls historical attempts as
context, not instructions.

## Setup

Install dependencies and build:

```sh
npm install
npm run build
```

Set the initial password for Neo4j's default `neo4j` account:

```sh
export NEO4J_PASSWORD=change-me
```

Start Neo4j on localhost:

```sh
docker compose up -d
```

The Compose service uses Neo4j `5.26.0-community`, persists `/data` in the
`neo4j_data` volume, and exposes only localhost ports `7474` and `7687`.
`NEO4J_PASSWORD` supplies the initial password for the default `neo4j` account.
Changing it does not reset an existing volume; use `docker compose down -v`
only when intentionally destroying local data.

Start the MCP server with the same password:

```sh
npm start
```

The database module reads these environment variables:

- `NEO4J_URI` (default `bolt://127.0.0.1:7687`)
- `NEO4J_PASSWORD` (required)
- `NEO4J_DATABASE` (default `neo4j`)

The server verifies connectivity before accepting MCP requests. Startup and
shutdown diagnostics go to stderr; stdout is reserved for MCP messages.

## MCP tools

### `recall`

Inputs:

- `repository` — stable repository identity
- `symptom` and/or `affectedFiles` — the retrieval context
- `codeContext` — optional current revision, framework, or working-tree context

The response includes `attempts`, each retaining its recorded `codeContext`,
`action`, `observation`, verification state, and evidence references. It also
returns the caller's `currentContext`. A returned attempt is historical
context; it is not an instruction to repeat its action. A Vite result therefore
remains visibly marked as Vite when recalled by a Next.js caller.

### `record_attempt`

Inputs:

- `repository`, `taskId`, and `codeContext`
- `action`, `affectedFiles`, and `observation`
- optional `inference` and `evidenceReferences`
- optional `check` with a method and `passed` or `failed` result

The response is successful only after the database transaction commits and
contains the recorded attempt. If no check is supplied, verification is
`unverified`, never successful. Action, observation, and inference remain
separate fields.

Invalid input and database failures return MCP tool errors. A failed write is
never reported as recorded.

## Graph behavior and security boundary

`src/graph.ts` owns fixed, parameterized Cypher for this graph shape:

```text
(Repository)-[:HAS_TASK]->(Task)-[:HAS_ATTEMPT]->(Attempt)
```

Recording an attempt creates the repository, task, relationship, and attempt
atomically. Recall returns all matching historical attempts, including failed,
successful, and unverified attempts, in recorded order. The graph does not
expose arbitrary Cypher or infer causation.

This setup is for local, single-user development. It uses only the default
`neo4j` database account and provides no shared-user authorization boundary.
Keep secrets and full transcripts out of memory; evidence references should
point to information that can be checked separately.

## Checks

```sh
npm run typecheck
npm run lint
npm test
```

The graph and MCP integration tests are skipped when `NEO4J_PASSWORD` is not
set. When it is set, they require a reachable Neo4j instance. To run the full
checks against Compose:

```sh
export NEO4J_PASSWORD=change-me
npm run build
npm test
```
