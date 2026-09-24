#!/usr/bin/env python3
"""Fetch pinned Lite parquet data and prepare an agent-safe paired cohort."""

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.request import urlopen

BENCHMARK_COMMIT = "12ad6ab14e18e9378e1e293c9edbc3f7ce43d27b"
DATASET_REVISION = "12c65bd15e2559bc808065565e941ee7bbbd008f"
DATASET_REPOSITORY = "https://huggingface.co/datasets/jiayuanz3/SWEContextBench"
CODEX_VERSION = "0.156.1"
CODEX_MODEL = "gpt-6-luna"
REASONING_EFFORT = "xhigh"
PYTHON_VERSION = "3.11.13"
PREPARE_PYARROW_VERSION = "22.0.0"
TARGET_COUNT = 17
EXPERIENCE_COUNT = 50
LITE_TARGET_COUNT = 99
DATASET_FILES = [
    "data/SWEContextBench_Lite_Experience.parquet",
    "data/SWEContextBench_Related_Lite.parquet",
    "data/SWEContextBench_Relationship.parquet",
]
DATASET_SHA256 = {
    "SWEContextBench_Lite_Experience.parquet": "7a21f37b8bc179c7db5beeb14e88ac538ba283455c776e6b2535bbfb6e3551b4",
    "SWEContextBench_Related_Lite.parquet": "1930b392f7beb17a0d87c2e79d1eb889af2c5996b23a003386651ba64a68b8f3",
    "SWEContextBench_Relationship.parquet": "f59b1a0fd021c6608bd185f15113cbbd26f804c20494da6d4827adb9ea70edb5",
}
GRADER_FIELDS = {"reference_patch", "test_patch", "expected_test_ids"}
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
PROMPT_TEMPLATES = {
    "common": (
        "Solve this repository task. Work only in /testbed. Inspect the code, make the smallest correct change, "
        "and run relevant local checks. Do not claim a check passed unless you ran it.\n\n"
        "Task: {task_id}\nRepository: {repository}\nBase commit: {base_commit}\n\n"
        "Problem statement:\n{problem_statement}\n"
    ),
    "experience": (
        "{common}\nMentis is available. Search for related prior attempts before editing. At the end, you MUST call "
        "record_attempt with the actual actions, affected files, observations, and only checks you really ran. "
        "Keep observation separate from inference. Never include secrets.\n"
    ),
    "baseline": "{common}\nNo Mentis tools are configured for this baseline trial.\n",
    "mentis": (
        "{common}\nUse Mentis search before editing, then recall the full history of any useful candidate. "
        "Mentis is read-only for this trial: do not attempt to record an attempt.\n"
    ),
}
EXECUTION_PROTOCOL = {
    "prompt_version": "mentis-lite-paired-v1",
    "prompt_templates": PROMPT_TEMPLATES,
    "limits": {"wall_clock_seconds": 1800, "attempts_per_task_per_arm": 1},
    "task_order_policy": (
        "experience_task_ids in manifest order; for each target in target_task_ids order, "
        "run baseline then mentis; one separate linked-pair gate before the 17-target cohort"
    ),
}
BENCHMARK_METADATA = {
    "name": "SWE-ContextBench Lite",
    "source_repository": "https://github.com/jiayuanz3/SWEContextBench",
    "source_commit": BENCHMARK_COMMIT,
    "dataset_repository": DATASET_REPOSITORY,
    "dataset_revision": DATASET_REVISION,
    "dataset_files": DATASET_FILES,
    "dataset_sha256": DATASET_SHA256,
    "target_count": TARGET_COUNT,
    "experience_count": EXPERIENCE_COUNT,
    "lite_target_count": LITE_TARGET_COUNT,
    "scope": "paired-subset",
}


