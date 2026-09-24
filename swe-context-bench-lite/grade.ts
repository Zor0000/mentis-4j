import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import { outputPaths } from "./run.js";
import type { Manifest } from "./run.js";

const EVALUATOR_COMMIT = "12ad6ab14e18e9378e1e293c9edbc3f7ce43d27b";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OFFICIAL_TIMEOUT_MS = 6 * 60 * 60 * 1000;

type Arm = "baseline" | "mentis";
type Prediction = { taskId: string; patch: string };

export async function preserveGraderOutput(
  runDir: string,
  taskId: string,
  attempt: number,
  output: Uint8Array,
): Promise<string> {
  const path = outputPaths(runDir, taskId, attempt).graderOutput;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, output, { flag: "wx" });
  return path;
}

function safeId(value: string): string {
  if (!ID_PATTERN.test(value)) throw new Error(`unsafe task ID: ${value}`);
  return value;
}

function writeNew(path: string, data: string | Uint8Array): Promise<void> {
  return writeFile(path, data, { flag: "wx" });
}

function evaluatorCommit(evaluatorDir: string): string {
  const commit = execFileSync(
    "git",
    ["-C", evaluatorDir, "rev-parse", "HEAD"],
    {
      encoding: "utf8",
    },
  ).trim();
  if (commit !== EVALUATOR_COMMIT) {
    throw new Error(`evaluator commit ${commit} != pinned ${EVALUATOR_COMMIT}`);
  }
  return commit;
}

async function loadCohort(runDir: string): Promise<{
  manifest: Manifest;
  selection: {
    available_linked_target_count: number;
    date_field: string;
    linked_experience_task_ids: string[];
    distractor_experience_task_ids: string[];
    linked_pairs: Array<{
      target_task_id: string;
      experience_task_id: string;
      target_created_at: string | null;
      experience_created_at: string | null;
      date_check: string;
    }>;
  };
  preparedDir: string;
}> {
  const root = resolve(runDir);
  const manifest = JSON.parse(
    await readFile(join(root, "manifest.json"), "utf8"),
  ) as Manifest;
  const preparedDir = dirname(root);
  const selection = JSON.parse(
    await readFile(join(preparedDir, "selection.json"), "utf8"),
  ) as {
    available_linked_target_count: number;
    date_field: string;
    linked_experience_task_ids: string[];
    distractor_experience_task_ids: string[];
    linked_pairs: Array<{
      target_task_id: string;
      experience_task_id: string;
      target_created_at: string | null;
      experience_created_at: string | null;
      date_check: string;
    }>;
  };
  return { manifest, selection, preparedDir };
}

function officialPrediction(
  taskId: string,
  model: string,
  patch: string,
): string {
  safeId(taskId);
  return `${JSON.stringify(
    {
      [taskId]: {
        model_name_or_path: model,
        instance_id: taskId,
        model_patch: patch,
      },
    },
    null,
    2,
  )}\n`;
}

