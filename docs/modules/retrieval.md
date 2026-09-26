# Retrieval implementation

Semantic retrieval is implemented by `src/lib/embeddings.ts` and `MemoryGraph.search()` in `src/lib/graph.ts`. Search uses Neo4j vector similarity to find attempts, then OpenRouter Jev to rank their usefulness to the query.

## Embeddings

The service sends embedding requests to `https://openrouter.ai/api/v1/embeddings` using model `voyageai/voyage-4`. It requests 1,024 dimensions and passes `input_type: "document"` for recorded attempts or `input_type: "query"` for searches. Requests use the `OPENROUTER_API_KEY` bearer token.

The response must contain exactly one embedding. The vector must have 1,024 finite numeric values. HTTP failures, invalid response shapes, and invalid vectors raise errors. The caller does not retry failed requests.

Attempt embedding text is assembled in this order:

1. Repository
2. Task ID
3. Code context
4. Action
5. Affected files
6. Observation
7. Inference, or `none`
8. Check method and result, or `unverified`
9. Evidence references, or `none`

Git commit and dirty-state metadata are stored in Neo4j but are not included in the embedding text. Changing the model, dimensions, or text format requires re-embedding existing attempts. No backfill command is provided.

## Vector retrieval

Search requires the caller's repository identity. It embeds the query, matches attempts belonging to that repository in Neo4j, scores their embeddings with `vector.similarity.cosine()`, and takes the top 200 by similarity. Scoping happens before the limit: unrelated repositories cannot crowd out matches. This scans embeddings in the selected repository; it does not use the global `attempt_embedding` index.

The graph groups matches by `(repository, taskId)` and retains up to five attempts per task for relevance scoring. Task IDs are not globally unique. The candidate limit and per-task cap are configured in `CONFIG.search` in `src/config/config.ts`.

Each returned candidate includes the repository, task ID, matched attempt ID, a 240-character action-and-observation preview, the matched attempt's verification and Git metadata, correction status, similarity, and relevance score. Similarity measures vector proximity. It is not a measure of attempt success.

## Relevance scoring

Each retained attempt is sent to `https://openrouter.ai/api/alpha/decisions` using `typesafe/jev-1.13`. Jev receives the query and full mapped attempt and returns a usefulness probability from 0 through 1. Calls are made in batches of 20; calls within a batch run concurrently.

For each task, search selects the matched attempt with the highest relevance score. It removes task candidates below `0.5`, sorts by relevance descending and then similarity descending, and returns at most the requested task limit (default 10, maximum 20).

If any Jev call fails or returns an invalid response, search discards relevance scores and returns the vector-ranked tasks instead. The fallback returns one candidate per task using its highest-similarity retained attempt, sets `relevanceScore` to `null`, and applies the requested result limit. If query embedding or vector retrieval fails, search fails rather than returning fallback results.

A passed check is evidence about the recorded attempt and its recorded code state only. Search does not determine whether the current checkout is correct or whether an attempt is reusable. Inspect candidate histories with `recall` before applying them.

## Data and provider boundary

Search queries and attempt text are sent to OpenRouter. These values can contain repository identities, file paths, observations, inferences, and evidence references. Do not store credentials or sensitive data in those fields. Provider usage may incur cost.

`recall` does not use embeddings or OpenRouter. `record_attempt` requires a document embedding before it can write. Search requires an embedding; successful Jev scoring is optional after vector retrieval.

## Source and tests

- Embedding request and response validation: `src/lib/embeddings.ts`.
- Jev request and response validation: `src/lib/jev.ts`.
- Vector query, grouping, scoring, fallback, and ranking: `src/lib/graph.ts`.
- Retrieval tests: `tests/embeddings.test.js`, `tests/jev.test.js`, and `tests/graph.test.js`.
