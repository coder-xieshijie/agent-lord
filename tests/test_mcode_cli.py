from __future__ import annotations

from argparse import Namespace
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from agent_lord import AgentLord, AgentLordError
from agent_lord.config import parse_mcode_model
from agent_lord.handoff import canonical_packet_bytes
from agent_lord.mcode_cli_adapter import _validate_provider_output
from agent_lord.state import create_operation, load_operation, load_task, normalize_task, utc_now
from scripts.agent_lord import build_parser
from scripts.task_store import put as put_task


FAKE_MCODE = r'''#!/usr/bin/env python3
import json
import os
import sys
import time

args = sys.argv[1:]
argv_log = os.environ.get("FAKE_MCODE_ARGV_LOG")
if argv_log:
    with open(argv_log, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(args) + "\n")
prompt = sys.stdin.read()
prompt_log = os.environ.get("FAKE_MCODE_PROMPT_LOG")
if prompt_log:
    with open(prompt_log, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(prompt) + "\n")
session_id = args[args.index("--session") + 1] if "--session" in args else os.environ.get("FAKE_MCODE_SESSION", "mvs_test_session")
model_literal = args[args.index("--model") + 1]
provider_id, model_part = model_literal.split("/", 1)
if "#" in model_part:
    model_id, variant = model_part.rsplit("#", 1)
else:
    model_id, variant = model_part, None
if os.environ.get("FAKE_MCODE_WRONG_MODEL") == "1":
    model_id = "wrong-model"
observed_variant = os.environ.get("FAKE_MCODE_OBSERVED_VARIANT", variant)
model = {"providerId": provider_id, "modelId": model_id, "providerSource": "test", "providerKind": "test", "protocol": "test"}
if observed_variant:
    model["variant"] = observed_variant
run_id = "exec_turn_" + str(os.getpid())
turn_id = "turn_" + str(os.getpid())
sequence = 0
scenario = os.environ.get("FAKE_MCODE_SCENARIO", "success")

def emit(event_type, **values):
    global sequence
    sequence += 1
    value = {
        "schemaVersion": 1,
        "sequence": sequence,
        "timestampMs": int(time.time() * 1000),
        "runId": run_id,
        "sessionId": session_id,
        "turnId": turn_id,
        "type": event_type,
    }
    value.update(values)
    print(json.dumps(value), flush=True)
    return value

emit("exec.started")
emit("session.resumed" if "--session" in args else "session.started")
emit("turn.started")
delay = float(os.environ.get("FAKE_MCODE_DELAY", "0"))
if delay:
    time.sleep(delay)
if scenario == "cross-identity":
    session_id = "mvs_other_session"
    emit("item.completed", item={"id": "a", "type": "agent_message", "content": "bad"})
    sys.exit(0)
if scenario == "missing-terminal":
    sys.exit(0)

status = os.environ.get("FAKE_MCODE_STATUS", "succeeded")
if scenario == "unknown-status":
    status = "blocked"
output_text = os.environ.get("FAKE_MCODE_OUTPUT", "mcode final")
structured = os.environ.get("FAKE_MCODE_STRUCTURED") == "1"
output = json.loads(output_text) if structured else output_text
result = {
    "schemaVersion": 1,
    "type": "exec.result",
    "runId": run_id,
    "sessionId": session_id,
    "turnId": turn_id,
    "status": status,
    "model": model,
    "durationMs": 1,
}
if os.environ.get("FAKE_MCODE_NO_MODEL") == "1":
    result.pop("model", None)
if status == "succeeded":
    result["output"] = output
    result_path = args[args.index("--output-last-message") + 1]
    with open(result_path, "w", encoding="utf-8") as handle:
        handle.write(os.environ.get("FAKE_MCODE_FINAL", output_text))
    emit("turn.completed", model=model, durationMs=1)
else:
    result["error"] = {"category": "runtime", "code": "TEST", "message": "failed", "retryable": False}
    emit("turn.failed", status=status, error=result["error"], durationMs=1)
terminal = emit("exec.completed", result=result)
if scenario == "duplicate-terminal":
    sequence -= 1
    print(json.dumps(terminal), flush=True)
exit_override = os.environ.get("FAKE_MCODE_EXIT")
sys.exit(int(exit_override) if exit_override is not None else (0 if status == "succeeded" else 4))
'''


