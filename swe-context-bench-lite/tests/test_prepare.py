import copy
import json
import tempfile
import unittest
from pathlib import Path

from prepare import (
    EXPERIENCE_COUNT,
    TARGET_COUNT,
    build_cohort,
    validate_manifest,
    validate_selection,
    write_grader_task,
    write_manifest,
)


def experience(task_id):
    return {
        "repo": "example/repo",
        "instance_id": task_id,
        "base_commit": "a" * 40,
        "patch": "gold experience patch",
        "test_patch": "experience test patch",
        "problem_statement": f"Experience {task_id}.",
        "created_at": "2020-01-01T00:00:00Z",
        "FAIL_TO_PASS": "[]",
    }


def target(task_id):
    return {
        "repo": "example/repo",
        "instance_id": task_id,
        "base_commit": "b" * 40,
        "patch": "gold target patch",
        "test_patch": "target test patch",
        "problem_statement": f"Target {task_id}.",
        "created_at": "2021-01-01T00:00:00Z",
        "FAIL_TO_PASS": '["test_target"]',
    }


def cohort_fixture():
    experiences = [
        experience(f"experience-{index:02}") for index in range(EXPERIENCE_COUNT + 1)
    ]
    experiences[-1]["created_at"] = "2022-01-01T00:00:00Z"
    targets = [target(f"target-{index:02}") for index in range(TARGET_COUNT)]
    relationships = [
        {
            "related_instance_id": task["instance_id"],
            "experience_instance_id": experiences[index]["instance_id"],
            "related_issue_url": "https://example.invalid/target",
            "experience_issue_url": "https://example.invalid/experience",
        }
        for index, task in enumerate(targets)
    ]
    relationships.append(
        {
            "related_instance_id": targets[0]["instance_id"],
            "experience_instance_id": experiences[-1]["instance_id"],
            "related_issue_url": "https://example.invalid/target",
            "experience_issue_url": "https://example.invalid/future",
        }
    )
    return experiences, targets, relationships


def manifest_fixture():
    experiences, targets, relationships = cohort_fixture()
    return build_cohort(experiences, targets, relationships, "test-run", 7)


class CohortTests(unittest.TestCase):
    def test_selects_17_distinct_linked_targets_and_50_tasks(self):
        experiences, targets, relationships = cohort_fixture()
        manifest, selection, grader_tasks = build_cohort(
            experiences, targets, relationships, "test-run", 7
        )
        validate_manifest(manifest)
        validate_selection(selection, manifest)
        self.assertEqual(manifest["agent"], {"codex_version": "0.156.1", "model": "gpt-6-luna", "reasoning_effort": "xhigh"})
        self.assertEqual(len(manifest["experience_task_ids"]), EXPERIENCE_COUNT)
        self.assertEqual(len(manifest["target_task_ids"]), TARGET_COUNT)
        self.assertEqual(len(set(manifest["target_task_ids"])), TARGET_COUNT)
        self.assertEqual(len(selection["linked_pairs"]), TARGET_COUNT)
        self.assertEqual(len(selection["linked_experience_task_ids"]), TARGET_COUNT)
        self.assertEqual(len(selection["distractor_experience_task_ids"]), EXPERIENCE_COUNT - TARGET_COUNT)
        self.assertEqual(grader_tasks["target-00"]["reference_patch"], "gold target patch")
        self.assertNotIn("experience-50", selection["linked_experience_task_ids"])
        self.assertEqual(selection["available_linked_target_count"], TARGET_COUNT)

    def test_future_or_equal_relationships_do_not_count_as_eligible(self):
        for experience_date in ["2022-01-01T00:00:00Z", "2021-01-01T00:00:00Z"]:
            experiences, targets, relationships = cohort_fixture()
            relationships = relationships[:-1]
            experiences[-1]["created_at"] = experience_date
            relationships[0] = {
                **relationships[0],
                "experience_instance_id": experiences[-1]["instance_id"],
            }
            with self.subTest(experience_date=experience_date):
                with self.assertRaisesRegex(ValueError, "only 16 distinct"):
                    build_cohort(experiences, targets, relationships, "test-run", 7)

    def test_manifest_rejects_gold_fields_and_wrong_cohort_size(self):
        manifest, _, _ = manifest_fixture()
        manifest["tasks"][0]["referencePatch"] = "must not be agent-visible"
        with self.assertRaisesRegex(ValueError, "grader-only field"):
            validate_manifest(manifest)
        manifest, _, _ = manifest_fixture()
        manifest["agent"]["reasoning_effort"] = "high"
        with self.assertRaisesRegex(ValueError, "agent metadata"):
            validate_manifest(manifest)
        manifest, _, _ = manifest_fixture()
        manifest["experience_task_ids"].pop()
        with self.assertRaisesRegex(ValueError, "exactly 50"):
            validate_manifest(manifest)

    def test_manifest_and_grader_files_are_separate_and_never_overwritten(self):
        manifest, selection, grader_tasks = manifest_fixture()
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            manifest_path = root / "manifest.json"
            write_manifest(manifest_path, manifest)
            grader_path = write_grader_task(root, "target-00", grader_tasks["target-00"])
            public = json.loads(manifest_path.read_text(encoding="utf-8"))
            private = json.loads(grader_path.read_text(encoding="utf-8"))
            self.assertNotIn("gold target patch", json.dumps(public))
            self.assertEqual(set(private), {"reference_patch", "test_patch", "expected_test_ids"})
            self.assertEqual(grader_path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                write_manifest(manifest_path, manifest)
            with self.assertRaises(FileExistsError):
                write_grader_task(root, "target-00", grader_tasks["target-00"])

    def test_selection_requires_linkage_for_each_selected_target(self):
        manifest, selection, _ = manifest_fixture()
        invalid = copy.deepcopy(selection)
        invalid["linked_pairs"][0]["target_task_id"] = "not-selected"
        with self.assertRaisesRegex(ValueError, "unselected target"):
            validate_selection(invalid, manifest)


if __name__ == "__main__":
    unittest.main()