async function runOfficialEvaluation(
  evaluatorDir: string,
  runDir: string,
  manifest: Manifest,
  label: string,
  predictions: Prediction[],
): Promise<{ runId: string; report: Record<string, unknown> }> {
  if (predictions.length === 0)
    throw new Error("at least one prediction is required");
  const commit = evaluatorCommit(evaluatorDir);
  const runId = `mentis-${manifest.run_id}-${label}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const safeRunId = safeId(runId);
  const predictionDir = join(
    resolve(runDir),
    "official-predictions",
    safeRunId,
  );
  const artifactDir = join(resolve(runDir), "grader-output", safeRunId);
  await mkdir(predictionDir, { recursive: true });
  await mkdir(artifactDir, { recursive: true });

  for (const prediction of predictions) {
    safeId(prediction.taskId);
    const casePath = join(
      evaluatorDir,
      "cases",
      "SWEContextBench Lite",
      `${prediction.taskId}.json`,
    );
    const caseData = JSON.parse(await readFile(casePath, "utf8")) as {
      instance_id: string;
      base_commit: string;
    };
    const selected = manifest.tasks.find(
      (task) => task.task_id === prediction.taskId,
    );
    if (
      !selected ||
      caseData.instance_id !== prediction.taskId ||
      caseData.base_commit !== selected.base_commit
    ) {
      throw new Error(
        `official evaluator case does not match selected task ${prediction.taskId}`,
      );
    }
    await writeNew(
      join(predictionDir, `${prediction.taskId}_preds.json`),
      officialPrediction(
        prediction.taskId,
        manifest.agent.model,
        prediction.patch,
      ),
    );
  }

  const result = spawnSync(
    "uv",
    [
      "run",
      "--python",
      "3.11.13",
      "--no-project",
      "--with-requirements",
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "requirements.txt",
      ),
      "--",
      "bash",
      "./evaluation.sh",
      safeRunId,
      "lite",
      predictionDir,
    ],
    {
      cwd: evaluatorDir,
      encoding: null,
      maxBuffer: 128 * 1024 * 1024,
      timeout: OFFICIAL_TIMEOUT_MS,
    },
  );
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  await writeNew(join(artifactDir, "stdout.log"), stdout);
  await writeNew(join(artifactDir, "stderr.log"), stderr);
  const officialReportPath = join(evaluatorDir, `${safeRunId}.json`);
  const officialLogsPath = join(
    evaluatorDir,
    "logs",
    "run_evaluation",
    safeRunId,
  );
  if (result.error) {
    await writeNew(
      join(artifactDir, "process-error.txt"),
      `${result.error.name}: ${result.error.message}\n`,
    );
  }
  try {
    await cp(officialReportPath, join(artifactDir, `${safeRunId}.json`));
  } catch {
    // Preserve the process output even when the released evaluator did not write a report.
  }
  try {
    await cp(officialLogsPath, join(artifactDir, "logs"), { recursive: true });
  } catch {
    // The global stdout/stderr files remain available for early evaluator failures.
  }
  const metadata = {
    run_id: safeRunId,
    evaluator_commit: commit,
    evaluator_command: ["evaluation.sh", safeRunId, "lite", predictionDir],
    prediction_sha256: createHash("sha256")
      .update(
        predictions
          .map(({ taskId, patch }) => `${taskId}\0${patch}`)
          .join("\0"),
      )
      .digest("hex"),
    task_ids: predictions.map(({ taskId }) => taskId),
    exit_code: result.status,
    signal: result.signal,
    process_error: result.error?.message ?? null,
    stdout_path: relative(resolve(runDir), join(artifactDir, "stdout.log")),
    stderr_path: relative(resolve(runDir), join(artifactDir, "stderr.log")),
    raw_report_path: (await exists(join(artifactDir, `${safeRunId}.json`)))
      ? relative(resolve(runDir), join(artifactDir, `${safeRunId}.json`))
      : null,
  };
  await writeNew(
    join(artifactDir, "metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );

  if (result.error || result.status !== 0) {
    throw new Error(
      `official evaluator ${safeRunId} failed (exit=${result.status}, error=${result.error?.message ?? "none"}); raw output: ${artifactDir}`,
    );
  }
  const report = JSON.parse(
    await readFile(join(artifactDir, `${safeRunId}.json`), "utf8"),
  ) as Record<string, unknown>;
  if (report.submitted_instances !== predictions.length) {
    throw new Error(
      `official evaluator submitted ${String(report.submitted_instances)} of ${predictions.length} predictions; raw output: ${artifactDir}`,
    );
  }
  for (const { taskId } of predictions) {
    if (!(taskId in report)) {
      throw new Error(
        `official evaluator omitted ${taskId}; raw output: ${artifactDir}`,
      );
    }
  }
  return { runId: safeRunId, report };
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export async function gradeSmoke(
  runDir: string,
  evaluatorDir: string,
): Promise<void> {
  const { manifest, selection, preparedDir } = await loadCohort(runDir);
  const targetId = safeId(selection.linked_pairs[0]?.target_task_id ?? "");
  const graderData = JSON.parse(
    await readFile(
      join(preparedDir, "grader-only", `${targetId}.json`),
      "utf8",
    ),
  ) as { reference_patch: string };
  const known = await runOfficialEvaluation(
    evaluatorDir,
    runDir,
    manifest,
    "gate-known",
    [{ taskId: targetId, patch: graderData.reference_patch }],
  );
  const empty = await runOfficialEvaluation(
    evaluatorDir,
    runDir,
    manifest,
    "gate-empty",
    [{ taskId: targetId, patch: "" }],
  );
  const knownResult = known.report[targetId] as
    { resolved?: boolean } | undefined;
  const emptyResult = empty.report[targetId] as
    { resolved?: boolean } | undefined;
  if (knownResult?.resolved !== true || emptyResult?.resolved !== false) {
    throw new Error(
      `official grader gate failed: known=${String(knownResult?.resolved)}, empty=${String(emptyResult?.resolved)}`,
    );
  }
  const gate = {
    known_run_id: known.runId,
    known_resolved: knownResult.resolved,
    empty_run_id: empty.runId,
    empty_resolved: emptyResult.resolved,
    task_id: targetId,
    passed: true,
  };
  await writeNew(
    join(resolve(runDir), "grader-gate.json"),
    `${JSON.stringify(gate, null, 2)}\n`,
  );
}

function parseAttempts(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function attemptPredictions(
  runDir: string,
  manifest: Manifest,
  arm: Arm,
): Promise<Prediction[]> {
  const attempts = parseAttempts(
    await readFile(join(runDir, "attempts.jsonl"), "utf8"),
  );
  const wantedAttempt = arm === "baseline" ? 1 : 2;
  return await Promise.all(
    manifest.target_task_ids.map(async (taskId) => {
      const record = attempts.find(
        (attempt) =>
          attempt.task_id === taskId &&
          attempt.role === "target" &&
          attempt.arm === arm &&
          attempt.attempt === wantedAttempt,
      );
      if (!record)
        throw new Error(`missing ${arm} cohort attempt for ${taskId}`);
      if (record.patch_path === null) return { taskId, patch: "" };
      const patchPath = resolve(runDir, String(record.patch_path));
      const relativePath = relative(resolve(runDir), patchPath);
      if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
        throw new Error(
          `patch path escapes run directory: ${record.patch_path}`,
        );
      }
      return { taskId, patch: await readFile(patchPath, "utf8") };
    }),
  );
}

function isGraderInfrastructureFailure(
  result: Record<string, unknown> | undefined,
): boolean {
  if (!result) return false;
  return (
    result.failure_type === "verifier_setup_failed" ||
    (typeof result.error === "string" &&
      /docker image|image not found|image commit failed|image tag failed|setup failed/i.test(
        result.error,
      ))
  );
}

function tokenTotals(records: Array<Record<string, unknown>>) {
  const fields = [
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
  ] as const;
  return Object.fromEntries(
    fields.map((field) => {
      const present = records
        .map(
          (record) =>
            (record.token_usage as Record<string, unknown> | null)?.[field],
        )
        .filter((value): value is number => typeof value === "number");
      return [
        field,
        {
          available_sum: present.length
            ? present.reduce((sum, value) => sum + value, 0)
            : null,
          reported_attempts: present.length,
          missing_attempts: records.length - present.length,
        },
      ];
    }),
  );
}

export async function gradeCohort(
  runDir: string,
  evaluatorDir: string,
): Promise<void> {
  const { manifest, selection } = await loadCohort(runDir);
  const linkedExperienceByTarget = new Map(
    selection.linked_pairs.map((pair) => [pair.target_task_id, pair]),
  );
  const baselineResult = await runOfficialEvaluation(
    evaluatorDir,
    runDir,
    manifest,
    "cohort-baseline",
    await attemptPredictions(runDir, manifest, "baseline"),
  );
  const mentisResult = await runOfficialEvaluation(
    evaluatorDir,
    runDir,
    manifest,
    "cohort-mentis",
    await attemptPredictions(runDir, manifest, "mentis"),
  );
  const attempts = parseAttempts(
    await readFile(join(runDir, "attempts.jsonl"), "utf8"),
  );
  const targetOutcomes = manifest.target_task_ids.map((taskId) => {
    const baseline = attempts.find(
      (record) =>
        record.task_id === taskId &&
        record.role === "target" &&
        record.arm === "baseline" &&
        record.attempt === 1,
    );
    const mentis = attempts.find(
      (record) =>
        record.task_id === taskId &&
        record.role === "target" &&
        record.arm === "mentis" &&
        record.attempt === 2,
    );
    const baselineGrade = baselineResult.report[taskId] as
      Record<string, unknown> | undefined;
    const mentisGrade = mentisResult.report[taskId] as
      Record<string, unknown> | undefined;
    const baselineResolved = baselineGrade?.resolved === true;
    const mentisResolved = mentisGrade?.resolved === true;
    const linkedPair = linkedExperienceByTarget.get(taskId);
    return {
      task_id: taskId,
      linked_experience_task_id: linkedPair?.experience_task_id ?? null,
      baseline: {
        resolved: baselineResolved,
        patch_status: baseline?.patch_status ?? "missing_attempt",
        elapsed_ms: baseline?.elapsed_ms ?? null,
        token_usage: baseline?.token_usage ?? null,
        memory_calls: baseline?.memory_calls ?? null,
        retrieved_task_ids: baseline?.retrieved_task_ids ?? null,
        infrastructure_failure:
          baseline?.failure_kind === "infrastructure" ||
          isGraderInfrastructureFailure(baselineGrade),
        grader_error: baselineGrade?.error ?? null,
      },
      mentis: {
        resolved: mentisResolved,
        patch_status: mentis?.patch_status ?? "missing_attempt",
        elapsed_ms: mentis?.elapsed_ms ?? null,
        token_usage: mentis?.token_usage ?? null,
        memory_calls: mentis?.memory_calls ?? null,
        retrieved_task_ids: mentis?.retrieved_task_ids ?? null,
        infrastructure_failure:
          mentis?.failure_kind === "infrastructure" ||
          isGraderInfrastructureFailure(mentisGrade),
        grader_error: mentisGrade?.error ?? null,
      },
      outcome:
        mentisResolved === baselineResolved
          ? "unchanged"
          : mentisResolved
            ? "improved"
            : "regressed",
    };
  });
  const counts = (arm: "baseline" | "mentis") => {
    const resolved = targetOutcomes.filter(
      (target) => target[arm].resolved,
    ).length;
    const noPatch = targetOutcomes.filter(
      (target) => target[arm].patch_status === "no_patch",
    ).length;
    const infraFailures = targetOutcomes.filter(
      (target) => target[arm].infrastructure_failure,
    ).length;
    return {
      resolved,
      denominator: manifest.target_task_ids.length,
      no_patch: noPatch,
      infrastructure_failures: infraFailures,
    };
  };
  const report = {
    benchmark: "SWE-ContextBench Lite",
    scope:
      "17-task paired subset; not comparable as a percentage with the paper's full 99-task result",
    model: manifest.agent.model,
    reasoning_effort: manifest.agent.reasoning_effort,
    codex_version: manifest.agent.codex_version,
    baseline_run_id: baselineResult.runId,
    mentis_run_id: mentisResult.runId,
    baseline: counts("baseline"),
    mentis: counts("mentis"),
    targets_improved: targetOutcomes
      .filter((target) => target.outcome === "improved")
      .map(({ task_id }) => task_id),
    targets_regressed: targetOutcomes
      .filter((target) => target.outcome === "regressed")
      .map(({ task_id }) => task_id),
    targets_unchanged: targetOutcomes
      .filter((target) => target.outcome === "unchanged")
      .map(({ task_id }) => task_id),
    token_totals: {
      baseline: tokenTotals(targetOutcomes.map(({ baseline }) => baseline)),
      mentis: tokenTotals(targetOutcomes.map(({ mentis }) => mentis)),
    },
    experience_cohort: {
      task_count: manifest.experience_task_ids.length,
      eligible_linked_target_count: selection.available_linked_target_count,
      date_field: selection.date_field,
      linked_experience_task_ids: selection.linked_experience_task_ids,
      distractor_experience_task_ids: selection.distractor_experience_task_ids,
      linked_pairs: selection.linked_pairs,
    },
    experience_db: await readJsonIfExists(join(runDir, "experience-db.json")),
    target_db_audit: await readJsonLinesIfExists(
      join(runDir, "target-db-audit.jsonl"),
    ),
    targets: targetOutcomes,
  };
  await writeNew(
    join(runDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeNew(join(runDir, "report.md"), markdownReport(report));
}

async function readJsonIfExists(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function readJsonLinesIfExists(path: string): Promise<unknown[]> {
  try {
    return parseAttempts(await readFile(path, "utf8"));
  } catch {
    return [];
  }
}

function markdownReport(report: {
  baseline: {
    resolved: number;
    denominator: number;
    no_patch: number;
    infrastructure_failures: number;
  };
  mentis: {
    resolved: number;
    denominator: number;
    no_patch: number;
    infrastructure_failures: number;
  };
  targets_improved: string[];
  targets_regressed: string[];
  targets_unchanged: string[];
  experience_cohort: {
    task_count: number;
    date_field: string;
    linked_experience_task_ids: string[];
    distractor_experience_task_ids: string[];
  };
  targets: Array<{
    task_id: string;
    linked_experience_task_id: string | null;
    baseline: { resolved: boolean };
    mentis: { resolved: boolean };
    outcome: string;
  }>;
}): string {
  const rows = report.targets.map(
    (target) =>
      `| ${target.task_id} | ${target.linked_experience_task_id ?? "—"} | ${target.baseline.resolved ? "resolved" : "unresolved"} | ${target.mentis.resolved ? "resolved" : "unresolved"} | ${target.outcome} |`,
  );
  return [
    "# SWE-ContextBench Lite paired subset",
    "",
    "This 17-target subset is not directly comparable by percentage with the paper's full 99-task result.",
    `- Experience cohort: ${report.experience_cohort.task_count} tasks; ${report.experience_cohort.linked_experience_task_ids.length} linked IDs and ${report.experience_cohort.distractor_experience_task_ids.length} explicit distractors. Dates use ${report.experience_cohort.date_field}.`,
    "",
    `- Codex alone: ${report.baseline.resolved}/${report.baseline.denominator} resolved; no patch ${report.baseline.no_patch}; infrastructure failures ${report.baseline.infrastructure_failures}.`,
    `- Codex + frozen Mentis: ${report.mentis.resolved}/${report.mentis.denominator} resolved; no patch ${report.mentis.no_patch}; infrastructure failures ${report.mentis.infrastructure_failures}.`,
    `- Improved (${report.targets_improved.length}): ${report.targets_improved.join(", ") || "none"}`,
    `- Regressed (${report.targets_regressed.length}): ${report.targets_regressed.join(", ") || "none"}`,
    `- Unchanged (${report.targets_unchanged.length}): ${report.targets_unchanged.join(", ") || "none"}`,
    "",
    "| Target | Linked experience | Codex alone | Codex + Mentis | Change |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "Per-attempt elapsed time, token availability, memory calls, retrieved task IDs, and raw official grader results are in the run artifacts.",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const [command, runDir, evaluatorDir] = process.argv.slice(2);
  if (!command || !runDir || !evaluatorDir || process.argv.length !== 5) {
    throw new Error(
      "usage: node .data/grade.js <smoke|cohort> <run-directory> <pinned-evaluator-checkout>",
    );
  }
  if (command === "smoke") await gradeSmoke(runDir, evaluatorDir);
  else if (command === "cohort") await gradeCohort(runDir, evaluatorDir);
  else throw new Error(`unknown grade command: ${command}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
