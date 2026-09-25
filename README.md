# Mentis-4j

Mentis stores coding attempts in Neo4j and finds related tasks with embeddings. It provides a local stdio MCP server and an optional Cloudflare Worker Streamable HTTP endpoint. Agents use Cypher to inspect attempts associated with a task.

## Set up the server

1. Install dependencies and build the server:

   ```sh
   npm install
   npm run build
   ```

2. Set `NEO4J_PASSWORD` and `OPENROUTER_API_KEY` in the shell or in a `.env` file in the working directory:

   ```sh
   export NEO4J_PASSWORD=change-me
   export OPENROUTER_API_KEY=your-openrouter-key
   ```

   The server loads `.env` at startup if the file exists. Set `NEO4J_PASSWORD` in the shell or `.env` before starting Docker Compose. The file is ignored by Git.

3. Start Neo4j:

   ```sh
   docker compose up -d
   ```

   Compose runs Neo4j `5.26.0-community`, binds ports `7474` and `7687` to localhost, and stores data in the `neo4j_data` volume. The password initializes the default `neo4j` account. Changing the environment variable does not change the password in an existing volume. `docker compose down -v` deletes the volume and its data.

4. Create the vector index in Neo4j Browser at `http://127.0.0.1:7474`:

   ```cypher
   CREATE VECTOR INDEX attempt_embedding IF NOT EXISTS
   FOR (a:Attempt) ON (a.embedding)
   OPTIONS {indexConfig: {
     `vector.dimensions`: 1024,
     `vector.similarity_function`: 'cosine'
   }};
   ```

   Wait for `SHOW VECTOR INDEXES` to report `attempt_embedding` as `ONLINE`. `search` requires this index; `recall` and `record_attempt` do not. There is no automatic index migration or vector backfill.

5. Start the MCP server:

   ```sh
   npm start
   ```

   The server checks Neo4j connectivity before accepting requests. Diagnostics go to stderr; stdout is reserved for MCP messages.

### Configuration

- `NEO4J_PASSWORD`: Required. Password for the default `neo4j` account.
- `NEO4J_URI`: Defaults to `bolt://127.0.0.1:7687`.
- `NEO4J_DATABASE`: Defaults to `neo4j`.
- `NEO4J_USERNAME`: Defaults to `neo4j`.
- `OPENROUTER_API_KEY`: Required for `search` and `record_attempt`.
- `LOG_LEVEL`: `debug`, `info`, or `error`; defaults to `debug`.

## Deploy the Cloudflare Worker

The Worker exposes the same MCP tools over Streamable HTTP at `/mcp`. It has **no authentication**: anyone who can reach the endpoint can inspect and modify its memory and trigger OpenRouter usage. `recall` runs caller-authored Cypher and is not a complete read-only security boundary. Deploy only an isolated demo database with no sensitive data, and monitor provider usage; do not expose production data.

The Worker needs a Neo4j URI reachable from Cloudflare Workers, a Neo4j password, and an online vector index for `search`. Set these as Wrangler secrets (each command prompts for the value):

```sh
npx wrangler secret put NEO4J_URI
npx wrangler secret put NEO4J_PASSWORD
npx wrangler secret put OPENROUTER_API_KEY
```

`OPENROUTER_API_KEY` is required for `search` and `record_attempt`; `recall` does not use it. `NEO4J_USERNAME` and `NEO4J_DATABASE` are optional and default to `neo4j`. Then deploy:

```sh
npm run worker:build
npm run worker:deploy
```

Use the deployed Worker URL with `/mcp` as the MCP endpoint. For local Worker development, provide the same values in Wrangler's ignored `.dev.vars` file and run `npm run worker:dev`.

## MCP tools

### `search`

Provide a natural-language `query` (maximum 4,000 characters) and, optionally, a `limit` (default 10; maximum 20). The tool embeds the query, retrieves vector matches, then uses OpenRouter Jev to score their relevance and returns distinct `(repository, taskId)` candidates with a matched-attempt preview, similarity, and relevance score. If relevance scoring fails, it falls back to vector-ranked candidates with a null relevance score. Search covers the entire graph; there is no project-membership filter. Neither score indicates whether an attempt succeeded.

### `recall`

Provide a Cypher `cypher` string (maximum 10,000 characters) and optional `parameters` object. The tool returns JSON in `content[0].text` with `columns`, `rows`, `truncated`, and `truncationReason`. `truncationReason` is `row_limit`, `response_size_limit`, or `null`. Execution is limited to 100 rows, 512,000 bytes of serialized output, and five seconds. Parameter names beginning with `__mentis` are reserved.

Use task IDs from `search` to inspect a task's attempts, or provide another query. `recall` uses a Neo4j read transaction, but this is not a complete read-only security boundary. The server uses the default `neo4j` credential. Do not expose agent-authored Cypher to untrusted agents or users. Use and verify a restricted Neo4j credential before deploying beyond trusted local use.

### `record_attempt`

Provide `repository`, `taskId`, `codeContext`, `action`, `affectedFiles`, and `observation`. You can also provide `inference`, `evidenceReferences`, and `check` with a `method` and a `result` of `passed` or `failed`. Reuse a task ID only when continuing the same investigation. A check that is not provided is recorded as `unverified`.

Before writing, the server sends the attempt text to OpenRouter for a document embedding. It stores the attempt and vector in one database transaction. If embedding fails, it does not write the attempt. Action, observation, and inference are stored separately.

## Data model and embeddings

```text
(Repository)-[:HAS_TASK]->(Task)-[:HAS_ATTEMPT]->(Attempt)
```

Task IDs are scoped by repository. Each attempt has one embedding; tasks and relationships do not. Search returns at most one candidate per `(repository, taskId)`. Passing and failed attempts both remain available for inspection.

The embedding model is `voyageai/voyage-4` through OpenRouter. It produces 1,024-dimensional vectors compared with cosine similarity. Query requests use `input_type: "query"`; attempt requests use `input_type: "document"`. Search also scores vector matches for relevance with `typesafe/jev-1.13` through OpenRouter; results below 0.5 are filtered out when scoring succeeds. Attempt text contains, in order: repository, task ID, code context, action, affected files, observation, inference, check method and result, and evidence references. Changing the model, vector dimensions, or text format requires re-embedding stored attempts. Verify OpenRouter's `input_type` handling with a live API check before relying on retrieval quality. Attempts without vectors remain available through `recall` but do not appear in `search`. No backfill command is provided.

Search queries and assembled attempt text are sent to OpenRouter. They can contain repository names, paths, and observations. Do not include secrets, credentials, or sensitive incident data. Store evidence references instead of full transcripts when possible.

## Run checks

```sh
npm run typecheck
npm run lint
npm run format
npm test
```

`npm run format` checks formatting without changing files. `npm test` builds the server and runs Node.js tests. Unit tests run without credentials. Neo4j-backed graph and stdio MCP tests require `NEO4J_PASSWORD` and `OPENROUTER_API_KEY` exported in the shell, a reachable Neo4j instance, and the vector index. Values in `.env` are loaded by the server but do not enable integration tests in the test process. Skipped integration tests do not verify database or provider behavior.
