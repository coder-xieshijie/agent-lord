from __future__ import annotations

from argparse import Namespace
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
from threading import Event
import time
import unittest
from unittest.mock import patch


from agent_lord import AgentLord, AgentLordError
from agent_lord.codex_adapter import operation_marker
from agent_lord.config import DEFAULT_CONFIG, control_config, expected_model_matches
from agent_lord.state import create_operation, load_operation, load_task, utc_now
from scripts.agent_lord import build_parser
from scripts.task_store import upgrade as upgrade_task


FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json
import os
import sys

args = sys.argv[1:]
log = os.environ.get("FAKE_CLAUDE_ARGV_LOG")
if log:
    with open(log, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(args) + "\n")
session_id = args[args.index("--resume") + 1] if "--resume" in args else args[args.index("--session-id") + 1]
if os.environ.get("FAKE_CLAUDE_DIAGNOSTIC"):
    print(os.environ["FAKE_CLAUDE_DIAGNOSTIC"])
requested_model = args[args.index("--model") + 1] if "--model" in args else "opus"
model = os.environ.get("FAKE_CLAUDE_MODEL") or (requested_model if requested_model.startswith("claude-") else "claude-" + requested_model + "-5")
message = sys.stdin.read().strip()
counter_path = os.environ.get("FAKE_CLAUDE_COUNTER")
attempt = 1
if counter_path:
    try:
        with open(counter_path, "r", encoding="utf-8") as handle:
            attempt = int(handle.read()) + 1
    except (FileNotFoundError, ValueError):
        attempt = 1
    with open(counter_path, "w", encoding="utf-8") as handle:
        handle.write(str(attempt))
failures = int(os.environ.get("FAKE_CLAUDE_FAILURES", "0"))
print(json.dumps({
    "type": "result",
    "session_id": session_id,
    "is_error": attempt <= failures,
    "result": ("failed attempt " + str(attempt)) if attempt <= failures else ("final: " + message),
    "modelUsage": {model: {"inputTokens": 1, "outputTokens": 1}}
}))
'''


FAKE_CODEX = r'''#!/usr/bin/env python3
import json
import os
import re
import sys

args = sys.argv[1:]
log = os.environ.get("FAKE_CODEX_ARGV_LOG")
if log:
    with open(log, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(args) + "\n")
session_id = os.environ.get("FAKE_CODEX_SESSION_ID", "0199a213-81c0-7800-8aa1-bbab2a035a53")
for argument in args:
    if re.fullmatch(r"[0-9a-f]{8}-[0-9a-f-]{27,}", argument):
        session_id = argument
result_path = args[args.index("--output-last-message") + 1]
sys.stdin.read()
with open(result_path, "w", encoding="utf-8") as handle:
    handle.write("codex final\n")
