# SWE-ContextBench Lite (paired subset)

This benchmark experiment compares Mentis with Mentis as it exists in the parent repository. It selects **17 Lite target tasks** and their separate experience-task IDs; it is a paired subset, not an official score for all 99 Lite targets. It does not change Mentis source or its MCP contract.

## Pins

- SWE-ContextBench code: [`jiayuanz3/SWEContextBench`](https://github.com/jiayuanz3/SWEContextBench), commit `12ad6ab14e18e9378e1e293c9edbc3f7ce43d27b`.
- Dataset: [`jiayuanz3/SWEContextBench`](https://huggingface.co/datasets/jiayuanz3/SWEContextBench), revision `12c65bd15e2559bc808065565e941ee7bbbd008f`; Lite experience and related-task Parquet files are listed in each manifest.
- Agent: Codex CLI `0.156.1`, model ID `gpt-5.3-codex`. The model ID is recorded, but provider-side model weights can change behind an ID.
- Evaluation runtime: CPython `3.11.13`. The pinned evaluator code uses Python's standard library and the Docker CLI; `requirements.txt` intentionally has no third-party packages. Docker itself is a host prerequisite.
- Agent image: Node.js `22.22.1`, CPython `3.11.13`, and `@openai/codex@0.156.1` in `Dockerfile.agent`.

## Manifest and data boundary

`prepare.py` currently validates and writes manifests; downloading and selecting the real dataset is deferred. A manifest has schema version 1 and records all pinned revisions, the 17 target IDs, experience IDs, and agent-visible task fields (`task_id`, `role`, `repository`, `base_commit`, `problem_statement`). Validation requires unique IDs, disjoint experience/target IDs, exactly 17 targets, and exact pin values.

Grader-only fields (`reference_patch`, `test_patch`, `expected_test_ids`) are rejected recursively in a manifest. `write_grader_task()` writes those fields to separate `grader-only/<task-id>.json` files; they are never serialized into the agent manifest. The run initializer copies only the validated, agent-safe manifest. When a container is added, mount the manifest and task checkout explicitly; do not mount the prepared-data directory or the whole run directory.

## Run artifacts

A run directory is initialized with `node .data/run.js <manifest.json> <run-directory>` after compiling. It contains:

```text
<run-directory>/
  manifest.json                 # agent-visible fields only
  attempts.jsonl                 # one row per Codex attempt, including failures
  codex-events/<task-id>/attempt-0001.jsonl
  patches/<task-id>/attempt-0001.patch
  predictions/<task-id>/attempt-0001.json
  grader-output/<task-id>/attempt-0001.json
```

Every selected task is recorded in `manifest.json`. `recordAttempt()` writes a JSONL row for every attempt, even when Codex fails or produces no patch; a missing patch is represented by `patch_status: "no_patch"` and null output paths. Available patches and predictions are kept per attempt. `grade.ts` only stores the evaluator's raw output bytes and refuses to overwrite them; it does not parse or normalize grader output. Phase 1 does not execute Codex or the evaluator and produces no benchmark score.

To preserve an evaluator output file byte-for-byte:

```sh
node .data/grade.js <run-directory> <task-id> <attempt-number> <raw-output-file>
```

## Phase 1 checks

Run from this directory; TypeScript and Node type definitions come from the parent repository's installed dependencies:

```sh
../node_modules/.bin/tsc -p tsconfig.json
python3 -m unittest discover -s tests -p 'test_*.py'
node --test .data/tests/*.test.js
```

The credential-free TypeScript tests create a temporary 17-target run with a fake failed attempt and patch, then verify the manifest, event log, attempt rows, patch, prediction, no-patch failure accounting, output paths, and raw grader-output preservation. Generated JavaScript is written under ignored `.data/`.