class MCodeCLITests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.root = self.base / "state"
        self.target = self.base / "workspace"
        self.target.mkdir()
        self.fake_mcode = self.base / "fake-mcode"
        self.fake_mcode.write_text(FAKE_MCODE, encoding="utf-8")
        self.fake_mcode.chmod(self.fake_mcode.stat().st_mode | stat.S_IXUSR)
        self.argv_log = self.base / "mcode-argv.jsonl"
        self.prompt_log = self.base / "mcode-prompt.jsonl"
        self.environment = patch.dict(
            os.environ,
            {
                "AGENT_LORD_STATE_DIR": str(self.root),
                "AGENT_LORD_MCODE_BIN": str(self.fake_mcode),
                "FAKE_MCODE_ARGV_LOG": str(self.argv_log),
                "FAKE_MCODE_PROMPT_LOG": str(self.prompt_log),
                "FAKE_MCODE_SESSION": "mvs_test_session",
            },
            clear=False,
        )
        self.environment.start()
        self.lord = AgentLord(self.root)

    def tearDown(self) -> None:
        self.environment.stop()
        self.temporary.cleanup()

    @staticmethod
    def model(variant: str | None = None) -> str:
        value = "test-provider/test-model"
        return value + ("#" + variant if variant else "")

    def _arguments(self):
        return [json.loads(line) for line in self.argv_log.read_text(encoding="utf-8").splitlines()]

    def test_start_and_turn_freeze_model_permission_and_session(self) -> None:
        start = self.lord.start("mcode-task", "mcode", str(self.target), "first", model=self.model("deep"))
        turn = self.lord.turn("mcode-task", "second")

        self.assertEqual("SUCCEEDED", start["status"])
        self.assertEqual("mcode-cli", start["provider"])
        self.assertEqual(start["endpoint_id"], turn["endpoint_id"])
        self.assertEqual("mvs_test_session", start["endpoint_id"])
        self.assertEqual("deep", turn["observed"]["variant"])
        self.assertEqual("provider-metadata", turn["observed"]["variant_verification"])
        self.assertEqual("mcode-permission-full-argument", turn["observed"]["permission_enforcement"])
        self.assertIsNone(turn["observed"]["effort"])
        self.assertEqual("not-supported", turn["observed"]["effort_verification"])
        arguments = self._arguments()
        self.assertEqual(2, len(arguments))
        for invocation in arguments:
            self.assertEqual(["exec", "--input", "-", "--cwd"], invocation[:4])
            self.assertEqual(self.model("deep"), invocation[invocation.index("--model") + 1])
            self.assertEqual("full", invocation[invocation.index("--permission") + 1])
            self.assertNotIn("--continue", invocation)
        self.assertNotIn("--session", arguments[0])
        self.assertEqual(start["endpoint_id"], arguments[1][arguments[1].index("--session") + 1])
        operation = load_operation(turn["operation_id"], self.root)
        self.assertEqual(turn["observed"]["run_id"], operation["run_id"])
        self.assertEqual(turn["observed"]["turn_id"], operation["turn_id"])
        artifact = Path(turn["artifact"]["path"])
        self.assertEqual("mcode final\n", artifact.read_text(encoding="utf-8"))
        self.assertNotIn("item.", artifact.read_text(encoding="utf-8"))

    def test_unrequested_variant_is_reported_but_not_claimed_as_frozen(self) -> None:
        with patch.dict(os.environ, {"FAKE_MCODE_OBSERVED_VARIANT": "provider-default"}, clear=False):
            result = self.lord.start("variant-default", "mcode-cli", str(self.target), "run", model=self.model())
        self.assertEqual("provider-default", result["observed"]["variant"])
        self.assertEqual("not-requested", result["observed"]["variant_verification"])

    def test_check_and_checkpoint_observe_live_progress(self) -> None:
        with patch.dict(os.environ, {"FAKE_MCODE_DELAY": "3"}, clear=False), ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(
                self.lord.start,
                "live-progress",
                "mcode-cli",
                str(self.target),
                "run",
                self.model(),
            )
            deadline = time.monotonic() + 2
            task = None
            while time.monotonic() < deadline:
                try:
                    task = load_task("live-progress", self.root)
                    break
                except AgentLordError:
                    time.sleep(0.02)
            self.assertIsNotNone(task)
            checked = self.lord.check("live-progress")
            self.assertEqual("RUNNING", checked["status"])
            self.assertEqual("mvs_test_session", checked["endpoint_id"])
            self.assertGreaterEqual(checked["observed"]["supervision"]["progress_seq"], 2)
            checkpoint, quiet = self.lord.checkpoint(["live-progress"], 1)
            self.assertTrue(quiet)
            self.assertEqual("CHECKPOINT_QUIET", checkpoint["status"])
            self.assertEqual("mcode-cli", checkpoint["active"][0]["provider"])
            self.assertGreaterEqual(checkpoint["active"][0]["progress_seq"], 2)
            self.assertEqual("SUCCEEDED", future.result(timeout=5)["status"])

    def test_model_effort_and_read_only_fail_before_launch(self) -> None:
        cases = [
            {"model": None},
            {"model": "bare-model"},
            {"model": "provider/model#"},
            {"model": self.model(), "effort": "high"},
            {"model": self.model(), "read_only": True},
        ]
        for index, values in enumerate(cases):
            with self.subTest(values=values):
                with self.assertRaises(AgentLordError) as raised:
                    self.lord.start("invalid-%d" % index, "mcode", str(self.target), "run", **values)
                self.assertIn(raised.exception.code, ("CONFIG_INVALID", "PERMISSION_UNSUPPORTED"))
        self.assertFalse(self.argv_log.exists())
        self.assertEqual(
            {"provider_id": "p", "model_id": "m", "variant": "v"},
            parse_mcode_model("p/m#v"),
        )

    def test_variant_mismatch_is_rejected_and_session_is_retained(self) -> None:
        with patch.dict(os.environ, {"FAKE_MCODE_OBSERVED_VARIANT": "other"}, clear=False):
            with self.assertRaises(AgentLordError) as raised:
                self.lord.start("variant-mismatch", "mcode", str(self.target), "run", model=self.model("deep"))
        self.assertEqual("MODEL_MISMATCH", raised.exception.code)
        self.assertEqual("mvs_test_session", load_task("variant-mismatch", self.root)["endpoint_id"])
        self.assertEqual("failed", load_operation(raised.exception.details["operation_id"], self.root)["status"])

    def test_structured_output_compares_parsed_file_value(self) -> None:
        with patch.dict(
            os.environ,
            {"FAKE_MCODE_STRUCTURED": "1", "FAKE_MCODE_OUTPUT": '{"answer": 7}'},
            clear=False,
        ):
            result = self.lord.start("structured", "mcode", str(self.target), "run", model=self.model())
        self.assertEqual("SUCCEEDED", result["status"])
        self.assertEqual('{"answer": 7}\n', Path(result["artifact"]["path"]).read_text(encoding="utf-8"))

    def test_strict_terminal_and_identity_failures(self) -> None:
        scenarios = {
            "missing-terminal": "RESULT_INVALID",
            "duplicate-terminal": "RESULT_INVALID",
            "cross-identity": "ENDPOINT_MISMATCH",
            "unknown-status": "RESULT_INVALID",
        }
        for index, (scenario, code) in enumerate(scenarios.items()):
            with self.subTest(scenario=scenario), patch.dict(os.environ, {"FAKE_MCODE_SCENARIO": scenario}, clear=False):
                with self.assertRaises(AgentLordError) as raised:
                    self.lord.start("strict-%d" % index, "mcode", str(self.target), "run", model=self.model())
                self.assertEqual(code, raised.exception.code)

    def test_success_requires_zero_exit_and_matching_fresh_final_file(self) -> None:
        cases = [
            ({"FAKE_MCODE_EXIT": "4"}, "PROVIDER_FAILED"),
            ({"FAKE_MCODE_FINAL": "different"}, "RESULT_INVALID"),
        ]
        for index, (environment, code) in enumerate(cases):
            with self.subTest(environment=environment), patch.dict(os.environ, environment, clear=False):
                with self.assertRaises(AgentLordError) as raised:
                    self.lord.start("result-%d" % index, "mcode", str(self.target), "run", model=self.model())
                self.assertEqual(code, raised.exception.code)

        events = self._success_events("mvs-stale", "run-stale", "turn-stale", self.model(), "answer")
        with self.assertRaises(AgentLordError) as raised:
            _validate_provider_output(
                "\n".join(json.dumps(event) for event in events) + "\n",
                "",
                "answer",
                9,
                10,
                None,
                None,
                None,
                False,
                self.model(),
                False,
                None,
                0,
            )
        self.assertEqual("RESULT_INVALID", raised.exception.code)

    def test_all_documented_non_success_statuses_fail_without_replay(self) -> None:
        for index, status in enumerate(("failed", "timeout", "cancelled", "limit_exceeded")):
            with self.subTest(status=status), patch.dict(os.environ, {"FAKE_MCODE_STATUS": status}, clear=False):
                with self.assertRaises(AgentLordError) as raised:
                    self.lord.start("status-%d" % index, "mcode", str(self.target), "run", model=self.model())
                self.assertEqual("PROVIDER_FAILED", raised.exception.code)
                self.assertEqual(status, raised.exception.details["provider_status"])
                self.assertEqual("mvs_test_session", load_task("status-%d" % index, self.root)["endpoint_id"])
        self.assertEqual(4, len(self._arguments()))

    def test_cancelled_start_without_model_metadata_keeps_session_for_explicit_later_turn(self) -> None:
        with patch.dict(
            os.environ,
            {"FAKE_MCODE_STATUS": "cancelled", "FAKE_MCODE_NO_MODEL": "1"},
            clear=False,
        ):
            with self.assertRaises(AgentLordError) as raised:
                self.lord.start("cancel-resume", "mcode", str(self.target), "cancel", model=self.model())
        self.assertEqual("PROVIDER_FAILED", raised.exception.code)
        resumed = self.lord.turn("cancel-resume", "continue")
        self.assertEqual("SUCCEEDED", resumed["status"])
        self.assertEqual("mvs_test_session", resumed["endpoint_id"])
        arguments = self._arguments()
        self.assertEqual("mvs_test_session", arguments[-1][arguments[-1].index("--session") + 1])

    def test_missing_exit_code_cannot_turn_terminal_text_into_success(self) -> None:
        session_id = "mvs_exit_unknown"
        model = self.model()
        events = self._success_events(session_id, "run-a", "turn-a", model, "answer")
        with self.assertRaises(AgentLordError) as raised:
            _validate_provider_output(
                "\n".join(json.dumps(event) for event in events) + "\n",
                "",
                "answer",
                20,
                10,
                None,
                None,
                None,
                False,
                model,
                False,
                None,
                None,
            )
        self.assertEqual("DELIVERY_UNKNOWN", raised.exception.code)

    @staticmethod
    def _success_events(session_id: str, run_id: str, turn_id: str, model_literal: str, output: str):
        provider_id, model_id = model_literal.split("/", 1)
        model = {"providerId": provider_id, "modelId": model_id}
        base = {"schemaVersion": 1, "timestampMs": 1, "runId": run_id, "sessionId": session_id, "turnId": turn_id}
        result = dict(base, type="exec.result", status="succeeded", output=output, model=model, durationMs=1)
        return [
            dict(base, sequence=1, type="exec.started"),
            dict(base, sequence=2, type="session.started"),
            dict(base, sequence=3, type="turn.started"),
            dict(base, sequence=4, type="turn.completed", model=model, durationMs=1),
            dict(base, sequence=5, type="exec.completed", result=result),
        ]

    def _create_orphan_operation(self, *, pid: int | None, terminal: bool, task_id: str) -> str:
        operation_id = task_id + "-start-orphan"
        session_id = "mvs_" + task_id.replace("-", "_")
        run_id = "exec_" + task_id
        turn_id = "turn_" + task_id
        stdout_path = self.root / "logs" / (operation_id + ".stdout")
        stderr_path = self.root / "logs" / (operation_id + ".stderr")
        result_path = self.root / "logs" / (operation_id + ".final")
        stdout_path.parent.mkdir(parents=True, exist_ok=True)
        events = self._success_events(session_id, run_id, turn_id, self.model(), "answer")
        if not terminal:
            events = events[:3]
        stdout_path.write_text("\n".join(json.dumps(event) for event in events) + "\n", encoding="utf-8")
        stderr_path.write_text("", encoding="utf-8")
        if terminal:
            result_path.write_text("answer", encoding="utf-8")
        now = utc_now()
        active = {
            "controller_pid": 99999999,
            "pid": pid,
            "process_group_id": pid if os.name == "posix" else None,
            "prompt_delivery": "stdin-attached",
            "stdout_path": str(stdout_path),
            "stderr_path": str(stderr_path),
            "result_path": str(result_path),
            "result_reset_at_ns": 1,
            "progress_seq": 3,
        }
        create_operation(
            {
                "version": 1,
                "operation_id": operation_id,
                "task_id": task_id,
                "provider": "mcode-cli",
                "kind": "start",
                "target": str(self.target),
                "status": "running",
                "message": "run",
                "message_sha256": "0" * 64,
                "expected": {
                    "model": self.model(),
                    "effort": None,
                    "permission_mode": "dangerously_bypass",
                    "permission_enforcement": "mcode-permission-full-argument",
                    "retry_plan": [{"model": self.model(), "attempts": 1}],
                },
                "observed": {"supervision": {"state": "provider_wait", "progress_seq": 3}},
                "source": {},
                "read_only": False,
                "workspace": {"policy": "exact-target"},
                "parallel_plan": {},
                "artifact": None,
                "error": None,
                "controller_pid": 99999999,
                "pid": pid,
                "endpoint_id": session_id,
                "resume": False,
                "provider_command": ["mcode", "exec"],
                "stdout_path": str(stdout_path),
                "stderr_path": str(stderr_path),
                "result_path": str(result_path),
                "result_reset_at_ns": 1,
                "active_attempt": active,
                "dead_process_observed_at_ms": int(time.time() * 1000) - 10_000,
                "created_at": now,
                "updated_at": now,
            },
            self.root,
        )
        return operation_id

    def test_checkpoint_fences_only_the_orphan_operation_group(self) -> None:
        if os.name != "posix":
            self.skipTest("process-group ownership is POSIX-specific")
        group_file = self.base / "owned-group.txt"
        result_path = self.root / "logs" / "mcode-orphan-start-orphan.final"
        launcher_environment = dict(os.environ, GROUP_FILE=str(group_file), RESULT_FILE=str(result_path))
        launcher = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import os, subprocess, sys; from pathlib import Path; "
                    "p=subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)', "
                    "'--output-last-message', os.environ['RESULT_FILE']], start_new_session=True); "
                    "Path(os.environ['GROUP_FILE']).write_text(str(p.pid))"
                ),
            ],
            env=launcher_environment,
        )
        launcher.wait(timeout=3)
        child_pid = int(group_file.read_text(encoding="utf-8"))
        group_pid = child_pid
        unrelated = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)"],
            start_new_session=os.name == "posix",
        )
        try:
            self._create_orphan_operation(pid=group_pid, terminal=False, task_id="mcode-orphan")
            result, quiet = self.lord.checkpoint(["mcode-orphan"], 1)
            envelope = result["actionable"][0]
            self.assertFalse(quiet)
            self.assertEqual("NEEDS_DECISION", envelope["status"])
            self.assertEqual("DELIVERY_UNKNOWN", envelope["error"]["code"])
            with self.assertRaises(ProcessLookupError):
                os.kill(child_pid, 0)
            self.assertIsNone(unrelated.poll())
            self.assertEqual("mvs_mcode_orphan", load_task("mcode-orphan", self.root)["endpoint_id"])
        finally:
            try:
                os.killpg(group_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            if unrelated.poll() is None:
                unrelated.terminate()
            unrelated.wait(timeout=3)

    def test_checkpoint_never_recovers_success_without_durable_exit_code(self) -> None:
        self._create_orphan_operation(pid=None, terminal=True, task_id="exit-unknown")
        result, quiet = self.lord.checkpoint(["exit-unknown"], 1)
        envelope = result["actionable"][0]
        self.assertFalse(quiet)
        self.assertEqual("NEEDS_DECISION", envelope["status"])
        self.assertEqual("DELIVERY_UNKNOWN", envelope["error"]["code"])

    def _packet(self, task_id: str):
        packet = {
            "schema": "handoff-v1",
            "handoff_id": "handoff-mcode-test",
            "created_at": "2026-09-08T00:00:00+00:00",
            "source_session": {"kind": "codex-desktop"},
            "continuation": {"task_id": task_id},
            "authorization": {"task": "continue", "workspace_writes": True, "external_writes": False},
            "objective": "continue",
            "completed_work": [],
            "remaining_work": ["finish"],
            "constraints": [],
            "acceptance_criteria": ["done"],
            "evidence": [],
            "contract_request": {"provider": "mcode-cli", "model": self.model()},
            "sanitization": {"raw_provider_logs": False, "hidden_reasoning": False, "secrets": False},
        }
        packet["integrity"] = {"sha256": __import__("hashlib").sha256(canonical_packet_bytes(packet)).hexdigest()}
        path = self.base / (task_id + ".json")
        path.write_text(json.dumps(packet), encoding="utf-8")
        return path

    def test_handoff_supports_mcode_and_preserves_new_endpoint_lineage(self) -> None:
        subprocess.run(["git", "init", "-q", str(self.target)], check=True)
        subprocess.run(["git", "-C", str(self.target), "config", "user.name", "Test"], check=True)
        subprocess.run(["git", "-C", str(self.target), "config", "user.email", "test@example.invalid"], check=True)
        (self.target / "tracked.txt").write_text("test\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(self.target), "add", "tracked.txt"], check=True)
        subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "-C", str(self.target), "commit", "-q", "-m", "test"],
            check=True,
        )
        result = self.lord.handoff(
            "mcode-handoff",
            str(self._packet("mcode-handoff")),
            target=str(self.target),
        )
        self.assertEqual("SUCCEEDED", result["status"])
        self.assertEqual("mcode-cli", result["provider"])
        self.assertEqual("continues_user_task", load_task("mcode-handoff", self.root)["lineage"]["relationship"])

    def test_mcode_export_is_explicitly_refused_without_invalidating_success(self) -> None:
        result = self.lord.start("no-export", "mcode", str(self.target), "run", model=self.model())
        operation_id = result["operation_id"]
        with self.assertRaises(AgentLordError) as raised:
            self.lord.export_artifact("no-export", operation_id, str(self.root / "logs" / (operation_id + ".stdout")), "mcode-stream-json")
        self.assertEqual("CONFIG_INVALID", raised.exception.code)
        self.assertEqual("succeeded", load_operation(operation_id, self.root)["status"])

    def test_cli_and_compatibility_surfaces_accept_mcode_alias(self) -> None:
        parsed = build_parser().parse_args(
            ["start", "--task-id", "t", "--provider", "mcode", "--target", str(self.target), "--message-file", "m", "--model", self.model()]
        )
        self.assertEqual("mcode", parsed.provider)
        task = put_task(
            Namespace(
                task_id="registered-mcode",
                provider="mcode",
                endpoint_id="mvs_registered",
                host_id=None,
                target=str(self.target),
                model=self.model(),
                effort=None,
                retry_attempts=None,
                read_only=False,
            )
        )
        self.assertEqual("mcode-cli", task["provider"])
        self.assertEqual("dangerously_bypass", task["contract"]["permission_mode"])
        for field, value in (("model", None), ("effort", "high"), ("read_only", True)):
            invalid = json.loads(json.dumps(task))
            invalid["contract"][field] = value
            with self.subTest(field=field), self.assertRaises(AgentLordError) as raised:
                normalize_task(invalid)
            self.assertEqual("STATE_CORRUPT", raised.exception.code)


if __name__ == "__main__":
    unittest.main()