print(json.dumps({"type": "thread.started", "thread_id": session_id}))
print(json.dumps({"type": "turn.started"}))
print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "codex final"}}))
print(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}}))
'''


class ClaudeAttemptResultTests(unittest.TestCase):
    def test_valid_fable_result_with_auto_mode_failure_succeeds_with_warning(self) -> None:
        from agent_lord.claude_attempt_result import evaluate_claude_attempt

        session_id = "4fd57d1b-7b36-4dcd-a900-b90a65ffc538"
        stdout = "\n".join(
            [
                json.dumps(
                    {
                        "type": "system",
                        "subtype": "init",
                        "session_id": session_id,
                        "model": "claude-fable-5",
                    }
                ),
                json.dumps(
                    {
                        "type": "assistant",
                        "session_id": session_id,
                        "message": {"model": "claude-fable-5", "content": []},
                    }
                ),
                json.dumps(
                    {
                        "type": "result",
                        "subtype": "success",
                        "session_id": session_id,
                        "is_error": False,
                        "result": "audit complete",
                        "modelUsage": {"claude-fable-5": {"inputTokens": 1, "outputTokens": 1}},
                    }
                ),
            ]
        )
        stderr = '[claude-code:unrecognized_model] {"model":"qw-mid-5","query_source":"auto_mode"}\n'

        evaluation = evaluate_claude_attempt(
            stdout,
            stderr,
            session_id=session_id,
            expected_model="fable",
            return_code=0,
        )

        self.assertEqual("claude-fable-5", evaluation.main_model)
        self.assertTrue(evaluation.main_model_verified)
        self.assertEqual("auto_mode", evaluation.auxiliary_models[0].source)
        self.assertEqual("qw-mid-5", evaluation.auxiliary_models[0].model)
        self.assertEqual("AUXILIARY_MODEL_UNRECOGNIZED", evaluation.warnings[0].code)


class AgentLordTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "state"
        self.target = Path(self.temporary.name) / "repo"
        self.target.mkdir()
        self.fake_claude = Path(self.temporary.name) / "fake-claude"
        self.fake_claude.write_text(FAKE_CLAUDE, encoding="utf-8")
        self.fake_claude.chmod(self.fake_claude.stat().st_mode | stat.S_IXUSR)
        self.argv_log = Path(self.temporary.name) / "claude-argv.jsonl"
        self.claude_counter = Path(self.temporary.name) / "claude-counter.txt"
        self.fake_codex = Path(self.temporary.name) / "fake-codex"
        self.fake_codex.write_text(FAKE_CODEX, encoding="utf-8")
        self.fake_codex.chmod(self.fake_codex.stat().st_mode | stat.S_IXUSR)
        self.codex_argv_log = Path(self.temporary.name) / "codex-argv.jsonl"
        self.environment = patch.dict(
            os.environ,
            {
                "AGENT_LORD_STATE_DIR": str(self.root),
                "AGENT_LORD_CLAUDE_BIN": str(self.fake_claude),
                "FAKE_CLAUDE_ARGV_LOG": str(self.argv_log),
                "FAKE_CLAUDE_MODEL": "claude-opus-5",
                "FAKE_CLAUDE_COUNTER": str(self.claude_counter),
                "AGENT_LORD_CODEX_BIN": str(self.fake_codex),
                "FAKE_CODEX_ARGV_LOG": str(self.codex_argv_log),
            },
            clear=False,
        )
        self.environment.start()
        self.lord = AgentLord(self.root)

    def tearDown(self) -> None:
        self.environment.stop()
        self.temporary.cleanup()

    def _complete_codex_start(self, task_id: str = "codex-task"):
        start = self.lord.start(
            task_id,
            "codex-app",
            "project-1",
            "independent review",
            model="gpt-5.6-sol",
            effort="xhigh",
            read_only=True,
        )
        accepted = self.lord.accept(
            start["action"]["action_id"],
            {"threadId": "thread-1", "hostId": "old-host"},
        )
        self.assertEqual("RUNNING", accepted["status"])
        check = self.lord.check(task_id)
        operation_id = start["operation_id"]
        read_result = {
            "thread": {"threadId": "thread-1", "hostId": "old-host", "status": "idle"},
            "turns": [
                {
                    "items": [
                        {"role": "user", "content": [{"type": "text", "text": operation_marker(operation_id)}]},
                        {"role": "assistant", "content": [{"type": "text", "text": "initial report"}]},
                    ]
                }
            ],
        }
        complete = self.lord.accept(check["action"]["action_id"], read_result)
        self.assertEqual("SUCCEEDED", complete["status"])
        return complete

    def test_claude_turn_reapplies_saved_model_and_effort(self) -> None:
        start = self.lord.start(
            "claude-task",
            "claude-cli",
            str(self.target),
            "first",
            model="opus",
            effort="xhigh",
            read_only=True,
        )
        self.assertEqual("SUCCEEDED", start["status"])
        endpoint_id = start["endpoint_id"]

        turn = self.lord.turn("claude-task", "second")
        self.assertEqual("SUCCEEDED", turn["status"])
        self.assertEqual(endpoint_id, turn["endpoint_id"])

        invocations = [json.loads(line) for line in self.argv_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(2, len(invocations))
        for arguments in invocations:
            self.assertIn("--model", arguments)
            self.assertEqual("opus", arguments[arguments.index("--model") + 1])
            self.assertIn("--effort", arguments)
            self.assertEqual("xhigh", arguments[arguments.index("--effort") + 1])
            self.assertEqual("plan", arguments[arguments.index("--permission-mode") + 1])
        self.assertEqual(endpoint_id, invocations[1][invocations[1].index("--resume") + 1])

    def test_claude_defaults_to_opus_xhigh_and_five_attempts(self) -> None:
        result = self.lord.start("claude-defaults", "claude-cli", str(self.target), "review")

        self.assertEqual("SUCCEEDED", result["status"])
        self.assertEqual("claude-opus-5", result["expected"]["model"])
        self.assertEqual("xhigh", result["expected"]["effort"])
        self.assertEqual([{"model": "claude-opus-5", "attempts": 5}], result["expected"]["retry_plan"])
        arguments = json.loads(self.argv_log.read_text(encoding="utf-8").splitlines()[0])
        self.assertEqual("claude-opus-5", arguments[arguments.index("--model") + 1])
        self.assertEqual("xhigh", arguments[arguments.index("--effort") + 1])

    def test_claude_model_only_defaults_effort_to_xhigh(self) -> None:
        with patch.dict(os.environ, {"FAKE_CLAUDE_MODEL": "claude-sonnet-5"}, clear=False):
            result = self.lord.start(
                "claude-model-only",
                "claude-cli",
                str(self.target),
                "review",
                model="sonnet",
            )

        self.assertEqual("SUCCEEDED", result["status"])
        self.assertEqual("sonnet", result["expected"]["model"])
        self.assertEqual("xhigh", result["expected"]["effort"])

    def test_claude_full_model_contract_accepts_a_versioned_provider_id(self) -> None:
        self.assertTrue(expected_model_matches("claude-opus-5", "claude-opus-5-20260801"))
        self.assertFalse(expected_model_matches("claude-opus-5", "claude-opus-4-20260801"))

    def test_claude_retries_primary_model_up_to_five_attempts(self) -> None:
        with patch.dict(os.environ, {"FAKE_CLAUDE_FAILURES": "4"}, clear=False):
            result = self.lord.start("claude-retry", "claude-cli", str(self.target), "review")

        invocations = [json.loads(line) for line in self.argv_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual("SUCCEEDED", result["status"])
        self.assertEqual(5, len(invocations))
        self.assertEqual(5, result["observed"]["attempts"])
        self.assertTrue(all(arguments[arguments.index("--model") + 1] == "claude-opus-5" for arguments in invocations))

    def test_claude_fable_falls_back_to_opus_after_five_failures(self) -> None:
        with patch.dict(os.environ, {"FAKE_CLAUDE_FAILURES": "5"}, clear=False):
            result = self.lord.start(
                "claude-fable-fallback",
                "claude-cli",
                str(self.target),
                "review",
                model="fable",
            )

        invocations = [json.loads(line) for line in self.argv_log.read_text(encoding="utf-8").splitlines()]
        models = [arguments[arguments.index("--model") + 1] for arguments in invocations]
        self.assertEqual("SUCCEEDED", result["status"])
        self.assertEqual(["fable"] * 5 + ["claude-opus-5"], models)
        self.assertEqual(
            [{"model": "fable", "attempts": 5}, {"model": "claude-opus-5", "attempts": 5}],
            result["expected"]["retry_plan"],
        )
        self.assertTrue(result["observed"]["fallback_used"])

    def test_claude_fable_is_terminal_only_after_both_five_attempt_stages_fail(self) -> None:
        with patch.dict(os.environ, {"FAKE_CLAUDE_FAILURES": "10"}, clear=False):
            with self.assertRaises(AgentLordError) as raised:
                self.lord.start(
                    "claude-fable-exhausted",
                    "claude-cli",
                    str(self.target),
                    "review",
                    model="fable",
                )

        invocations = [json.loads(line) for line in self.argv_log.read_text(encoding="utf-8").splitlines()]
        models = [arguments[arguments.index("--model") + 1] for arguments in invocations]
        sessions = [
            arguments[arguments.index("--resume") + 1]
            if "--resume" in arguments
            else arguments[arguments.index("--session-id") + 1]
            for arguments in invocations
        ]
        self.assertEqual(["fable"] * 5 + ["claude-opus-5"] * 5, models)
        self.assertEqual(1, len(set(sessions)))
        self.assertFalse(raised.exception.retryable)
        self.assertTrue(raised.exception.details["retry_exhausted"])
        self.assertEqual(10, len(raised.exception.details["attempts"]))

    def test_claude_retry_attempt_override_changes_only_primary_stage(self) -> None:
        with patch.dict(os.environ, {"FAKE_CLAUDE_FAILURES": "2"}, clear=False):
            result = self.lord.start(
                "claude-fable-retry-override",
                "claude-cli",
                str(self.target),
                "review",
                model="fable",
                retry_attempts=2,
            )

        self.assertEqual(
            [{"model": "fable", "attempts": 2}, {"model": "claude-opus-5", "attempts": 5}],
            result["expected"]["retry_plan"],
        )
        invocations = [json.loads(line) for line in self.argv_log.read_text(encoding="utf-8").splitlines()]
        models = [arguments[arguments.index("--model") + 1] for arguments in invocations]
        self.assertEqual(["fable", "fable", "claude-opus-5"], models)

    def test_claude_reports_real_failure_after_retry_budget_exhausted(self) -> None:
        with patch.dict(os.environ, {"FAKE_CLAUDE_FAILURES": "10"}, clear=False):
            with self.assertRaises(AgentLordError) as raised:
                self.lord.start("claude-exhausted", "claude-cli", str(self.target), "review")

        invocations = [json.loads(line) for line in self.argv_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(5, len(invocations))
        self.assertEqual("PROVIDER_FAILED", raised.exception.code)
        self.assertFalse(raised.exception.retryable)
        self.assertTrue(raised.exception.details["retry_exhausted"])
        self.assertEqual(5, len(raised.exception.details["attempts"]))

    def test_codex_alias_defaults_to_cli_sol_xhigh_and_resumes_same_session(self) -> None:
        start = self.lord.start("codex-cli-default", "codex", str(self.target), "review")
        turn = self.lord.turn("codex-cli-default", "continue")

        self.assertEqual("SUCCEEDED", start["status"])
        self.assertEqual("codex-cli", start["provider"])
        self.assertEqual("gpt-5.6-sol", start["expected"]["model"])
        self.assertEqual("xhigh", start["expected"]["effort"])
        self.assertEqual(start["endpoint_id"], turn["endpoint_id"])
        invocations = [json.loads(line) for line in self.codex_argv_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(2, len(invocations))
        for arguments in invocations:
            self.assertEqual("gpt-5.6-sol", arguments[arguments.index("--model") + 1])
            self.assertIn('model_reasoning_effort="xhigh"', arguments)
            self.assertIn("--dangerously-bypass-approvals-and-sandbox", arguments)
        self.assertEqual("exec", invocations[0][0])
        self.assertEqual("resume", invocations[1][1])
        self.assertIn(start["endpoint_id"], invocations[1])

    def test_codex_cli_read_only_is_enforced_by_config_arguments(self) -> None:
        result = self.lord.start(
            "codex-cli-read-only",
            "codex",
            str(self.target),
            "review",
            read_only=True,
        )

        arguments = json.loads(self.codex_argv_log.read_text(encoding="utf-8").splitlines()[0])
        self.assertEqual("SUCCEEDED", result["status"])
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", arguments)
        self.assertIn('sandbox_mode="read-only"', arguments)
        self.assertIn('approval_policy="never"', arguments)
        self.assertEqual("config-argument-enforced", result["observed"]["permission_enforcement"])

    def test_retry_attempt_override_is_rejected_for_codex(self) -> None:
        with self.assertRaises(AgentLordError) as raised:
            self.lord.start(
                "codex-cli-retry-override",
                "codex",
                str(self.target),
                "review",
                retry_attempts=2,
            )

        self.assertEqual("CONFIG_INVALID", raised.exception.code)

    def test_default_permission_policy_bypasses_claude_checks(self) -> None:
        start = self.lord.start(
            "claude-bypass",
            "claude-cli",
            str(self.target),
            "review",
            model="opus",
            effort="xhigh",
        )
        turn = self.lord.turn("claude-bypass", "cross review")

        self.assertEqual("SUCCEEDED", start["status"])
        self.assertEqual("SUCCEEDED", turn["status"])
        invocations = [json.loads(line) for line in self.argv_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(2, len(invocations))
        for arguments in invocations:
            self.assertIn("--dangerously-skip-permissions", arguments)
            self.assertNotIn("--permission-mode", arguments)
        self.assertEqual("dangerously_bypass", turn["expected"]["permission_mode"])
        self.assertEqual("argument-enforced", turn["observed"]["permission_enforcement"])

    def test_saved_permission_mode_survives_a_default_selector_change(self) -> None:
        config_path = Path(self.temporary.name) / "providers.json"
        config = json.loads(DEFAULT_CONFIG.read_text(encoding="utf-8"))
        config_path.write_text(json.dumps(config), encoding="utf-8")

        with patch.dict(os.environ, {"AGENT_LORD_PROVIDER_CONFIG": str(config_path)}, clear=False):
            self.lord.start("permission-frozen", "claude-cli", str(self.target), "review")
            config["providers"]["claude-cli"]["permissions"]["default"] = "read_only"
            config_path.write_text(json.dumps(config), encoding="utf-8")
            turn = self.lord.turn("permission-frozen", "continue")

        invocations = [json.loads(line) for line in self.argv_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(2, len(invocations))
        self.assertTrue(all("--dangerously-skip-permissions" in arguments for arguments in invocations))
        self.assertEqual("dangerously_bypass", turn["expected"]["permission_mode"])

    def test_codex_default_permission_is_recorded_as_host_inherited(self) -> None:
        start = self.lord.start("codex-bypass", "codex-app", "project-1", "review")

        self.assertEqual("dangerously_bypass", start["expected"]["permission_mode"])
        self.assertEqual("host-inherited-unverified", start["expected"]["permission_enforcement"])
        self.assertNotIn("permission", start["action"]["arguments"])
        self.assertNotIn("sandbox", start["action"]["arguments"])

    def test_checkpoint_default_is_150_seconds(self) -> None:
        self.assertEqual(150, control_config()["checkpoint_seconds"])
        args = build_parser().parse_args(["checkpoint"])
        self.assertEqual(150, args.seconds)

    def test_claude_model_mismatch_fails_closed_without_task_handle(self) -> None:
        with patch.dict(os.environ, {"FAKE_CLAUDE_MODEL": "claude-sonnet-5"}, clear=False):
            with self.assertRaises(AgentLordError) as raised:
                self.lord.start(
                    "wrong-model",
                    "claude-cli",
                    str(self.target),
                    "review",
                    model="opus",
                    effort="xhigh",
                )
        self.assertEqual("MODEL_MISMATCH", raised.exception.code)
        self.assertFalse((self.root / "wrong-model.json").exists())

    def test_claude_fixed_head_mismatch_fails_before_dispatch(self) -> None:
        subprocess.run(["git", "init", "-q", str(self.target)], check=True)
        subprocess.run(["git", "-C", str(self.target), "config", "user.name", "Agent Lord Test"], check=True)
        subprocess.run(["git", "-C", str(self.target), "config", "user.email", "agent-lord@example.invalid"], check=True)
        (self.target / "tracked.txt").write_text("source\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(self.target), "add", "tracked.txt"], check=True)
        subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "-C", str(self.target), "commit", "-q", "-m", "test source"],
            check=True,
        )

        with self.assertRaises(AgentLordError) as raised:
            self.lord.start(
                "source-mismatch",
                "claude-cli",
                str(self.target),
                "review",
                model="opus",
                effort="xhigh",
                head_sha="0" * 40,
            )

        self.assertEqual("SOURCE_MISMATCH", raised.exception.code)
        self.assertFalse(any((self.root / "operations").glob("*.json")))

    def test_claude_parser_tolerates_diagnostic_before_result(self) -> None:
        with patch.dict(os.environ, {"FAKE_CLAUDE_DIAGNOSTIC": "provider: warming route"}, clear=False):
            result = self.lord.start(
                "diagnostic",
                "claude-cli",
                str(self.target),
                "review",
                model="opus",
                effort="high",
            )
        self.assertEqual("SUCCEEDED", result["status"])
        artifact = Path(result["artifact"]["path"]).read_text(encoding="utf-8")
        self.assertEqual("final: review\n", artifact)

    def test_unrecognized_model_diagnostic_is_classified(self) -> None:
        with patch.dict(
            os.environ,
            {"FAKE_CLAUDE_DIAGNOSTIC": '[claude-code:unrecognized_model] {"model":"qw-mid-5"}'},
            clear=False,
        ):
            with self.assertRaises(AgentLordError) as raised:
                self.lord.start(
                    "unrecognized",
                    "claude-cli",
                    str(self.target),
                    "review",
                    model="opus",
                    effort="xhigh",
                )
        self.assertEqual("MODEL_UNRECOGNIZED", raised.exception.code)

    def test_codex_route_stale_rebinds_same_thread_and_resends_same_operation(self) -> None:
        self._complete_codex_start()
        turn = self.lord.turn("codex-task", "cross review")
        original_action = turn["action"]
        stale = self.lord.accept(
            original_action["action_id"],
            "No AppServerManager registered for hostId: old-host",
        )
        self.assertEqual("ACTION_REQUIRED", stale["status"])
        self.assertEqual("codex_app__list_threads", stale["action"]["tool"])
        self.assertEqual({"limit": 50}, stale["action"]["arguments"])
        self.assertNotIn("query", stale["action"]["arguments"])

        rebound = self.lord.accept(
            stale["action"]["action_id"],
            {"recentThreads": [{"id": "thread-1", "hostId": "local", "status": "idle"}]},
        )
        self.assertEqual("ACTION_REQUIRED", rebound["status"])
        self.assertEqual("codex_app__send_message_to_thread", rebound["action"]["tool"])
        self.assertEqual("thread-1", rebound["action"]["arguments"]["threadId"])
        self.assertEqual("local", rebound["action"]["arguments"]["hostId"])
        self.assertIn("read_only=true", rebound["action"]["arguments"]["prompt"])
        self.assertEqual(turn["operation_id"], rebound["operation_id"])
        self.assertEqual(original_action["arguments"]["prompt"], rebound["action"]["arguments"]["prompt"])

        task = load_task("codex-task", self.root)
        self.assertEqual("thread-1", task["endpoint_id"])
        self.assertEqual("local", task["route"]["host_id"])
        self.assertEqual("old-host", task["route"]["history"][0]["host_id"])

    def test_pending_codex_turn_is_idempotent_by_message_hash(self) -> None:
        self._complete_codex_start()
        first = self.lord.turn("codex-task", "same message")
        second = self.lord.turn("codex-task", "same message")
        self.assertEqual(first["operation_id"], second["operation_id"])
        self.assertEqual(first["action"]["action_id"], second["action"]["action_id"])
        self.assertEqual(1, len([a for a in (self.root / "actions").glob("*.json") if first["operation_id"] in a.name]))

    def test_dispatch_lock_prevents_two_concurrent_starts(self) -> None:
        entered = Event()
        release = Event()
        original = self.lord._new_operation

        def slow_new_operation(*args, **kwargs):
            operation = original(*args, **kwargs)
            entered.set()
            release.wait(5)
            return operation

        with patch.object(self.lord, "_new_operation", side_effect=slow_new_operation):
            with ThreadPoolExecutor(max_workers=1) as executor:
                first = executor.submit(self.lord.start, "concurrent", "codex-app", "project-1", "review")
                self.assertTrue(entered.wait(2))
                with self.assertRaises(AgentLordError) as raised:
                    self.lord.start("concurrent", "codex-app", "project-1", "different review")
                self.assertEqual("STATE_BUSY", raised.exception.code)
                release.set()
                result = first.result(timeout=2)

        self.assertEqual("ACTION_REQUIRED", result["status"])
        self.assertEqual(1, len(list((self.root / "operations").glob("*.json"))))
        self.assertEqual(1, len(list((self.root / "actions").glob("*.json"))))

    def test_codex_timeout_checks_delivery_before_resend(self) -> None:
        self._complete_codex_start()
        turn = self.lord.turn("codex-task", "ambiguous delivery")
        checking = self.lord.accept(turn["action"]["action_id"], "request timed out")
        self.assertEqual("ACTION_REQUIRED", checking["status"])
        self.assertEqual("DELIVERY_UNKNOWN", checking["error"]["code"])
        self.assertEqual("codex_app__read_thread", checking["action"]["tool"])

        unresolved = self.lord.accept(
            checking["action"]["action_id"],
            {"thread": {"threadId": "thread-1", "hostId": "old-host", "status": "idle"}},
        )
        self.assertEqual("NEEDS_DECISION", unresolved["status"])
        self.assertEqual("DELIVERY_UNKNOWN", unresolved["error"]["code"])
        self.assertTrue(unresolved["error"]["requires_authorization"])

    def test_checkpoint_returns_pending_action_without_waiting(self) -> None:
        start = self.lord.start("pending", "codex-app", "project-1", "review")
        before = time.monotonic()
        result, quiet = self.lord.checkpoint(["pending"], 30)
        elapsed = time.monotonic() - before
        self.assertFalse(quiet)
        self.assertLess(elapsed, 1.0)
        self.assertEqual(start["action"]["action_id"], result["action"]["action_id"])

    def test_checkpoint_reports_quiet_running_task_without_endpoint(self) -> None:
        now = utc_now()
        create_operation(
            {
                "version": 1,
                "operation_id": "launch-running",
                "task_id": "launching",
                "provider": "claude-cli",
                "kind": "start",
                "target": str(self.target),
                "status": "running",
                "message": "review",
                "message_sha256": "0" * 64,
                "expected": {},
                "observed": {},
                "source": {},
                "read_only": True,
                "artifact": None,
                "error": None,
                "pid": os.getpid(),
                "created_at": now,
                "updated_at": now,
            },
            self.root,
        )
        result, quiet = self.lord.checkpoint(None, 1)
        self.assertTrue(quiet)
        self.assertEqual("CHECKPOINT_QUIET", result["status"])
        self.assertEqual("launch-running", result["active"][0]["operation_id"])

    def test_checkpoint_recovers_claude_result_after_controller_loss(self) -> None:
        stdout = self.root / "logs" / "recover.stdout"
        stderr = self.root / "logs" / "recover.stderr"
        stdout.parent.mkdir(parents=True, exist_ok=True)
        session_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        stdout.write_text(
            json.dumps(
                {
                    "type": "result",
                    "session_id": session_id,
                    "is_error": False,
                    "result": "recovered final",
                    "modelUsage": {"claude-opus-5": {"inputTokens": 1, "outputTokens": 1}},
                }
            )
            + "\n",
            encoding="utf-8",
        )
        stderr.write_text("", encoding="utf-8")
        now = utc_now()
        create_operation(
            {
                "version": 1,
                "operation_id": "recover-running",
                "task_id": "recover-task",
                "provider": "claude-cli",
                "kind": "start",
                "target": str(self.target),
                "status": "running",
                "message": "review",
                "message_sha256": "0" * 64,
                "expected": {"model": "opus", "effort": "xhigh"},
                "observed": {},
                "source": {},
                "read_only": True,
                "artifact": None,
                "error": None,
                "pid": 99999999,
                "endpoint_id": session_id,
                "resume": False,
                "provider_command": ["claude", "--session-id", session_id],
                "stdout_path": str(stdout),
                "stderr_path": str(stderr),
                "created_at": now,
                "updated_at": now,
            },
            self.root,
        )

        result, quiet = self.lord.checkpoint(None, 1)
        self.assertFalse(quiet)
        self.assertEqual("SUCCEEDED", result["status"])
        self.assertEqual(session_id, result["endpoint_id"])
        self.assertEqual("recovered final\n", Path(result["artifact"]["path"]).read_text(encoding="utf-8"))
        self.assertEqual("read_only", load_task("recover-task", self.root)["contract"]["permission_mode"])

    def test_artifact_export_selects_only_last_final_message(self) -> None:
        complete = self._complete_codex_start("artifact-task")
        source = Path(self.temporary.name) / "rollout.jsonl"
        source.write_text(
            "\n".join(
                [
                    json.dumps({"type": "response_item", "payload": {"type": "reasoning", "text": "secret reasoning"}}),
                    json.dumps({"type": "turn_context", "payload": {"model": "gpt-5.6-sol", "effort": "xhigh"}}),
                    json.dumps({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "old"}]}}),
                    json.dumps(
                        {
                            "type": "response_item",
                            "payload": {
                                "type": "message",
                                "role": "user",
                                "content": [
                                    {
                                        "type": "input_text",
                                        "text": operation_marker(complete["operation_id"]),
                                    }
                                ],
                            },
                        }
                    ),
                    json.dumps({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "canonical final"}]}}),
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        exported = self.lord.export_artifact(
            "artifact-task",
            complete["operation_id"],
            str(source),
            "codex-jsonl",
        )
        content = Path(exported["artifact"]["path"]).read_text(encoding="utf-8")
        self.assertEqual("canonical final\n", content)
        self.assertNotIn("reasoning", content)
        self.assertEqual(["gpt-5.6-sol"], exported["observed"]["models"])
        self.assertEqual("xhigh", exported["observed"]["effort"])

    def test_artifact_export_rejects_codex_model_drift(self) -> None:
        complete = self._complete_codex_start("drift-task")
        source = Path(self.temporary.name) / "drift.jsonl"
        source.write_text(
            "\n".join(
                [
                    json.dumps({"type": "turn_context", "payload": {"model": "gpt-5.6-terra", "effort": "xhigh"}}),
                    json.dumps(
                        {
                            "type": "response_item",
                            "payload": {
                                "type": "message",
                                "role": "user",
                                "content": [
                                    {
                                        "type": "input_text",
                                        "text": operation_marker(complete["operation_id"]),
                                    }
                                ],
                            },
                        }
                    ),
                    json.dumps({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "wrong model"}]}}),
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        with self.assertRaises(AgentLordError) as raised:
            self.lord.export_artifact("drift-task", complete["operation_id"], str(source), "codex-jsonl")
        self.assertEqual("MODEL_MISMATCH", raised.exception.code)
        failed = load_operation(complete["operation_id"], self.root)
        self.assertIsNone(failed["artifact"])
        self.assertEqual(complete["artifact"], failed["invalidated_artifact"])

    def test_artifact_export_rejects_unrelated_codex_turn(self) -> None:
        complete = self._complete_codex_start("unrelated-artifact")
        source = Path(self.temporary.name) / "unrelated.jsonl"
        source.write_text(
            "\n".join(
                [
                    json.dumps({"type": "turn_context", "payload": {"model": "gpt-5.6-sol", "effort": "xhigh"}}),
                    json.dumps(
                        {
                            "type": "response_item",
                            "payload": {
                                "type": "message",
                                "role": "user",
                                "content": [{"type": "input_text", "text": operation_marker("some-other-operation")}],
                            },
                        }
                    ),
                    json.dumps({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "unrelated final"}]}}),
                ]
            )
            + "\n",
            encoding="utf-8",
        )

        with self.assertRaises(AgentLordError) as raised:
            self.lord.export_artifact(
                "unrelated-artifact",
                complete["operation_id"],
                str(source),
                "codex-jsonl",
            )
        self.assertEqual("RESULT_INVALID", raised.exception.code)

    def test_artifact_export_rejects_unverified_effort(self) -> None:
        complete = self._complete_codex_start("effort-unverified")
        source = Path(self.temporary.name) / "effort-unverified.jsonl"
        source.write_text(
            "\n".join(
                [
                    json.dumps({"type": "turn_context", "payload": {"model": "gpt-5.6-sol"}}),
                    json.dumps(
                        {
                            "type": "response_item",
                            "payload": {
                                "type": "message",
                                "role": "user",
                                "content": [
                                    {"type": "input_text", "text": operation_marker(complete["operation_id"])}
                                ],
                            },
                        }
                    ),
                    json.dumps({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "unverified effort"}]}}),
                ]
            )
            + "\n",
            encoding="utf-8",
        )

        with self.assertRaises(AgentLordError) as raised:
            self.lord.export_artifact(
                "effort-unverified",
                complete["operation_id"],
                str(source),
                "codex-jsonl",
            )
        self.assertEqual("EFFORT_UNVERIFIED", raised.exception.code)

    def test_version_one_task_handle_is_read_compatibly(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "legacy.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "task_id": "legacy",
                    "provider": "codex-app",
                    "endpoint_id": "thread-legacy",
                    "host_id": "slingshot:old",
                    "target": "project-old",
                    "created_at": "2026-08-20T00:00:00+00:00",
                }
            ),
            encoding="utf-8",
        )
        task = load_task("legacy", self.root)
        self.assertEqual(2, task["version"])
        self.assertEqual("slingshot:old", task["route"]["host_id"])
        self.assertIsNone(task["contract"]["model"])

        with self.assertRaises(AgentLordError) as raised:
            self.lord.turn("legacy", "unsafe implicit continuation")
        self.assertEqual("EXECUTION_CONTRACT_REQUIRED", raised.exception.code)

        upgraded = upgrade_task(
            Namespace(
                task_id="legacy",
                model="gpt-5.6-sol",
                effort="xhigh",
                read_only=True,
                head_sha=None,
                base_sha=None,
            )
        )
        self.assertEqual(2, upgraded["version"])
        self.assertNotIn("legacy_version", upgraded)
        continued = self.lord.turn("legacy", "explicit continuation")
        self.assertEqual("ACTION_REQUIRED", continued["status"])
        self.assertEqual("gpt-5.6-sol", continued["action"]["arguments"]["model"])
        self.assertEqual("xhigh", continued["action"]["arguments"]["thinking"])

    def test_schemas_are_valid_json(self) -> None:
        schema_dir = Path(__file__).resolve().parent.parent / "schemas"
        for path in schema_dir.glob("*.json"):
            value = json.loads(path.read_text(encoding="utf-8"))
            self.assertIn("$schema", value)


if __name__ == "__main__":
    unittest.main()
