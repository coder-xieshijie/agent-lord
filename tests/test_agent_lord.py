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
from threading import Event
import time
import unittest
from unittest.mock import patch


from agent_lord import AgentLord, AgentLordError
from agent_lord.claude_adapter import terminate_claude_process
from agent_lord.codex_adapter import operation_marker
from agent_lord.config import DEFAULT_CONFIG, control_config, expected_model_matches
from agent_lord.state import create_operation, load_operation, load_task, record_lock, update_operation, utc_now
from scripts.agent_lord import build_parser
from scripts.task_store import upgrade as upgrade_task


FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json
import os
import sys
import time

args = sys.argv[1:]
log = os.environ.get("FAKE_CLAUDE_ARGV_LOG")
if log:
    with open(log, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(args) + "\n")
session_id = args[args.index("--resume") + 1] if "--resume" in args else args[args.index("--session-id") + 1]
if os.environ.get("FAKE_CLAUDE_DIAGNOSTIC"):
    diagnostic_stream = sys.stderr if os.environ.get("FAKE_CLAUDE_DIAGNOSTIC_STDERR") == "1" else sys.stdout
    print(os.environ["FAKE_CLAUDE_DIAGNOSTIC"], file=diagnostic_stream, flush=True)
    if os.environ.get("FAKE_CLAUDE_EXIT_AFTER_DIAGNOSTIC") == "1":
        sys.exit(1)
requested_model = args[args.index("--model") + 1] if "--model" in args else "opus"
model = os.environ.get("FAKE_CLAUDE_MODEL") or (requested_model if requested_model.startswith("claude-") else "claude-" + requested_model + "-5")
message = sys.stdin.read().strip()
prompt_log = os.environ.get("FAKE_CLAUDE_PROMPT_LOG")
if prompt_log:
    with open(prompt_log, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(message) + "\n")
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
silent_failures = int(os.environ.get("FAKE_CLAUDE_SILENT_FAILURES", "0"))
if attempt <= silent_failures:
    side_effect_log = os.environ.get("FAKE_CLAUDE_SIDE_EFFECT_LOG")
    if side_effect_log:
        with open(side_effect_log, "a", encoding="utf-8") as handle:
            handle.write("prompt-consumed\n")
    sys.exit(1)
stall_attempts = int(os.environ.get("FAKE_CLAUDE_STALL_ATTEMPTS", "0"))
if attempt <= stall_attempts:
    print(json.dumps({"type": "system", "subtype": "init", "session_id": session_id}), flush=True)
    time.sleep(60)
