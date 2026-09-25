# Paired Lite benchmark handoff

## Goal

Finish the SWE-ContextBench Lite paired-subset experiment: run 50 experience tasks, freeze the resulting Mentis DB, pass the linked experience→target pilot in baseline and Mentis arms, then run 17 targets in both arms and grade predictions with the pinned evaluator's released `evaluation.sh`. Produce per-target outcomes and artifacts. Do not claim completion before the pilot and cohort finish.

## Current state

- Repository: `/home/capybara/code/mentis-4j`, branch `main`. Benchmark source is under `swe-context-bench-lite/`; generated datasets, credentials, and partial runs are ignored under `.data/`.
- Prepared cohort: `.data/cohort-20260924-175019-gpt-6-luna-xhigh/` (50 experiences, 17 targets; seed 20260924; Codex `gpt-6-luna` at `xhigh` effort)
  - 50 experience task IDs; 17 distinct targets.
  - 33 targets eligible under strict `experience.created_at < target.created_at` when both dates exist.
  - 14 unique linked experience IDs across 17 pairs; 36 explicit distractors.
  - All selected pair dates are present and strictly ordered. The date field is the dataset PR `created_at` timestamp, not necessarily the underlying GitHub issue creation date.
- The most recent run lost its Docker Desktop connection during experience task 5. Only 4/50 experiences completed; the remaining 46 were recorded as infrastructure failures. No DB freeze, pilot, target arms, or final report followed. All partial run directories, logs, and PID files have been discarded.
- Older prepared `gpt-5.3-codex` cohorts are retained under `.data/cohort-20260924-16????-gpt-5.3-codex-*/` (timestamps are manifest modification times in local machine time), but their partial runs have also been discarded. Do not merge these cohorts with the current model.

## Code and docs

The runner is implemented in `prepare.py`, `execute.ts`, `grade.ts`, `run.ts`, and tests under `tests/`. `HANDOFF.md` is this resume note. `.data/` contains ignored datasets, task manifests, logs, auth, and incomplete run artifacts; keep secrets and generated data out of Git.

Experience tasks have no published SWE-ContextBench target images. The runner builds them from the pinned evaluator checkout's `build_base.py` / `build_instance.py`, passing only task ID, repository, base commit, and date—no patches. Target tasks use the published hardened images. Both target arms reuse the same built image and exact base commit.

The evaluator checkout is expected at `/tmp/tmp.Bp0i1zSPpD/repo`, pinned commit `12ad6ab14e18e9378e1e293c9edbc3f7ce43d27b`. Verify it still exists and has that commit; otherwise clone/check out the pin.

## Execution status

The user explicitly switched the experiment to `gpt-6-luna` with `xhigh` reasoning effort. The manifest validator pins both; the runner passes `--model gpt-6-luna -c model_reasoning_effort="xhigh"`. A real one-turn request succeeded locally and in the agent image using the existing dedicated Codex home. TypeScript compilation, 5 Python tests, 9 Node tests, and Prettier checks passed. The previous model's HTTP 400 is no longer blocking.

The container uses a UID/GID-owned writable tmpfs at `/codex-home`, writable host `auth.json`, read-only host `config.toml`, and a writable task checkout at `/testbed`. The audit checks three exact bind mounts in Docker `.Mounts` and the UID/GID-owned tmpfs in `.HostConfig.Tmpfs`, recording both.

## Resume sequence

1. Do not restart the benchmark without a new user request. Never print or commit the dedicated auth file.
2. Verify Docker Desktop is reachable. If requested later, use `.data/cohort-20260924-175019-gpt-6-luna-xhigh/manifest.json` with a **fresh** run directory named `run-$(date +%Y%m%d-%H%M%S)` (local machine time) under that cohort after sourcing `.env` without printing the key. The runner performs all 50 experience tasks, snapshots the DB, performs the linked pilot in both arms, and only then starts the 17-target cohort. Stop if the pilot/container audit or DB immutability check fails.
3. On success, inspect the new run's `report.md` and `report.json`, official grader output, `experience-db-verification.json`, `phase-gate.json`, `target-db-audit.jsonl`, and attempt artifacts. Report unavailable token fields as null, not zero.

Do not compare this 17-target subset's resolved count as a percentage against the paper's full 99-task cohort.