def _require_object(value: Any, fields: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ValueError(f"{label} must be an object")
    if value.keys() != fields:
        missing = fields - value.keys()
        extra = value.keys() - fields
        raise ValueError(
            f"{label} fields differ (missing={sorted(missing)}, extra={sorted(extra)})"
        )
    return value


def _reject_grader_fields(value: Any, path: str = "manifest") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str):
                raise ValueError(f"{path} has a non-string object key")
            snake_case = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", key).lower()
            normalized = re.sub(r"[^a-z0-9]+", "_", snake_case).strip("_")
            if normalized in GRADER_FIELDS:
                raise ValueError(f"grader-only field {key!r} is forbidden in {path}")
            _reject_grader_fields(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_grader_fields(child, f"{path}[{index}]")


def _string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _validate_ids(value: Any, label: str, expected_count: int | None = None) -> list[str]:
    if not isinstance(value, list) or not value:
        raise ValueError(f"{label} must be a non-empty list")
    ids = [_string(item, f"{label} item") for item in value]
    if any(not ID_PATTERN.fullmatch(task_id) for task_id in ids):
        raise ValueError(f"{label} contains an unsafe task ID")
    if len(ids) != len(set(ids)):
        raise ValueError(f"{label} contains duplicate task IDs")
    if expected_count is not None and len(ids) != expected_count:
        raise ValueError(f"{label} must contain exactly {expected_count} tasks")
    return ids


def validate_manifest(manifest: Any) -> None:
    """Validate public task data and the fixed experiment protocol."""
    _reject_grader_fields(manifest)
    manifest = _require_object(
        manifest,
        {
            "schema_version",
            "run_id",
            "benchmark",
            "agent",
            "evaluation",
            "execution",
            "experience_task_ids",
            "target_task_ids",
            "tasks",
        },
        "manifest",
    )
    if manifest["schema_version"] != 1 or isinstance(manifest["schema_version"], bool):
        raise ValueError("schema_version must be 1")
    run_id = _string(manifest["run_id"], "run_id")
    if not ID_PATTERN.fullmatch(run_id):
        raise ValueError("run_id is not a safe path component")
    if manifest["benchmark"] != BENCHMARK_METADATA:
        raise ValueError("benchmark metadata does not match the pinned Lite cohort")
    agent = _require_object(manifest["agent"], {"codex_version", "model", "reasoning_effort"}, "agent")
    if agent != {"codex_version": CODEX_VERSION, "model": CODEX_MODEL, "reasoning_effort": REASONING_EFFORT}:
        raise ValueError("agent metadata does not match the pinned Codex version and model")
    evaluation = _require_object(
        manifest["evaluation"], {"python_version", "requirements"}, "evaluation"
    )
    if evaluation != {"python_version": PYTHON_VERSION, "requirements": []}:
        raise ValueError("evaluation metadata does not match the pinned evaluator runtime")
    if manifest["execution"] != EXECUTION_PROTOCOL:
        raise ValueError("execution protocol differs from the fixed prompt, limits, or task order")

    experience_ids = _validate_ids(
        manifest["experience_task_ids"], "experience_task_ids", EXPERIENCE_COUNT
    )
    target_ids = _validate_ids(
        manifest["target_task_ids"], "target_task_ids", TARGET_COUNT
    )
    if set(experience_ids) & set(target_ids):
        raise ValueError("experience and target task IDs must be disjoint")

    tasks = manifest["tasks"]
    if not isinstance(tasks, list):
        raise ValueError("tasks must be a list")
    task_ids: list[str] = []
    for index, task in enumerate(tasks):
        task = _require_object(
            task,
            {"task_id", "role", "repository", "base_commit", "created_at", "problem_statement"},
            f"tasks[{index}]",
        )
        task_id = _string(task["task_id"], f"tasks[{index}].task_id")
        if not ID_PATTERN.fullmatch(task_id):
            raise ValueError(f"tasks[{index}].task_id is not a safe path component")
        role = _string(task["role"], f"tasks[{index}].role")
        if role not in {"experience", "target"}:
            raise ValueError(f"tasks[{index}].role must be experience or target")
        _string(task["repository"], f"tasks[{index}].repository")
        _string(task["problem_statement"], f"tasks[{index}].problem_statement")
        base_commit = _string(task["base_commit"], f"tasks[{index}].base_commit")
        if task["created_at"] is not None:
            _date(task["created_at"], f"tasks[{index}].created_at")
        if not COMMIT_PATTERN.fullmatch(base_commit):
            raise ValueError(f"tasks[{index}].base_commit must be a full Git commit SHA")
        task_ids.append(task_id)

    if len(task_ids) != len(set(task_ids)):
        raise ValueError("tasks contains duplicate task IDs")
    expected_ids = set(experience_ids) | set(target_ids)
    if set(task_ids) != expected_ids or len(task_ids) != len(expected_ids):
        raise ValueError("tasks must contain every selected ID exactly once")
    roles = {task["task_id"]: task["role"] for task in tasks}
    if any(roles[task_id] != "experience" for task_id in experience_ids):
        raise ValueError("experience task IDs must have role experience")
    if any(roles[task_id] != "target" for task_id in target_ids):
        raise ValueError("target task IDs must have role target")


def validate_selection(selection: Any, manifest: Any) -> None:
    selection = _require_object(
        selection,
        {
            "schema_version",
            "selection_policy",
            "seed",
            "available_linked_target_count",
            "date_field",
            "experience_created_at",
            "linked_pairs",
            "linked_experience_task_ids",
            "distractor_experience_task_ids",
        },
        "selection",
    )
    validate_manifest(manifest)
    if selection["schema_version"] != 1:
        raise ValueError("selection schema_version must be 1")
    if selection["selection_policy"] != "sha256-rank-v1":
        raise ValueError("unknown selection policy")
    if selection["date_field"] != "created_at (dataset PR creation timestamp)":
        raise ValueError("unknown date field")
    if (
        not isinstance(selection["available_linked_target_count"], int)
        or isinstance(selection["available_linked_target_count"], bool)
        or selection["available_linked_target_count"] < TARGET_COUNT
    ):
        raise ValueError("available_linked_target_count must be at least 17")
    experience_dates = selection["experience_created_at"]
    if not isinstance(experience_dates, dict):
        raise ValueError("experience_created_at must map task IDs to dates")
    if set(experience_dates) != set(manifest["experience_task_ids"]):
        raise ValueError("experience_created_at must cover all 50 selected tasks")
    for task_id, value in experience_dates.items():
        _date(value, f"experience_created_at.{task_id}")
    if not isinstance(selection["seed"], int) or isinstance(selection["seed"], bool):
        raise ValueError("selection seed must be an integer")
    pairs = selection["linked_pairs"]
    if not isinstance(pairs, list) or len(pairs) != TARGET_COUNT:
        raise ValueError(f"linked_pairs must contain exactly {TARGET_COUNT} pairs")
    targets = [pair.get("target_task_id") for pair in pairs if isinstance(pair, dict)]
    linked = [pair.get("experience_task_id") for pair in pairs if isinstance(pair, dict)]
    if len(targets) != TARGET_COUNT or len(set(targets)) != TARGET_COUNT:
        raise ValueError("linked_pairs must identify 17 distinct targets")
    if not set(targets) <= set(manifest["target_task_ids"]):
        raise ValueError("linked_pairs refer to an unselected target")
    if not set(linked) <= set(manifest["experience_task_ids"]):
        raise ValueError("linked_pairs refer to an unselected experience task")
    linked_ids = _validate_ids(
        selection["linked_experience_task_ids"], "linked_experience_task_ids"
    )
    distractor_ids = _validate_ids(
        selection["distractor_experience_task_ids"], "distractor_experience_task_ids"
    )
    if set(linked_ids) & set(distractor_ids):
        raise ValueError("linked and distractor experience IDs must be disjoint")
    if set(linked_ids) | set(distractor_ids) != set(manifest["experience_task_ids"]):
        raise ValueError("linked and distractor IDs must partition the 50 experience tasks")
    if not set(linked) <= set(linked_ids):
        raise ValueError("linked_pairs experience IDs must be marked linked")
    for pair in pairs:
        target_date = _date(pair.get("target_created_at"), "linked target date")
        experience_date = _date(pair.get("experience_created_at"), "linked experience date")
        if target_date and experience_date and experience_date >= target_date:
            raise ValueError("linked experience is not earlier than its related target")


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    validate_manifest(manifest)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as output:
        json.dump(manifest, output, indent=2)
        output.write("\n")


def write_grader_task(directory: Path, task_id: str, fields: dict[str, Any]) -> Path:
    """Keep gold patches and expected tests in a private, non-agent directory."""
    task_id = _string(task_id, "task_id")
    if not ID_PATTERN.fullmatch(task_id):
        raise ValueError("task_id is not a safe path component")
    fields = _require_object(fields, GRADER_FIELDS, "grader task")
    if not isinstance(fields["reference_patch"], str) or not isinstance(fields["test_patch"], str):
        raise ValueError("grader patches must be strings")
    if not isinstance(fields["expected_test_ids"], list) or not all(
        isinstance(test_id, str) for test_id in fields["expected_test_ids"]
    ):
        raise ValueError("expected_test_ids must be a list of strings")
    directory = directory / "grader-only"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    path = directory / f"{task_id}.json"
    with path.open("x", encoding="utf-8") as output:
        json.dump(fields, output, indent=2)
        output.write("\n")
    path.chmod(0o600)
    return path


def _rank(seed: int, key: str) -> str:
    return hashlib.sha256(f"{seed}:{key}".encode()).hexdigest()


def _date(value: Any, label: str) -> datetime | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValueError(f"{label} must be an ISO date string or empty")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise ValueError(f"invalid {label}: {value!r}") from error


def _read_parquet_files(dataset_dir: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    for filename, expected_hash in DATASET_SHA256.items():
        path = dataset_dir / filename
        if not path.is_file():
            raise ValueError(f"missing pinned dataset file: {path}; run the prepare command to download it")
        actual_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual_hash != expected_hash:
            raise ValueError(f"SHA-256 mismatch for {path}: {actual_hash}")
    try:
        import pyarrow
        import pyarrow.parquet as parquet
    except ImportError as error:
        raise ValueError(
            f"PyArrow {PREPARE_PYARROW_VERSION} is required; install prepare-requirements.txt"
        ) from error
    if pyarrow.__version__ != PREPARE_PYARROW_VERSION:
        raise ValueError(f"expected PyArrow {PREPARE_PYARROW_VERSION}, got {pyarrow.__version__}")
    paths = [dataset_dir / Path(filename).name for filename in DATASET_FILES]
    tables = [parquet.read_table(path).to_pylist() for path in paths]
    return tables[0], tables[1], tables[2]


def download_dataset(dataset_dir: Path) -> None:
    dataset_dir.mkdir(parents=True, exist_ok=True)
    for filename in DATASET_FILES:
        output = dataset_dir / Path(filename).name
        if output.exists():
            continue
        url = f"{DATASET_REPOSITORY}/resolve/{DATASET_REVISION}/{filename}"
        with urlopen(url, timeout=60) as response:
            content = response.read()
        digest = hashlib.sha256(content).hexdigest()
        expected = DATASET_SHA256[output.name]
        if digest != expected:
            raise ValueError(f"downloaded file SHA-256 mismatch for {filename}: {digest}")
        temporary = output.with_suffix(output.suffix + ".tmp")
        temporary.write_bytes(content)
        temporary.replace(output)


def build_cohort(
    experiences: list[dict[str, Any]],
    related_tasks: list[dict[str, Any]],
    relationships: list[dict[str, Any]],
    run_id: str,
    seed: int,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, dict[str, Any]]]:
    if not ID_PATTERN.fullmatch(run_id):
        raise ValueError("run_id is not a safe path component")
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise ValueError("seed must be an integer")
    experience_by_id = {task["instance_id"]: task for task in experiences}
    target_by_id = {task["instance_id"]: task for task in related_tasks}
    if len(experience_by_id) != len(experiences) or len(target_by_id) != len(related_tasks):
        raise ValueError("dataset contains duplicate task IDs")

    links_by_target: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
    all_linked_to_target: dict[str, set[str]] = {}
    for link in relationships:
        target_id = link.get("related_instance_id")
        experience_id = link.get("experience_instance_id")
        if target_id in target_by_id and experience_id in experience_by_id:
            all_linked_to_target.setdefault(target_id, set()).add(experience_id)
            target = target_by_id[target_id]
            experience = experience_by_id[experience_id]
            target_date = _date(target.get("created_at"), f"{target_id}.created_at")
            experience_date = _date(
                experience.get("created_at"), f"{experience_id}.created_at"
            )
            if target_date and experience_date and experience_date >= target_date:
                continue
            links_by_target.setdefault(target_id, []).append((link, experience))

    if len(links_by_target) < TARGET_COUNT:
        raise ValueError(
            f"only {len(links_by_target)} distinct Lite related targets have an earlier linked Lite experience; "
            f"{TARGET_COUNT} required"
        )
    experience_dates = {
        task_id: task.get("created_at") or None for task_id, task in experience_by_id.items()
    }
    target_ids = sorted(
        links_by_target,
        key=lambda task_id: (_rank(seed, f"target:{task_id}"), task_id),
    )[:TARGET_COUNT]
    selected_links: list[dict[str, Any]] = []
    linked_experience_ids: set[str] = set()
    for target_id in target_ids:
        candidates = sorted(
            links_by_target[target_id],
            key=lambda pair: (
                _rank(seed, f"pair:{target_id}:{pair[1]['instance_id']}"),
                pair[1]["instance_id"],
            ),
        )
        link, experience = candidates[0]
        target = target_by_id[target_id]
        target_date = _date(target.get("created_at"), f"{target_id}.created_at")
        experience_date = _date(
            experience.get("created_at"), f"{experience['instance_id']}.created_at"
        )
        date_check = (
            "both_dates_ordered"
            if target_date and experience_date
            else "target_date_missing"
            if not target_date
            else "experience_date_missing"
        )
        selected_links.append(
            {
                "target_task_id": target_id,
                "experience_task_id": experience["instance_id"],
                "target_created_at": target.get("created_at") or None,
                "experience_created_at": experience.get("created_at") or None,
                "date_check": date_check,
                "related_issue_url": link.get("related_issue_url"),
                "experience_issue_url": link.get("experience_issue_url"),
            }
        )
        linked_experience_ids.add(experience["instance_id"])

    selected_target_ids = set(target_ids)
    forbidden_distractors = set().union(
        *(all_linked_to_target.get(target_id, set()) for target_id in selected_target_ids)
    )
    distractor_candidates = [
        task_id
        for task_id in experience_by_id
        if task_id not in forbidden_distractors and task_id not in linked_experience_ids
    ]
    distractor_candidates.sort(key=lambda task_id: (_rank(seed, f"distractor:{task_id}"), task_id))
    distractor_count = EXPERIENCE_COUNT - len(linked_experience_ids)
    if len(distractor_candidates) < distractor_count:
        raise ValueError(
            f"only {len(distractor_candidates)} explicit distractor experiences are available; "
            f"{distractor_count} required"
        )
    distractor_ids = distractor_candidates[:distractor_count]
    experience_ids = sorted(
        linked_experience_ids | set(distractor_ids),
        key=lambda task_id: (_rank(seed, f"experience-order:{task_id}"), task_id),
    )
    selected_target_ids_ordered = target_ids
    tasks = [
        {
            "task_id": task_id,
            "role": "experience",
            "repository": experience_by_id[task_id]["repo"],
            "base_commit": experience_by_id[task_id]["base_commit"],
            "created_at": experience_by_id[task_id].get("created_at") or None,
            "problem_statement": experience_by_id[task_id]["problem_statement"],
        }
        for task_id in experience_ids
    ] + [
        {
            "task_id": task_id,
            "role": "target",
            "repository": target_by_id[task_id]["repo"],
            "base_commit": target_by_id[task_id]["base_commit"],
            "created_at": target_by_id[task_id].get("created_at") or None,
            "problem_statement": target_by_id[task_id]["problem_statement"],
        }
        for task_id in selected_target_ids_ordered
    ]
    manifest = {
        "schema_version": 1,
        "run_id": run_id,
        "benchmark": BENCHMARK_METADATA,
        "agent": {"codex_version": CODEX_VERSION, "model": CODEX_MODEL, "reasoning_effort": REASONING_EFFORT},
        "evaluation": {"python_version": PYTHON_VERSION, "requirements": []},
        "execution": EXECUTION_PROTOCOL,
        "experience_task_ids": experience_ids,
        "target_task_ids": selected_target_ids_ordered,
        "tasks": tasks,
    }
    selection = {
        "schema_version": 1,
        "selection_policy": "sha256-rank-v1",
        "date_field": "created_at (dataset PR creation timestamp)",
        "seed": seed,
        "available_linked_target_count": len(links_by_target),
        "experience_created_at": {
            task_id: experience_by_id[task_id].get("created_at") or None
            for task_id in experience_ids
        },
        "linked_pairs": selected_links,
        "linked_experience_task_ids": sorted(linked_experience_ids),
        "distractor_experience_task_ids": sorted(distractor_ids),
    }
    grader_tasks = {
        task_id: {
            "reference_patch": target_by_id[task_id]["patch"],
            "test_patch": target_by_id[task_id]["test_patch"],
            "expected_test_ids": json.loads(target_by_id[task_id]["FAIL_TO_PASS"]),
        }
        for task_id in selected_target_ids_ordered
    }
    validate_manifest(manifest)
    validate_selection(selection, manifest)
    return manifest, selection, grader_tasks


def _write_json(path: Path, value: Any) -> None:
    with path.open("x", encoding="utf-8") as output:
        json.dump(value, output, indent=2)
        output.write("\n")


def prepare(dataset_dir: Path, output_dir: Path, run_id: str, seed: int) -> None:
    download_dataset(dataset_dir)
    experiences, related, relationships = _read_parquet_files(dataset_dir)
    manifest, selection, grader_tasks = build_cohort(
        experiences, related, relationships, run_id, seed
    )
    output_dir.mkdir(parents=True, exist_ok=False)
    write_manifest(output_dir / "manifest.json", manifest)
    _write_json(output_dir / "selection.json", selection)
    for task_id, grader_data in grader_tasks.items():
        write_grader_task(output_dir, task_id, grader_data)
    print(
        f"prepared {len(manifest['experience_task_ids'])} experience tasks and "
        f"{len(manifest['target_task_ids'])} linked targets; "
        f"{selection['available_linked_target_count']} eligible targets available"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare_parser = subparsers.add_parser("prepare", help="fetch pinned data and create a cohort")
    prepare_parser.add_argument("--dataset-dir", type=Path, default=Path(__file__).parent / ".data" / "dataset")
    prepare_parser.add_argument("--output-dir", type=Path, required=True)
    prepare_parser.add_argument("--run-id", required=True)
    prepare_parser.add_argument("--seed", type=int, default=20260924)
    validate_parser = subparsers.add_parser("validate", help="validate an agent-safe manifest")
    validate_parser.add_argument("manifest", type=Path)
    selection_parser = subparsers.add_parser("validate-selection", help="validate selected linked pairs")
    selection_parser.add_argument("manifest", type=Path)
    selection_parser.add_argument("selection", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            prepare(args.dataset_dir, args.output_dir, args.run_id, args.seed)
        elif args.command == "validate":
            manifest = (
                json.load(sys.stdin)
                if str(args.manifest) == "-"
                else json.loads(args.manifest.read_text(encoding="utf-8"))
            )
            validate_manifest(manifest)
            print(f"valid manifest: {args.manifest}")
        else:
            manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
            selection = json.loads(args.selection.read_text(encoding="utf-8"))
            validate_selection(selection, manifest)
            print(f"valid selection: {args.selection}")
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"invalid cohort: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