delay_seconds = float(os.environ.get("FAKE_CLAUDE_DELAY_SECONDS", "0"))
if delay_seconds:
    print(json.dumps({"type": "assistant", "session_id": session_id, "message": {"content": []}}), flush=True)
    time.sleep(delay_seconds)
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
        self.assertEqual(
            ("system.init.model", "assistant.message.model", "result.modelUsage"),
            evaluation.main_model_evidence,
        )
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
        self.claude_prompt_log = Path(self.temporary.name) / "claude-prompts.jsonl"
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
                "FAKE_CLAUDE_PROMPT_LOG": str(self.claude_prompt_log),
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

    def _create_running_operation(self, task_id: str, operation_id: str) -> None:
        now = utc_now()
        create_operation(
            {
                "version": 1,
                "operation_id": operation_id,
                "task_id": task_id,
                "provider": "claude-cli",
                "kind": "start",
                "target": str(self.target),
                "status": "running",
                "message": "review",
                "message_sha256": "0" * 64,
                "expected": {},
                "observed": {
                    "supervision": {
                        "state": "progressing",
                        "attempt": 1,
                        "progress_seq": 1,
                    }
                },
                "source": {},
                "read_only": True,
                "artifact": None,
                "error": None,
                "pid": os.getpid(),
                "active_attempt": {
                    "number": 1,
                    "controller_pid": os.getpid(),
                    "pid": os.getpid(),
                    "progress_state": "progressing",
                    "progress_seq": 1,
                },
                "created_at": now,
                "updated_at": now,
            },
            self.root,
        )

    def _single_checkpoint_action(self, result):
        self.assertEqual("CHECKPOINT_ACTIONABLE", result["status"])
        self.assertEqual(1, len(result["actionable"]))
        return result["actionable"][0]

    def test_record_lock_releases_when_holder_is_killed(self) -> None:
        repository = Path(__file__).resolve().parent.parent
        holder = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import sys,time; from pathlib import Path; "
                    "from agent_lord.state import record_lock; "
                    "root=Path(sys.argv[1]); "
                    "lock=record_lock('operation-control','crash-lock',root); "
                    "lock.__enter__(); print('locked',flush=True); time.sleep(60)"
                ),
                str(self.root),
            ],
            cwd=str(repository),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            self.assertEqual("locked", holder.stdout.readline().strip())
            holder.kill()
            holder.wait(timeout=2)
            with record_lock("operation-control", "crash-lock", self.root):
                pass
        finally:
            if holder.poll() is None:
                holder.kill()
                holder.wait(timeout=2)
            holder.stdout.close()
            holder.stderr.close()

    @unittest.skipUnless(os.name == "posix", "POSIX process-group fence")
    def test_process_fence_waits_for_child_after_leader_exits(self) -> None:
        leader = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import signal,subprocess,sys,time; "
                    "child=subprocess.Popen([sys.executable,'-c',"
                    "'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)']); "
                    "print(child.pid,flush=True); time.sleep(60)"
                ),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        child_pid = int(leader.stdout.readline().strip())
        try:
            time.sleep(0.1)
            terminate_claude_process(leader.pid, leader.pid, 1, leader)
            with self.assertRaises(OSError):
                os.killpg(leader.pid, 0)
        finally:
            try:
                os.killpg(leader.pid, signal.SIGKILL)
            except OSError:
                pass
            if leader.poll() is None:
                leader.kill()
            leader.wait(timeout=2)
            try:
                os.kill(child_pid, signal.SIGKILL)
            except OSError:
                pass
            leader.stdout.close()
            leader.stderr.close()

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

    def test_claude_defaults_to_opus_high_and_five_attempts(self) -> None:
        result = self.lord.start("claude-defaults", "claude-cli", str(self.target), "review")

        self.assertEqual("SUCCEEDED", result["status"])
        self.assertEqual("claude-opus-5", result["expected"]["model"])
        self.assertEqual("high", result["expected"]["effort"])
        self.assertEqual([{"model": "claude-opus-5", "attempts": 5}], result["expected"]["retry_plan"])
        arguments = json.loads(self.argv_log.read_text(encoding="utf-8").splitlines()[0])
        self.assertEqual("claude-opus-5", arguments[arguments.index("--model") + 1])
        self.assertEqual("high", arguments[arguments.index("--effort") + 1])

    def test_claude_model_only_defaults_effort_to_high(self) -> None:
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
        self.assertEqual("high", result["expected"]["effort"])

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

        prompts = [json.loads(line) for line in self.claude_prompt_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual("review", prompts[0])
        self.assertTrue(all("Continue the same task" in prompt for prompt in prompts[1:]))
        self.assertEqual(4, len({prompt.splitlines()[0] for prompt in prompts[1:]}))

    def test_claude_silent_failure_never_replays_a_possibly_delivered_prompt(self) -> None:
        side_effect_log = Path(self.temporary.name) / "side-effects.log"
        with patch.dict(
            os.environ,
            {
                "FAKE_CLAUDE_SILENT_FAILURES": "1",
                "FAKE_CLAUDE_SIDE_EFFECT_LOG": str(side_effect_log),
            },
            clear=False,
        ):
            result = self.lord.start(
                "claude-ambiguous-delivery",
                "claude-cli",
                str(self.target),
                "perform one external write",
                retry_attempts=2,
            )

        self.assertEqual("SUCCEEDED", result["status"])
        prompts = [json.loads(line) for line in self.claude_prompt_log.read_text(encoding="utf-8").splitlines()]
        invocations = [json.loads(line) for line in self.argv_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(["prompt-consumed"], side_effect_log.read_text(encoding="utf-8").splitlines())
        self.assertEqual("perform one external write", prompts[0])
        self.assertIn("Continue the same task", prompts[1])
        self.assertEqual(1, prompts.count("perform one external write"))
        self.assertIn("--resume", invocations[1])
        self.assertFalse(result["observed"]["attempt_history"][0]["session_observed"])

    def test_checkpoint_cannot_take_retry_handoff_from_live_controller(self) -> None:
        entered = Event()
        release = Event()
        lord = AgentLord(self.root)
        original = lord._record_claude_attempt

        def pause_after_atomic_handoff(*args, **kwargs):
            updated = original(*args, **kwargs)
            if args[3] == "failed" and not entered.is_set():
                entered.set()
                self.assertTrue(release.wait(3))
            return updated

        with patch.dict(os.environ, {"FAKE_CLAUDE_FAILURES": "1"}, clear=False), patch.object(
            lord,
            "_record_claude_attempt",
            side_effect=pause_after_atomic_handoff,
        ):
            with ThreadPoolExecutor(max_workers=1) as executor:
                started = executor.submit(
                    lord.start,
                    "retry-handoff",
                    "claude-cli",
                    str(self.target),
                    "one controller only",
                    retry_attempts=2,
                )
                self.assertTrue(entered.wait(2))
                checkpoint, quiet = self.lord.checkpoint(["retry-handoff"], 1)
                release.set()
                result = started.result(timeout=4)

        self.assertTrue(quiet)
        self.assertEqual("CHECKPOINT_QUIET", checkpoint["status"])
        self.assertEqual("SUCCEEDED", result["status"])
        self.assertEqual("2", self.claude_counter.read_text(encoding="utf-8"))

    def test_claude_stall_is_fenced_then_resumed_with_one_continuation_query(self) -> None:
        config_path = Path(self.temporary.name) / "stall-providers.json"
        config = json.loads(DEFAULT_CONFIG.read_text(encoding="utf-8"))
        config["control"]["claude_stall_seconds"] = 2
        config["control"]["claude_tool_stall_seconds"] = 3
        config["control"]["claude_terminate_grace_seconds"] = 1
        config["control"]["claude_progress_poll_interval_ms"] = 25
        config_path.write_text(json.dumps(config), encoding="utf-8")

        with patch.dict(
            os.environ,
            {
                "AGENT_LORD_PROVIDER_CONFIG": str(config_path),
                "FAKE_CLAUDE_STALL_ATTEMPTS": "1",
            },
            clear=False,
        ):
            result = AgentLord(self.root).start(
                "claude-stall",
                "claude-cli",
                str(self.target),
                "review without duplication",
            )

        self.assertEqual("SUCCEEDED", result["status"])
        history = result["observed"]["attempt_history"]
        self.assertEqual("PROVIDER_STALLED", history[0]["error"]["code"])
        self.assertEqual("continuation", history[1]["prompt_kind"])
        self.assertEqual("stdin-attached", history[1]["prompt_delivery"])
        invocations = [json.loads(line) for line in self.argv_log.read_text(encoding="utf-8").splitlines()]
        sessions = [
            args[args.index("--resume") + 1] if "--resume" in args else args[args.index("--session-id") + 1]
            for args in invocations
        ]
        self.assertEqual(2, len(invocations))
        self.assertEqual(1, len(set(sessions)))
        self.assertIn("--resume", invocations[1])
        prompts = [json.loads(line) for line in self.claude_prompt_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(2, len(prompts))
        self.assertIn("agent-lord-recovery:", prompts[1])

    def test_checkpoint_takes_over_dead_controller_and_does_not_duplicate_recovery(self) -> None:
        config_path = Path(self.temporary.name) / "takeover-providers.json"
        config = json.loads(DEFAULT_CONFIG.read_text(encoding="utf-8"))
        config["control"]["claude_stall_seconds"] = 1
        config["control"]["claude_tool_stall_seconds"] = 2
        config["control"]["claude_terminate_grace_seconds"] = 1
        config["control"]["claude_progress_poll_interval_ms"] = 25
        config_path.write_text(json.dumps(config), encoding="utf-8")
        spawned = subprocess.run(
            [
                sys.executable,
                "-c",
                (
                    "import subprocess; "
                    "process=subprocess.Popen(['sleep','60'],start_new_session=True,"
                    "stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); "
                    "print(process.pid,flush=True)"
                ),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        orphan_pid = int(spawned.stdout.strip())
        now = utc_now()
        old_ms = int(time.time() * 1000) - 5000
        stdout = self.root / "logs" / "takeover.attempt-1.stdout"
        stderr = self.root / "logs" / "takeover.attempt-1.stderr"
        session_id = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff"
        stdout.parent.mkdir(parents=True, exist_ok=True)
        stdout.write_text(
            json.dumps({"type": "system", "subtype": "init", "session_id": session_id}) + "\n",
            encoding="utf-8",
        )
        os.utime(stdout, (old_ms / 1000, old_ms / 1000))
        stderr.write_text("", encoding="utf-8")
        create_operation(
            {
                "version": 1,
                "operation_id": "takeover-running",
                "task_id": "takeover-task",
                "provider": "claude-cli",
                "kind": "start",
                "target": str(self.target),
                "status": "running",
                "message": "finish takeover review",
                "message_sha256": "0" * 64,
                "expected": {
                    "model": "claude-opus-5",
                    "effort": "xhigh",
                    "permission_mode": "dangerously_bypass",
                    "permission_enforcement": "argument-enforced",
                    "retry_plan": [{"model": "claude-opus-5", "attempts": 5}],
                },
                "observed": {},
                "source": {},
                "read_only": False,
                "artifact": None,
                "error": None,
                "pid": orphan_pid,
                "endpoint_id": session_id,
                "last_progress_at_ms": old_ms,
                "active_attempt": {
                    "number": 1,
                    "model": "claude-opus-5",
                    "attempt_id": "orphan-attempt",
                    "controller_pid": 99999999,
                    "pid": orphan_pid,
                    "process_group_id": orphan_pid,
                    "prompt_kind": "original",
                    "stdout_path": str(stdout),
                    "stderr_path": str(stderr),
                    "last_progress_at_ms": old_ms,
                    "progress_seq": 0,
                    "session_observed": True,
                },
                "stdout_path": str(stdout),
                "stderr_path": str(stderr),
                "created_at": now,
                "updated_at": now,
            },
            self.root,
        )
        try:
            with patch.dict(os.environ, {"AGENT_LORD_PROVIDER_CONFIG": str(config_path)}, clear=False):
                lord = AgentLord(self.root)
                result, quiet = lord.checkpoint(["takeover-task"], 3)
                repeated, repeated_quiet = lord.checkpoint(["takeover-task"], 1)
        finally:
            try:
                os.killpg(orphan_pid, signal.SIGKILL)
            except OSError:
                pass

        self.assertFalse(quiet)
        self.assertFalse(repeated_quiet)
        result_item = self._single_checkpoint_action(result)
        repeated_item = self._single_checkpoint_action(repeated)
        self.assertEqual("SUCCEEDED", result_item["status"])
        self.assertEqual(result_item["operation_id"], repeated_item["operation_id"])
        with self.assertRaises(OSError):
            os.killpg(orphan_pid, 0)
        prompts = [json.loads(line) for line in self.claude_prompt_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(1, len(prompts))
        self.assertIn("agent-lord-recovery:takeover-running:2", prompts[0])

    def test_checkpoint_recovery_stays_bounded_and_is_not_dispatched_twice(self) -> None:
        stdout = self.root / "logs" / "bounded-recovery.attempt-1.stdout"
        stderr = self.root / "logs" / "bounded-recovery.attempt-1.stderr"
        stdout.parent.mkdir(parents=True, exist_ok=True)
        session_id = "aaaaaaaa-bbbb-4ccc-8ddd-111111111111"
        stdout.write_text(
            json.dumps({"type": "system", "subtype": "init", "session_id": session_id}) + "\n",
            encoding="utf-8",
        )
        stderr.write_text("", encoding="utf-8")
        now = utc_now()
        create_operation(
            {
                "version": 1,
                "operation_id": "bounded-recovery",
                "task_id": "bounded-recovery-task",
                "provider": "claude-cli",
                "kind": "start",
                "target": str(self.target),
                "status": "recovering",
                "message": "finish bounded recovery",
                "message_sha256": "0" * 64,
                "expected": {
                    "model": "claude-opus-5",
                    "effort": "xhigh",
                    "permission_mode": "dangerously_bypass",
                    "permission_enforcement": "argument-enforced",
                    "retry_plan": [{"model": "claude-opus-5", "attempts": 3}],
                },
                "observed": {"supervision": {"state": "recovering", "attempt": 2}},
                "source": {},
                "read_only": False,
                "artifact": None,
                "error": None,
                "endpoint_id": session_id,
                "stdout_path": str(stdout),
                "stderr_path": str(stderr),
                "attempt_history": [
                    {
                        "number": 1,
                        "model": "claude-opus-5",
                        "status": "failed",
                        "session_observed": True,
                        "error": {
                            "code": "PROVIDER_STALLED",
                            "message": "stalled",
                            "retryable": True,
                            "requires_authorization": False,
                        },
                    }
                ],
                "recovery_controller_pid": 99999999,
                "created_at": now,
                "updated_at": now,
            },
            self.root,
        )

        with patch.dict(os.environ, {"FAKE_CLAUDE_DELAY_SECONDS": "1.5"}, clear=False):
            before = time.monotonic()
            checkpoint_command = [
                "python3",
                str(Path(__file__).resolve().parent.parent / "scripts" / "agent_lord.py"),
                "checkpoint",
                "--task-id",
                "bounded-recovery-task",
                "--seconds",
                "1",
            ]
            quiet_processes = [
                subprocess.Popen(
                    checkpoint_command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                for _ in range(2)
            ]
            quiet_outputs = [process.communicate(timeout=3) for process in quiet_processes]
            elapsed = time.monotonic() - before
            terminal, terminal_quiet = self.lord.checkpoint(["bounded-recovery-task"], 4)
        quiet_result = json.loads(quiet_outputs[0][0])

        self.assertTrue(all(process.returncode == 124 for process in quiet_processes))
        self.assertLess(elapsed, 1.4)
        self.assertEqual("CHECKPOINT_QUIET", quiet_result["status"])
        self.assertFalse(terminal_quiet)
        self.assertEqual("SUCCEEDED", self._single_checkpoint_action(terminal)["status"])
        prompts = [json.loads(line) for line in self.claude_prompt_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(1, len(prompts))
        self.assertIn("agent-lord-recovery:bounded-recovery:2", prompts[0])

    def test_checkpoint_recovers_dead_preparing_controller_after_definite_non_delivery(self) -> None:
        now = utc_now()
        session_id = "aaaaaaaa-bbbb-4ccc-8ddd-222222222222"
        create_operation(
            {
                "version": 1,
                "operation_id": "preparing-not-delivered",
                "task_id": "preparing-task",
                "provider": "claude-cli",
                "kind": "start",
                "target": str(self.target),
                "status": "preparing",
                "message": "safe original retry",
                "message_sha256": "0" * 64,
                "expected": {
                    "model": "claude-opus-5",
                    "effort": "xhigh",
                    "permission_mode": "dangerously_bypass",
                    "permission_enforcement": "argument-enforced",
                    "retry_plan": [{"model": "claude-opus-5", "attempts": 2}],
                },
                "observed": {},
                "source": {},
                "read_only": False,
                "artifact": None,
                "error": None,
                "endpoint_id": session_id,
                "controller_pid": 99999999,
                "active_attempt": {
                    "number": 1,
                    "model": "claude-opus-5",
                    "controller_pid": 99999999,
                    "prompt_kind": "original",
                    "prompt_delivery": "not-delivered",
                },
                "created_at": now,
                "updated_at": now,
            },
            self.root,
        )

        checkpoint, quiet = self.lord.checkpoint(["preparing-task"], 4)
        actionable = self._single_checkpoint_action(checkpoint)

        self.assertFalse(quiet)
        self.assertEqual("SUCCEEDED", actionable["status"])
        prompts = [json.loads(line) for line in self.claude_prompt_log.read_text(encoding="utf-8").splitlines()]
        invocations = [json.loads(line) for line in self.argv_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(["safe original retry"], prompts)
        self.assertIn("--session-id", invocations[0])
        self.assertNotIn("--resume", invocations[0])

    def test_checkpoint_takes_over_after_controller_lease_holder_is_killed(self) -> None:
        operation_id = "killed-holder-preparing"
        lock_id = self.lord._controller_lease_lock_id(operation_id)
        holder = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import sys,time; from pathlib import Path; "
                    "from agent_lord.state import record_lock; "
                    "lock=record_lock('controller-lease',sys.argv[2],Path(sys.argv[1])); "
                    "lock.__enter__(); print('leased',flush=True); time.sleep(60)"
                ),
                str(self.root),
                lock_id,
            ],
            cwd=str(Path(__file__).resolve().parent.parent),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertEqual("leased", holder.stdout.readline().strip())
        now = utc_now()
        create_operation(
            {
                "version": 1,
                "operation_id": operation_id,
                "task_id": "killed-holder-task",
                "provider": "claude-cli",
                "kind": "start",
                "target": str(self.target),
                "status": "preparing",
                "message": "resume after killed holder",
                "message_sha256": "0" * 64,
                "expected": {
                    "model": "claude-opus-5",
                    "effort": "xhigh",
                    "permission_mode": "dangerously_bypass",
                    "permission_enforcement": "argument-enforced",
                    "retry_plan": [{"model": "claude-opus-5", "attempts": 2}],
                },
                "observed": {},
                "source": {},
                "read_only": False,
                "artifact": None,
                "error": None,
                "endpoint_id": "aaaaaaaa-bbbb-4ccc-8ddd-666666666666",
                "controller_pid": holder.pid,
                "created_at": now,
                "updated_at": now,
            },
            self.root,
        )
        try:
            holder.kill()
            holder.wait(timeout=2)
            checkpoint, quiet = self.lord.checkpoint(["killed-holder-task"], 4)
        finally:
            if holder.poll() is None:
                holder.kill()
                holder.wait(timeout=2)
            holder.stdout.close()
            holder.stderr.close()

        self.assertFalse(quiet)
        self.assertEqual("SUCCEEDED", self._single_checkpoint_action(checkpoint)["status"])
        prompts = [json.loads(line) for line in self.claude_prompt_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(["resume after killed holder"], prompts)

    def test_checkpoint_fails_closed_when_ambiguous_preparing_process_cannot_be_fenced(self) -> None:
        now = utc_now()
        create_operation(
            {
                "version": 1,
                "operation_id": "preparing-unknown",
                "task_id": "preparing-unknown-task",
                "provider": "claude-cli",
                "kind": "start",
                "target": str(self.target),
                "status": "preparing",
                "message": "do not replay",
                "message_sha256": "0" * 64,
                "expected": {
                    "model": "claude-opus-5",
                    "retry_plan": [{"model": "claude-opus-5", "attempts": 2}],
                },
                "observed": {},
                "source": {},
                "read_only": False,
                "artifact": None,
                "error": None,
                "endpoint_id": "aaaaaaaa-bbbb-4ccc-8ddd-333333333333",
                "controller_pid": 99999999,
                "active_attempt": {
                    "number": 1,
                    "model": "claude-opus-5",
                    "controller_pid": 99999999,
                    "prompt_kind": "original",
                    "prompt_delivery": "delivery-unknown",
                },
                "created_at": now,
                "updated_at": now,
            },
            self.root,
        )

        checkpoint, quiet = self.lord.checkpoint(["preparing-unknown-task"], 2)
        actionable = self._single_checkpoint_action(checkpoint)

        self.assertFalse(quiet)
        self.assertEqual("ERROR", actionable["status"])
        self.assertEqual("DELIVERY_UNKNOWN", actionable["error"]["code"])
        self.assertFalse(actionable["error"]["retryable"])
        self.assertFalse(self.claude_prompt_log.exists())

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

    def test_codex_alias_defaults_to_cli_sol_high_and_resumes_same_session(self) -> None:
        start = self.lord.start("codex-cli-default", "codex", str(self.target), "review")
        turn = self.lord.turn("codex-cli-default", "continue")

        self.assertEqual("SUCCEEDED", start["status"])
        self.assertEqual("codex-cli", start["provider"])
        self.assertEqual("gpt-5.6-sol", start["expected"]["model"])
        self.assertEqual("high", start["expected"]["effort"])
        self.assertEqual(start["endpoint_id"], turn["endpoint_id"])
        invocations = [json.loads(line) for line in self.codex_argv_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(2, len(invocations))
        for arguments in invocations:
            self.assertEqual("gpt-5.6-sol", arguments[arguments.index("--model") + 1])
            self.assertIn('model_reasoning_effort="high"', arguments)
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

        self.assertEqual("high", start["expected"]["effort"])
        self.assertEqual("high", start["action"]["arguments"]["thinking"])
        self.assertEqual("dangerously_bypass", start["expected"]["permission_mode"])
        self.assertEqual("host-inherited-unverified", start["expected"]["permission_enforcement"])
        self.assertNotIn("permission", start["action"]["arguments"])
        self.assertNotIn("sandbox", start["action"]["arguments"])

    def test_checkpoint_default_is_150_seconds(self) -> None:
        self.assertEqual(150, control_config()["checkpoint_seconds"])
        args = build_parser().parse_args(["checkpoint"])
        self.assertEqual(150, args.seconds)
        multiple = build_parser().parse_args(
            ["checkpoint", "--task-id", "task-a", "--task-id", "task-b"]
        )
        self.assertEqual(["task-a", "task-b"], multiple.task_ids)

    def test_legacy_provider_config_gets_safe_claude_supervision_defaults(self) -> None:
        config_path = Path(self.temporary.name) / "legacy-providers.json"
        config = json.loads(DEFAULT_CONFIG.read_text(encoding="utf-8"))
        for name in (
            "claude_stall_seconds",
            "claude_tool_stall_seconds",
            "claude_terminate_grace_seconds",
            "claude_progress_poll_interval_ms",
        ):
            config["control"].pop(name)
        config_path.write_text(json.dumps(config), encoding="utf-8")

        with patch.dict(os.environ, {"AGENT_LORD_PROVIDER_CONFIG": str(config_path)}, clear=False):
            control = control_config()

        self.assertEqual(900, control["claude_stall_seconds"])
        self.assertEqual(3600, control["claude_tool_stall_seconds"])
        self.assertEqual(10, control["claude_terminate_grace_seconds"])
        self.assertEqual(250, control["claude_progress_poll_interval_ms"])

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

    def test_start_prepares_source_worktree_and_freezes_resolved_target(self) -> None:
        subprocess.run(["git", "init", "-q", str(self.target)], check=True)
        subprocess.run(["git", "-C", str(self.target), "config", "user.name", "Agent Lord Test"], check=True)
        subprocess.run(["git", "-C", str(self.target), "config", "user.email", "agent-lord@example.invalid"], check=True)
        (self.target / "tracked.txt").write_text("source\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(self.target), "add", "tracked.txt"], check=True)
        subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "-C", str(self.target), "commit", "-q", "-m", "test source"],
            check=True,
        )
        head = subprocess.run(
            ["git", "-C", str(self.target), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        subprocess.run(["git", "-C", str(self.target), "branch", "feat/source"], check=True)

        result = self.lord.start(
            "workspace-create",
            "claude-cli",
            None,
            "review",
            model="opus",
            effort="xhigh",
            head_sha=head,
            repository=str(self.target),
            source_branch="feat/source",
            workspace_policy="reuse-or-create",
        )

        self.assertEqual("SUCCEEDED", result["status"])
        expected_target = (self.root / "worktrees" / "workspace-create").resolve()
        task = load_task("workspace-create", self.root)
        self.assertEqual(str(expected_target), task["target"])
        branch = subprocess.run(
            ["git", "-C", str(expected_target), "branch", "--show-current"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.assertEqual("feat/source", branch)
        self.assertEqual(head, task["contract"]["source"]["head_sha"])

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

    def test_unrecognized_model_literal_in_result_text_is_not_a_provider_error(self) -> None:
        result = self.lord.start(
            "literal-unrecognized-model",
            "claude-cli",
            str(self.target),
            "explain unrecognized_model",
            model="opus",
        )

        self.assertEqual("SUCCEEDED", result["status"])

    def test_main_model_unrecognized_without_result_is_classified(self) -> None:
        with patch.dict(
            os.environ,
            {
                "FAKE_CLAUDE_DIAGNOSTIC": '[claude-code:unrecognized_model] {"model":"unknown-main","query_source":"main"}',
                "FAKE_CLAUDE_DIAGNOSTIC_STDERR": "1",
                "FAKE_CLAUDE_EXIT_AFTER_DIAGNOSTIC": "1",
            },
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

    def test_auxiliary_auto_mode_failure_does_not_retry_matching_fable_result(self) -> None:
        with patch.dict(
            os.environ,
            {
                "FAKE_CLAUDE_DIAGNOSTIC": '[claude-code:unrecognized_model] {"model":"qw-mid-5","query_source":"auto_mode"}',
                "FAKE_CLAUDE_DIAGNOSTIC_STDERR": "1",
                "FAKE_CLAUDE_MODEL": "claude-fable-5",
            },
            clear=False,
        ):
            result = self.lord.start(
                "fable-with-auto-mode-warning",
                "claude-cli",
                str(self.target),
                "review",
                model="fable",
            )

        self.assertEqual("SUCCEEDED", result["status"])
        self.assertEqual("dangerously_bypass", result["expected"]["permission_mode"])
        self.assertEqual("dangerously_bypass", result["observed"]["permission_mode"])
        self.assertEqual(1, result["observed"]["attempts"])
        self.assertFalse(result["observed"]["fallback_used"])
        self.assertEqual("claude-fable-5", result["observed"]["main_model"])
        self.assertEqual("AUXILIARY_MODEL_UNRECOGNIZED", result["observed"]["warnings"][0]["code"])
        self.assertEqual(result["observed"]["warnings"], result["warnings"])
        self.assertEqual(
            "AUXILIARY_MODEL_UNRECOGNIZED",
            result["observed"]["attempt_history"][0]["warnings"][0]["code"],
        )
        event_types = [
            json.loads(line)["type"]
            for line in (self.root / "events" / "fable-with-auto-mode-warning.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        self.assertIn("provider-attempt-warning", event_types)

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
        actionable = self._single_checkpoint_action(result)
        self.assertEqual(start["action"]["action_id"], actionable["action"]["action_id"])

    def test_checkpoint_absorbs_benign_progress_until_quiet_deadline(self) -> None:
        self._create_running_operation("progress-task", "progress-running")

        def advance_progress() -> None:
            time.sleep(0.1)

            def mutate(value):
                active = dict(value["active_attempt"])
                active["progress_seq"] = 2
                value["active_attempt"] = active
                value["observed"] = {
                    "supervision": {
                        "state": "tool_wait",
                        "attempt": 1,
                        "progress_seq": 2,
                    }
                }
                return value

            update_operation("progress-running", mutate, self.root)

        before = time.monotonic()
        with ThreadPoolExecutor(max_workers=1) as executor:
            update = executor.submit(advance_progress)
            result, quiet = self.lord.checkpoint(["progress-task"], 1)
            update.result(timeout=2)
        elapsed = time.monotonic() - before

        self.assertTrue(quiet)
        self.assertGreaterEqual(elapsed, 0.8)
        self.assertEqual("CHECKPOINT_QUIET", result["status"])
        self.assertEqual(2, result["active"][0]["progress_seq"])
        self.assertEqual("tool_wait", result["active"][0]["supervision_state"])

    def test_checkpoint_terminal_change_wakes_promptly(self) -> None:
        self._create_running_operation("terminal-task", "terminal-running")

        def finish() -> None:
            time.sleep(0.1)
            update_operation(
                "terminal-running",
                lambda value: dict(value, status="succeeded", completed_at=utc_now()),
                self.root,
            )

        before = time.monotonic()
        with ThreadPoolExecutor(max_workers=1) as executor:
            update = executor.submit(finish)
            result, quiet = self.lord.checkpoint(["terminal-task"], 5)
            update.result(timeout=2)
        elapsed = time.monotonic() - before

        self.assertFalse(quiet)
        self.assertLess(elapsed, 1.0)
        actionable = self._single_checkpoint_action(result)
        self.assertEqual("SUCCEEDED", actionable["status"])
        self.assertEqual("terminal-task", actionable["task_id"])

    def test_checkpoint_new_pending_action_wakes_promptly(self) -> None:
        start = self.lord.start("new-action", "codex-app", "project-1", "review")
        accepted = self.lord.accept(
            start["action"]["action_id"],
            {"threadId": "thread-action", "hostId": "host-action"},
        )
        self.assertEqual("RUNNING", accepted["status"])

        def request_read():
            time.sleep(0.1)
            return self.lord.check("new-action")

        before = time.monotonic()
        with ThreadPoolExecutor(max_workers=1) as executor:
            requested = executor.submit(request_read)
            result, quiet = self.lord.checkpoint(["new-action"], 5)
            check_result = requested.result(timeout=2)
        elapsed = time.monotonic() - before

        self.assertFalse(quiet)
        self.assertLess(elapsed, 1.0)
        actionable = self._single_checkpoint_action(result)
        self.assertEqual("ACTION_REQUIRED", actionable["status"])
        self.assertEqual(check_result["action"]["action_id"], actionable["action"]["action_id"])

    def test_checkpoint_multiple_tasks_returns_the_actionable_task(self) -> None:
        self._create_running_operation("multi-quiet", "multi-quiet-running")
        self._create_running_operation("multi-terminal", "multi-terminal-running")

        def progress_then_finish() -> None:
            time.sleep(0.1)
            update_operation(
                "multi-quiet-running",
                lambda value: dict(value, observed={"supervision": {"state": "progressing", "progress_seq": 2}}),
                self.root,
            )
            time.sleep(0.1)
            update_operation(
                "multi-terminal-running",
                lambda value: dict(value, status="failed", error={
                    "code": "PROVIDER_FAILED",
                    "message": "terminal failure",
                    "retryable": False,
                    "requires_authorization": False,
                }),
                self.root,
            )

        with ThreadPoolExecutor(max_workers=1) as executor:
            update = executor.submit(progress_then_finish)
            result, quiet = self.lord.checkpoint(["multi-quiet", "multi-terminal"], 5)
            update.result(timeout=2)

        self.assertFalse(quiet)
        actionable = self._single_checkpoint_action(result)
        self.assertEqual("ERROR", actionable["status"])
        self.assertEqual("multi-terminal", actionable["task_id"])
        self.assertEqual("PROVIDER_FAILED", actionable["error"]["code"])

    def test_checkpoint_delivers_all_simultaneous_terminal_tasks(self) -> None:
        self._create_running_operation("terminal-a", "terminal-a-running")
        self._create_running_operation("terminal-b", "terminal-b-running")
        for operation_id in ("terminal-a-running", "terminal-b-running"):
            update_operation(
                operation_id,
                lambda value: dict(value, status="succeeded", completed_at=utc_now()),
                self.root,
            )

        result, quiet = self.lord.checkpoint(["terminal-a", "terminal-b"], 5)

        self.assertFalse(quiet)
        self.assertEqual("CHECKPOINT_ACTIONABLE", result["status"])
        self.assertEqual(
            {"terminal-a", "terminal-b"},
            {item["task_id"] for item in result["actionable"]},
        )

    def test_checkpoint_terminal_snapshot_remains_durable_across_calls(self) -> None:
        self._create_running_operation("durable-a", "durable-a-running")
        self._create_running_operation("durable-b", "durable-b-running")
        update_operation(
            "durable-a-running",
            lambda value: dict(value, status="succeeded", completed_at=utc_now()),
            self.root,
        )
        first, first_quiet = self.lord.checkpoint(["durable-a", "durable-b"], 2)
        update_operation(
            "durable-b-running",
            lambda value: dict(value, status="failed", error={
                "code": "PROVIDER_FAILED",
                "message": "second terminal",
                "retryable": False,
                "requires_authorization": False,
            }),
            self.root,
        )
        second, second_quiet = self.lord.checkpoint(["durable-a", "durable-b"], 2)

        self.assertFalse(first_quiet)
        self.assertFalse(second_quiet)
        self.assertEqual(["durable-a"], [item["task_id"] for item in first["actionable"]])
        self.assertEqual(
            {"durable-a", "durable-b"},
            {item["task_id"] for item in second["actionable"]},
        )

    def test_checkpoint_retry_exhaustion_is_terminal_and_not_retryable(self) -> None:
        now = utc_now()
        stdout = self.root / "logs" / "exhausted.stdout"
        stderr = self.root / "logs" / "exhausted.stderr"
        stdout.write_text("", encoding="utf-8")
        stderr.write_text("", encoding="utf-8")
        create_operation(
            {
                "version": 1,
                "operation_id": "exhausted-running",
                "task_id": "exhausted-task",
                "provider": "claude-cli",
                "kind": "start",
                "target": str(self.target),
                "status": "running",
                "message": "exhaust once",
                "message_sha256": "0" * 64,
                "expected": {
                    "model": "claude-opus-5",
                    "retry_plan": [{"model": "claude-opus-5", "attempts": 1}],
                },
                "observed": {},
                "source": {},
                "read_only": False,
                "artifact": None,
                "error": None,
                "pid": 99999999,
                "controller_pid": 99999998,
                "endpoint_id": "aaaaaaaa-bbbb-4ccc-8ddd-444444444444",
                "stdout_path": str(stdout),
                "stderr_path": str(stderr),
                "dead_process_observed_at_ms": 0,
                "active_attempt": {
                    "number": 1,
                    "model": "claude-opus-5",
                    "controller_pid": 99999998,
                    "pid": 99999999,
                    "prompt_kind": "original",
                    "prompt_delivery": "stdin-attached",
                    "stdout_path": str(stdout),
                    "stderr_path": str(stderr),
                },
                "created_at": now,
                "updated_at": now,
            },
            self.root,
        )

        result, quiet = self.lord.checkpoint(["exhausted-task"], 2)
        actionable = self._single_checkpoint_action(result)

        self.assertFalse(quiet)
        self.assertEqual("ERROR", actionable["status"])
        self.assertFalse(actionable["error"]["retryable"])
        self.assertNotIn("safe_recovery", actionable["error"])
        self.assertTrue(actionable["error"]["details"]["retry_exhausted"])

    def test_checkpoint_stall_exhaustion_uses_the_same_terminal_error_shape(self) -> None:
        now = utc_now()
        old_ms = int(time.time() * 1000) - 2_000_000
        create_operation(
            {
                "version": 1,
                "operation_id": "stall-exhausted",
                "task_id": "stall-exhausted-task",
                "provider": "claude-cli",
                "kind": "start",
                "target": str(self.target),
                "status": "running",
                "message": "stall once",
                "message_sha256": "0" * 64,
                "expected": {
                    "model": "claude-opus-5",
                    "retry_plan": [{"model": "claude-opus-5", "attempts": 1}],
                },
                "observed": {},
                "source": {},
                "read_only": False,
                "artifact": None,
                "error": None,
                "pid": 12345,
                "controller_pid": 99999998,
                "endpoint_id": "aaaaaaaa-bbbb-4ccc-8ddd-777777777777",
                "active_attempt": {
                    "number": 1,
                    "model": "claude-opus-5",
                    "controller_pid": 99999998,
                    "pid": 12345,
                    "prompt_delivery": "stdin-attached",
                    "last_progress_at_ms": old_ms,
                    "progress_state": "provider_wait",
                },
                "created_at": now,
                "updated_at": now,
            },
            self.root,
        )
        with patch.object(self.lord, "_pid_alive", side_effect=lambda pid: pid == 12345), patch(
            "agent_lord.engine.terminate_claude_process"
        ):
            result, quiet = self.lord.checkpoint(["stall-exhausted-task"], 2)

        actionable = self._single_checkpoint_action(result)
        self.assertFalse(quiet)
        self.assertEqual("PROVIDER_STALLED", actionable["error"]["code"])
        self.assertFalse(actionable["error"]["retryable"])
        self.assertNotIn("safe_recovery", actionable["error"])
        self.assertTrue(actionable["error"]["details"]["retry_exhausted"])

    def test_checkpoint_controller_budget_exhaustion_uses_terminal_error_shape(self) -> None:
        now = utc_now()
        create_operation(
            {
                "version": 1,
                "operation_id": "controller-exhausted",
                "task_id": "controller-exhausted-task",
                "provider": "claude-cli",
                "kind": "start",
                "target": str(self.target),
                "status": "recovering",
                "message": "controller exhausted",
                "message_sha256": "0" * 64,
                "expected": {
                    "model": "claude-opus-5",
                    "retry_plan": [{"model": "claude-opus-5", "attempts": 1}],
                },
                "observed": {},
                "source": {},
                "read_only": False,
                "artifact": None,
                "error": None,
                "endpoint_id": "aaaaaaaa-bbbb-4ccc-8ddd-888888888888",
                "controller_pid": 99999998,
                "recovery_controller_pid": 99999998,
                "attempt_history": [
                    {
                        "number": 1,
                        "model": "claude-opus-5",
                        "status": "failed",
                        "error": {
                            "code": "PROCESS_EXITED_WITHOUT_RESULT",
                            "message": "no result",
                            "retryable": True,
                            "requires_authorization": False,
                        },
                    }
                ],
                "created_at": now,
                "updated_at": now,
            },
            self.root,
        )

        result, quiet = self.lord.checkpoint(["controller-exhausted-task"], 2)
        actionable = self._single_checkpoint_action(result)

        self.assertFalse(quiet)
        self.assertFalse(actionable["error"]["retryable"])
        self.assertNotIn("safe_recovery", actionable["error"])
        self.assertTrue(actionable["error"]["details"]["retry_exhausted"])

    def test_checkpoint_fence_failure_is_terminal_before_recovery_dispatch(self) -> None:
        now = utc_now()
        create_operation(
            {
                "version": 1,
                "operation_id": "fence-failed-running",
                "task_id": "fence-failed-task",
                "provider": "claude-cli",
                "kind": "start",
                "target": str(self.target),
                "status": "running",
                "message": "never duplicate",
                "message_sha256": "0" * 64,
                "expected": {
                    "model": "claude-opus-5",
                    "retry_plan": [{"model": "claude-opus-5", "attempts": 2}],
                },
                "observed": {},
                "source": {},
                "read_only": False,
                "artifact": None,
                "error": None,
                "pid": 99999999,
                "controller_pid": 99999998,
                "endpoint_id": "aaaaaaaa-bbbb-4ccc-8ddd-555555555555",
                "active_attempt": {
                    "number": 1,
                    "model": "claude-opus-5",
                    "controller_pid": 99999998,
                    "pid": 99999999,
                    "process_group_id": 99999999,
                    "prompt_delivery": "stdin-attached",
                },
                "created_at": now,
                "updated_at": now,
            },
            self.root,
        )
        fence_error = AgentLordError(
            "PROCESS_FENCE_FAILED",
            "process tree remains alive",
        )
        with patch("agent_lord.engine.terminate_claude_process", side_effect=fence_error), patch(
            "agent_lord.engine.recover_claude"
        ) as recover:
            result, quiet = self.lord.checkpoint(["fence-failed-task"], 2)

        actionable = self._single_checkpoint_action(result)
        self.assertFalse(quiet)
        self.assertEqual("PROCESS_FENCE_FAILED", actionable["error"]["code"])
        self.assertFalse(actionable["error"]["retryable"])
        recover.assert_not_called()
        self.assertFalse(self.claude_prompt_log.exists())

    def test_checkpoint_cli_quiet_output_is_compact_and_exits_124(self) -> None:
        self._create_running_operation("cli-quiet", "cli-quiet-running")
        completed = subprocess.run(
            [
                "python3",
                str(Path(__file__).resolve().parent.parent / "scripts" / "agent_lord.py"),
                "checkpoint",
                "--task-id",
                "cli-quiet",
                "--seconds",
                "1",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        result = json.loads(completed.stdout)

        self.assertEqual(124, completed.returncode)
        self.assertEqual("CHECKPOINT_QUIET", result["status"])
        self.assertEqual(1, len(result["active"]))
        self.assertLess(len(completed.stdout), 700)
        self.assertNotIn("updated_at", completed.stdout)
        self.assertNotIn("observed", completed.stdout)
        self.assertEqual(
            {
                "operation_id",
                "operation_status",
                "progress_seq",
                "provider",
                "supervision_state",
                "task_id",
            },
            set(result["active"][0]),
        )

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
        actionable = self._single_checkpoint_action(result)
        self.assertEqual("SUCCEEDED", actionable["status"])
        self.assertEqual(session_id, actionable["endpoint_id"])
        self.assertEqual("recovered final\n", Path(actionable["artifact"]["path"]).read_text(encoding="utf-8"))
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
