# Phase 3: paired Lite cohort

Agent: Codex CLI 0.156.1, model `gpt-6-luna`, reasoning effort `xhigh`. The model and effort are fixed in the manifest and passed to Codex for every arm. Earlier partial runs used `gpt-5.3-codex` and are not comparable results.

The cohort is built only from the pinned Lite experience, related-task, and relationship Parquet files. Dataset SHA-256 values are checked before reading. `pyarrow==22.0.0` is pinned in `prepare-requirements.txt`.

```sh
uv run --with-requirements prepare-requirements.txt -- \
  python3 prepare.py prepare \
  --output-dir .data/phase3-cohort \
  --run-id mentis-phase3-lite \
  --seed 20260924
```

Preparation writes an agent-safe `manifest.json`, host-only `selection.json`, and `grader-only/` files. It selects 17 distinct linked targets, verifies available `created_at` dates are strictly earlier for each linked experience, then selects 50 experience tasks. The selected experience IDs are partitioned into linked memories and explicit distractors. If fewer than 17 eligible targets exist, preparation exits with the available count.

The evaluator checkout must be the pinned SWE-ContextBench commit. The runner verifies its commit and runs the released `evaluation.sh <fresh-run-id> lite` for both smoke predictions and each cohort arm. No local grader is implemented. Related targets use their published hardened images; experience tasks use the pinned checkout's `build_instance.py` at each `base_commit`, with only task ID, repository, commit, and creation date supplied (no reference or test patches).

Prepare a dedicated Codex home and export the OpenRouter key, then run from the repository root:

```sh
mkdir -p "$BENCHMARK_CODEX_HOME"
CODEX_HOME="$BENCHMARK_CODEX_HOME" codex login
export OPENROUTER_API_KEY=...
node swe-context-bench-lite/.data/execute.js \
  swe-context-bench-lite/.data/phase3-cohort/manifest.json \
  swe-context-bench-lite/.data/phase3-cohort/run \
  "$BENCHMARK_CODEX_HOME" \
  /path/to/SWEContextBench
```

The runner grades one known and one empty prediction first. Only if those pass does it run all 50 experience tasks, snapshot the resulting DB, complete a separate linked target pair in both arms, and audit the frozen DB and actual container mounts before continuing to the 17-target cohort. Target arms expose only `search` and `recall`; their DB snapshot is checked after every attempt. The final report is `run/report.md` and `run/report.json`. Raw Codex events, patches, predictions, official evaluator JSON, stdout/stderr, per-target DB audits, and the graph snapshot remain under the run directory.

`resolved/17` describes only this paired subset and must not be compared as a percentage with the paper's full 99-task result. Missing token usage is recorded as `null`, not zero.
