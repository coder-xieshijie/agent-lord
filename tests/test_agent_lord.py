from __future__ import annotations

from argparse import Namespace
from concurrent.futures import ThreadPoolExecutor
import hashlib
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
from agent_lord.claude_adapter import claude_session_observed, terminate_claude_process
from agent_lord.claude_attempt_result import evaluate_claude_attempt, last_result
from agent_lord.codex_adapter import operation_marker
from agent_lord.config import (
    DEFAULT_CONFIG,
    claude_child_environment,
    control_config,
    expected_model_matches,
)
from agent_lord.engine import _CheckpointScan
from agent_lord.handoff import canonical_packet_bytes
import agent_lord.state
from agent_lord.state import (
    create_action,
    create_operation,
    load_action,
    load_operation,
    load_task,
    operation_paths,
    record_lock,
    update_operation,
    update_task,
    utc_now,
)
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
environment_log = os.environ.get("FAKE_CLAUDE_ENV_LOG")
if environment_log:
    with open(environment_log, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({
            "anthropic_model_present": "ANTHROPIC_MODEL" in os.environ,
            "opus_mapping_present": "ANTHROPIC_DEFAULT_OPUS_MODEL" in os.environ,
            "credential_present": "ANTHROPIC_API_KEY" in os.environ,
            "custom_config_present": "CLAUDE_CONFIG_DIR" in os.environ,
        }) + "\n")
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
usage = {"inputTokens": 1, "outputTokens": 1}
if "[1m]" in model:
    usage["canonicalModel"] = model.replace("[1m]", "")
    usage["contextWindow"] = 1000000
print(json.dumps({
    "type": "result",
    "session_id": session_id,
    "is_error": attempt <= failures,
    "result": ("failed attempt " + str(attempt)) if attempt <= failures else ("final: " + message),
    "modelUsage": {model: usage}
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

    def test_opus_1m_accepts_real_same_model_metadata_shape(self) -> None:
        session_id = "11111111-2222-4333-8444-555555555555"
        stdout = "\n".join(
            [
                json.dumps(
                    {
                        "type": "system",
                        "subtype": "init",
                        "session_id": session_id,
                        "claude_code_version": "2.1.247",
                        "model": "claude-opus-5[1m]",
                    }
                ),
                json.dumps(
                    {
                        "type": "assistant",
                        "session_id": session_id,
                        "message": {"model": "claude-opus-5", "content": []},
                    }
                ),
                json.dumps(
                    {
                        "type": "result",
                        "session_id": session_id,
                        "is_error": False,
                        "result": "CC_PROBE_OK",
                        "modelUsage": {
                            "claude-opus-5[1m]": {
                                "canonicalModel": "claude-opus-5",
                                "contextWindow": 1_000_000,
                            }
                        },
                    }
                ),
            ]
        )

        evaluation = evaluate_claude_attempt(
            stdout,
            "",
            session_id=session_id,
            expected_model="opus[1m]",
            return_code=0,
        )

        self.assertEqual("claude-opus-5[1m]", evaluation.main_model)
        self.assertIn("result.modelUsage.contextWindow", evaluation.main_model_evidence)

    def test_opus_1m_rejects_a_true_model_family_or_version_mismatch(self) -> None:
        session_id = "11111111-2222-4333-8444-666666666666"
        stdout = "\n".join(
            [
                json.dumps(
                    {
                        "type": "system",
                        "subtype": "init",
                        "session_id": session_id,
                        "model": "claude-opus-5[1m]",
                    }
                ),
                json.dumps(
                    {
                        "type": "assistant",
                        "session_id": session_id,
                        "message": {"model": "claude-opus-4", "content": []},
                    }
                ),
                json.dumps(
                    {
                        "type": "result",
                        "session_id": session_id,
                        "is_error": False,
                        "result": "wrong model",
                        "modelUsage": {"claude-opus-5[1m]": {"contextWindow": 1_000_000}},
                    }
                ),
            ]
        )

        with self.assertRaises(AgentLordError) as raised:
            evaluate_claude_attempt(
                stdout,
                "",
                session_id=session_id,
                expected_model="opus[1m]",
                return_code=0,
            )
        self.assertEqual("MODEL_MISMATCH", raised.exception.code)

    def test_opus_1m_rejects_wrong_context_evidence(self) -> None:
        session_id = "11111111-2222-4333-8444-777777777777"
        stdout = json.dumps(
            {
                "type": "result",
                "session_id": session_id,
                "is_error": False,
                "result": "downgraded",
                "modelUsage": {
                    "claude-opus-5": {
                        "canonicalModel": "claude-opus-5",
                        "contextWindow": 200_000,
                    }
                },
            }
        )

        with self.assertRaises(AgentLordError) as raised:
            evaluate_claude_attempt(
                stdout,
                "",
                session_id=session_id,
                expected_model="opus[1m]",
                return_code=0,
            )
        self.assertEqual("MODEL_MISMATCH", raised.exception.code)

    def test_opus_1m_rejects_unrelated_model_usage(self) -> None:
        session_id = "11111111-2222-4333-8444-888888888888"
        stdout = "\n".join(
            [
                json.dumps(
                    {
                        "type": "system",
                        "subtype": "init",
                        "session_id": session_id,
                        "model": "claude-opus-5[1m]",
                    }
                ),
                json.dumps(
                    {
                        "type": "result",
                        "session_id": session_id,
                        "is_error": False,
                        "result": "mixed usage",
                        "modelUsage": {
                            "claude-opus-5[1m]": {"contextWindow": 1_000_000},
                            "claude-sonnet-5": {"contextWindow": 200_000},
                        },
                    }
                ),
            ]
        )

        with self.assertRaises(AgentLordError) as raised:
            evaluate_claude_attempt(
                stdout,
                "",
                session_id=session_id,
                expected_model="opus[1m]",
                return_code=0,
            )
        self.assertEqual("MODEL_MISMATCH", raised.exception.code)

    def test_model_metadata_from_another_session_is_not_evidence(self) -> None:
        session_id = "11111111-2222-4333-8444-999999999999"
        stdout = "\n".join(
            [
                json.dumps(
                    {
                        "type": "system",
                        "subtype": "init",
                        "session_id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                        "model": "claude-opus-5[1m]",
                    }
                ),
                json.dumps(
                    {
                        "type": "result",
                        "session_id": session_id,
                        "is_error": False,
                        "result": "foreign metadata",
                    }
                ),
            ]
        )

        with self.assertRaises(AgentLordError) as raised:
            evaluate_claude_attempt(
                stdout,
                "",
                session_id=session_id,
                expected_model="opus[1m]",
                return_code=0,
            )
        self.assertEqual("MODEL_UNVERIFIED", raised.exception.code)


class AgentLordTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "state"
        self.target = Path(self.temporary.name) / "repo"
        self.target.mkdir()
        self.claude_config = Path(self.temporary.name) / "claude-config"
        self.claude_config.mkdir()
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
                "CLAUDE_CONFIG_DIR": str(self.claude_config),
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

    def _write_claude_settings(self, value: Dict[str, Any]) -> None:
        (self.claude_config / "settings.json").write_text(json.dumps(value), encoding="utf-8")

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

    def _init_source_repo(self) -> str:
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
        return head

    def _count_git_subcommands(self, action: Any) -> Dict[str, int]:
        counts: Dict[str, int] = {}
        original = subprocess.run

        def counting(arguments: Any, *args: Any, **kwargs: Any) -> Any:
            if isinstance(arguments, list) and arguments[:1] == ["git"]:
                key = " ".join(item for item in arguments[3:] if not item.startswith("/"))
                counts[key] = counts.get(key, 0) + 1
            return original(arguments, *args, **kwargs)

        with patch("agent_lord.engine.subprocess.run", counting):
            action()
        return counts

    def test_repo_managed_start_lists_worktrees_once(self) -> None:
        head = self._init_source_repo()

        counts = self._count_git_subcommands(
            lambda: self.lord.start(
                "one-listing",
                "claude-cli",
                None,
                "review",
                read_only=True,
                head_sha=head,
                repository=str(self.target),
                source_branch="feat/source",
                workspace_policy="shared-readonly",
            )
        )

        self.assertEqual(1, counts.get("worktree list --porcelain"))
        self.assertEqual(1, counts.get("status --porcelain --untracked-files=normal"))
        self.assertEqual(
            str((self.root / "worktrees" / "one-listing").resolve()),
            load_task("one-listing", self.root)["target"],
        )

    def test_repo_managed_start_reuses_an_existing_checkout_without_a_second_listing(self) -> None:
        head = self._init_source_repo()
        self.lord.start(
            "first-reader",
            "claude-cli",
            None,
            "review",
            read_only=True,
            head_sha=head,
            repository=str(self.target),
            source_branch="feat/source",
            workspace_policy="shared-readonly",
        )

        counts = self._count_git_subcommands(
            lambda: self.lord.start(
                "second-reader",
                "claude-cli",
                None,
                "review",
                read_only=True,
                head_sha=head,
                repository=str(self.target),
                source_branch="feat/source",
                workspace_policy="shared-readonly",
            )
        )

        self.assertEqual(1, counts.get("worktree list --porcelain"))
        self.assertIsNone(counts.get("worktree add"))
        self.assertEqual(
            load_task("first-reader", self.root)["target"],
            load_task("second-reader", self.root)["target"],
        )

    def _synthetic_stream_json(self, session_id: str, assistant_events: int) -> str:
        lines = [
            json.dumps({"type": "system", "subtype": "init", "session_id": session_id, "model": "claude-opus-5"}),
            "[claude-code:unrecognized_model] "
            + json.dumps({"model": "claude-3-5-haiku", "query_source": "auto_mode"}),
        ]
        for index in range(assistant_events):
            lines.append(
                json.dumps(
                    {
                        "type": "assistant",
                        "session_id": session_id,
                        "message": {
                            "model": "claude-opus-5",
                            "content": [{"type": "text", "text": "chunk %d %s" % (index, "x" * 400)}],
                        },
                    }
                )
            )
        lines.append(
            json.dumps(
                {
                    "type": "result",
                    "subtype": "success",
                    "session_id": session_id,
                    "is_error": False,
                    "model": "claude-opus-5",
                    "modelUsage": {"claude-opus-5": {"inputTokens": 10, "outputTokens": 20}},
                    "result": "final answer",
                }
            )
        )
        return "\n".join(lines) + "\n"

    def test_single_pass_terminal_evaluation_keeps_every_reported_field(self) -> None:
        session_id = "11111111-2222-4333-8444-555555555555"
        stdout = self._synthetic_stream_json(session_id, 2000)

        evaluation = evaluate_claude_attempt(
            stdout,
            "",
            session_id=session_id,
            expected_model="claude-opus-5",
            return_code=0,
        )

        self.assertEqual("claude-opus-5", evaluation.main_model)
        self.assertTrue(evaluation.main_model_verified)
        self.assertEqual(
            ("system.init.model", "assistant.message.model", "result.model", "result.modelUsage"),
            evaluation.main_model_evidence,
        )
        self.assertEqual(
            [{"source": "auto_mode", "model": "claude-3-5-haiku", "status": "failed", "code": "unrecognized_model"}],
            [item.as_dict() for item in evaluation.auxiliary_models],
        )
        self.assertEqual(
            [{"code": "AUXILIARY_MODEL_UNRECOGNIZED", "source": "auto_mode", "model": "claude-3-5-haiku"}],
            [item.as_dict() for item in evaluation.warnings],
        )
        self.assertEqual(last_result(stdout), evaluation.result)
        self.assertEqual("final answer", evaluation.result["result"])

    def test_journaled_session_evidence_replaces_a_second_transcript_read(self) -> None:
        session_id = "22222222-3333-4444-8555-666666666666"
        stdout_path = Path(self.temporary.name) / "streamed.jsonl"
        stdout_path.write_text(self._synthetic_stream_json(session_id, 4), encoding="utf-8")
        operation = {
            "endpoint_id": session_id,
            "active_attempt": {"attempt_id": "a1", "stdout_path": str(stdout_path), "session_observed": True},
        }

        stdout_path.unlink()

        self.assertTrue(claude_session_observed(operation))
        self.assertFalse(
            claude_session_observed(
                {"endpoint_id": session_id, "active_attempt": {"attempt_id": "a1", "stdout_path": str(stdout_path)}}
            )
        )

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

    def test_claude_uses_terminal_aligned_settings_defaults(self) -> None:
        self._write_claude_settings(
            {
                "model": "opus[1m]",
                "effortLevel": "xhigh",
                "env": {
                    "ANTHROPIC_MODEL": "opus[1m]",
                    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5",
                },
            }
        )
        with patch.dict(os.environ, {"FAKE_CLAUDE_MODEL": "claude-opus-5[1m]"}, clear=False):
            result = self.lord.start("claude-terminal-defaults", "claude-cli", str(self.target), "review")

        self.assertEqual("SUCCEEDED", result["status"])
        self.assertEqual("opus[1m]", result["expected"]["model"])
        self.assertEqual("xhigh", result["expected"]["effort"])
        self.assertEqual([{"model": "opus[1m]", "attempts": 5}], result["expected"]["retry_plan"])
        self.assertEqual("claude-opus-5[1m]", result["observed"]["main_model"])
        arguments = json.loads(self.argv_log.read_text(encoding="utf-8").splitlines()[0])
        self.assertEqual("opus[1m]", arguments[arguments.index("--model") + 1])
        self.assertEqual("xhigh", arguments[arguments.index("--effort") + 1])

    def test_claude_absent_settings_fall_back_to_provider_defaults(self) -> None:
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

    def test_claude_model_only_override_keeps_settings_effort(self) -> None:
        self._write_claude_settings({"model": "opus[1m]", "effortLevel": "xhigh"})
        for index, requested in enumerate(("fable", "claude-fable-5"), start=1):
            with self.subTest(model=requested), patch.dict(
                os.environ,
                {"FAKE_CLAUDE_MODEL": "claude-fable-5"},
                clear=False,
            ):
                result = self.lord.start(
                    "claude-model-override-%d" % index,
                    "claude-cli",
                    str(self.target),
                    "judge",
                    model=requested,
                )
            self.assertEqual(requested, result["expected"]["model"])
            self.assertEqual("xhigh", result["expected"]["effort"])
            self.assertFalse(result["observed"]["fallback_used"])

    def test_claude_effort_only_override_keeps_settings_model(self) -> None:
        self._write_claude_settings({"model": "opus[1m]", "effortLevel": "xhigh"})
        with patch.dict(os.environ, {"FAKE_CLAUDE_MODEL": "claude-opus-5[1m]"}, clear=False):
            result = self.lord.start(
                "claude-effort-override",
                "claude-cli",
                str(self.target),
                "review",
                effort="high",
            )

        self.assertEqual("opus[1m]", result["expected"]["model"])
        self.assertEqual("high", result["expected"]["effort"])

    def test_claude_model_and_effort_overrides_both_win(self) -> None:
        self._write_claude_settings({"model": "opus[1m]", "effortLevel": "xhigh"})
        with patch.dict(os.environ, {"FAKE_CLAUDE_MODEL": "claude-fable-5"}, clear=False):
            result = self.lord.start(
                "claude-both-overrides",
                "claude-cli",
                str(self.target),
                "judge",
                model="fable",
                effort="high",
            )

        self.assertEqual("fable", result["expected"]["model"])
        self.assertEqual("high", result["expected"]["effort"])
        self.assertFalse(result["observed"]["fallback_used"])

    def test_claude_launch_environment_removes_only_settings_owned_stale_routes(self) -> None:
        settings = {
            "model": "opus[1m]",
            "effortLevel": "xhigh",
            "apiKeyHelper": "/example/credential-helper",
            "env": {
                "ANTHROPIC_MODEL": "opus[1m]",
                "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5",
            },
        }
        self._write_claude_settings(settings)
        environment_log = Path(self.temporary.name) / "claude-environment.jsonl"
        inherited = {
            "ANTHROPIC_MODEL": "stale-mid",
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "stale-opus",
            "ANTHROPIC_API_KEY": "synthetic-test-credential",
            "ANTHROPIC_BASE_URL": "https://example.invalid",
            "ANTHROPIC_CUSTOM_HEADERS": "x-test: preserved",
            "FAKE_CLAUDE_ENV_LOG": str(environment_log),
            "FAKE_CLAUDE_FAILURES": "1",
            "FAKE_CLAUDE_MODEL": "claude-opus-5[1m]",
        }
        with patch.dict(os.environ, inherited, clear=False):
            child = claude_child_environment()
            self.assertNotIn("ANTHROPIC_MODEL", child)
            self.assertNotIn("ANTHROPIC_DEFAULT_OPUS_MODEL", child)
            self.assertEqual(inherited["ANTHROPIC_API_KEY"], child["ANTHROPIC_API_KEY"])
            self.assertEqual(inherited["ANTHROPIC_BASE_URL"], child["ANTHROPIC_BASE_URL"])
            self.assertEqual(inherited["ANTHROPIC_CUSTOM_HEADERS"], child["ANTHROPIC_CUSTOM_HEADERS"])
            self.assertEqual(str(self.claude_config), child["CLAUDE_CONFIG_DIR"])

            result = self.lord.start(
                "claude-sanitized-launch",
                "claude-cli",
                str(self.target),
                "review",
                retry_attempts=2,
            )
            self.assertEqual("stale-mid", os.environ["ANTHROPIC_MODEL"])

        self.assertEqual("SUCCEEDED", result["status"])
        launches = [json.loads(line) for line in environment_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(2, len(launches))
        for launch in launches:
            self.assertFalse(launch["anthropic_model_present"])
            self.assertFalse(launch["opus_mapping_present"])
            self.assertTrue(launch["credential_present"])
            self.assertTrue(launch["custom_config_present"])
        self.assertEqual(settings, json.loads((self.claude_config / "settings.json").read_text(encoding="utf-8")))

    def test_claude_settings_defaults_are_frozen_across_turns(self) -> None:
        self._write_claude_settings({"model": "opus[1m]", "effortLevel": "xhigh"})
        with patch.dict(os.environ, {"FAKE_CLAUDE_MODEL": "claude-opus-5[1m]"}, clear=False):
            start = self.lord.start("claude-frozen-defaults", "claude-cli", str(self.target), "first")
            self._write_claude_settings({"model": "fable", "effortLevel": "low"})
            turn = self.lord.turn("claude-frozen-defaults", "second")

        self.assertEqual(start["endpoint_id"], turn["endpoint_id"])
        self.assertEqual("opus[1m]", turn["expected"]["model"])
        self.assertEqual("xhigh", turn["expected"]["effort"])
        invocations = [json.loads(line) for line in self.argv_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(2, len(invocations))
        for arguments in invocations:
            self.assertEqual("opus[1m]", arguments[arguments.index("--model") + 1])
            self.assertEqual("xhigh", arguments[arguments.index("--effort") + 1])

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

    def test_start_parser_preserves_declared_parallel_workspace_contract(self) -> None:
        args = build_parser().parse_args(
            [
                "start",
                "--task-id",
                "worker-one",
                "--provider",
                "claude-cli",
                "--repo",
                str(self.target),
                "--message-file",
                str(Path(self.temporary.name) / "prompt.txt"),
                "--head-sha",
                "0" * 40,
                "--source-branch",
                "feat/source",
                "--workspace-policy",
                "isolated",
                "--workspace-branch",
                "fix/part-one",
                "--parallel-group",
                "group-one",
                "--integration-role",
                "worker",
                "--integration-target-branch",
                "feat/source",
                "--integrator-task-id",
                "integrator",
                "--integration-order",
                "1",
            ]
        )

        self.assertEqual("isolated", args.workspace_policy)
        self.assertEqual("fix/part-one", args.workspace_branch)
        self.assertEqual("worker", args.integration_role)
        self.assertEqual(1, args.integration_order)

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

    def test_shared_readonly_policy_rejects_writable_provider(self) -> None:
        head = self._init_source_repo()

        with self.assertRaises(AgentLordError) as raised:
            self.lord.start(
                "shared-writer",
                "claude-cli",
                None,
                "edit",
                head_sha=head,
                repository=str(self.target),
                source_branch="feat/source",
                workspace_policy="shared-readonly",
            )

        self.assertEqual("CONFIG_INVALID", raised.exception.code)

    def test_shared_readonly_tasks_reuse_one_fixed_head_worktree(self) -> None:
        head = self._init_source_repo()
        starts = []
        for task_id in ("shared-review-one", "shared-review-two"):
            starts.append(
                self.lord.start(
                    task_id,
                    "claude-cli",
                    None,
                    "review",
                    read_only=True,
                    head_sha=head,
                    repository=str(self.target),
                    source_branch="feat/source",
                    workspace_policy="shared-readonly",
                )
            )

        self.assertEqual(starts[0]["target"], starts[1]["target"])
        self.assertEqual("shared-readonly", starts[0]["workspace"]["policy"])

    def test_concurrent_shared_readonly_starts_retry_workspace_preparation_lock(self) -> None:
        head = self._init_source_repo()
        entered = Event()
        release = Event()
        original = self.lord._resolve_workspace_target

        def slow_first_resolution(task_id, *args, **kwargs):
            if task_id == "shared-concurrent-one":
                entered.set()
                release.wait(2)
            return original(task_id, *args, **kwargs)

        with patch.object(self.lord, "_resolve_workspace_target", side_effect=slow_first_resolution):
            with ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(
                    self.lord.start,
                    "shared-concurrent-one",
                    "claude-cli",
                    None,
                    "review",
                    read_only=True,
                    head_sha=head,
                    repository=str(self.target),
                    source_branch="feat/source",
                    workspace_policy="shared-readonly",
                )
                self.assertTrue(entered.wait(1))
                second = executor.submit(
                    self.lord.start,
                    "shared-concurrent-two",
                    "claude-cli",
                    None,
                    "review",
                    read_only=True,
                    head_sha=head,
                    repository=str(self.target),
                    source_branch="feat/source",
                    workspace_policy="shared-readonly",
                )
                time.sleep(0.1)
                release.set()
                results = [first.result(timeout=3), second.result(timeout=3)]

        self.assertEqual(["SUCCEEDED", "SUCCEEDED"], [result["status"] for result in results])
        self.assertEqual(results[0]["target"], results[1]["target"])

    def test_parallel_workers_use_isolated_branches_and_integrator_uses_source_branch(self) -> None:
        head = self._init_source_repo()
        common = {
            "provider": "claude-cli",
            "target": None,
            "message": "edit one disjoint area",
            "head_sha": head,
            "repository": str(self.target),
            "source_branch": "feat/source",
            "workspace_policy": "isolated",
            "parallel_group": "parallel-goal-fix",
            "integration_role": "worker",
            "integration_target_branch": "feat/source",
            "integrator_task_id": "goal-integrator",
        }
        first = self.lord.start(
            "goal-worker-one",
            workspace_branch="fix/goal-part-one",
            integration_order=1,
            **common,
        )
        second = self.lord.start(
            "goal-worker-two",
            workspace_branch="fix/goal-part-two",
            integration_order=2,
            **common,
        )

        self.assertEqual("SUCCEEDED", first["status"])
        self.assertEqual("SUCCEEDED", second["status"])
        self.assertEqual("isolated", first["workspace"]["policy"])
        self.assertEqual("worker", first["parallel_plan"]["role"])
        first_task = load_task("goal-worker-one", self.root)
        first_contract = first_task["contract"]
        self.assertEqual("isolated", first_contract["workspace"]["policy"])
        self.assertEqual("fix/goal-part-one", first_contract["workspace"]["workspace_branch"])
        self.assertEqual("worker", first_contract["parallel_plan"]["role"])
        first_branch = subprocess.run(
            ["git", "-C", first_task["target"], "branch", "--show-current"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.assertEqual("fix/goal-part-one", first_branch)

        integrated = self.lord.start(
            "goal-integrator",
            "claude-cli",
            None,
            "integrate worker commits into the MR source branch",
            head_sha=head,
            repository=str(self.target),
            source_branch="feat/source",
            workspace_policy="reuse-or-create",
            parallel_group="parallel-goal-fix",
            integration_role="integrator",
            integration_target_branch="feat/source",
            integration_workers=["goal-worker-one", "goal-worker-two"],
        )

        self.assertEqual("SUCCEEDED", integrated["status"])
        integrator_task = load_task("goal-integrator", self.root)
        self.assertEqual(
            ["goal-worker-one", "goal-worker-two"],
            integrator_task["contract"]["parallel_plan"]["integration_workers"],
        )
        integration_branch = subprocess.run(
            ["git", "-C", integrator_task["target"], "branch", "--show-current"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.assertEqual("feat/source", integration_branch)

    def test_integrator_rejects_worker_list_outside_declared_order(self) -> None:
        head = self._init_source_repo()
        for task_id, workspace_branch, order in (
            ("ordered-worker-one", "fix/ordered-one", 1),
            ("ordered-worker-two", "fix/ordered-two", 2),
        ):
            self.lord.start(
                task_id,
                "claude-cli",
                None,
                "edit",
                head_sha=head,
                repository=str(self.target),
                source_branch="feat/source",
                workspace_policy="isolated",
                workspace_branch=workspace_branch,
                parallel_group="ordered-group",
                integration_role="worker",
                integration_target_branch="feat/source",
                integrator_task_id="ordered-integrator",
                integration_order=order,
            )

        with self.assertRaises(AgentLordError) as raised:
            self.lord.start(
                "ordered-integrator",
                "claude-cli",
                None,
                "integrate",
                head_sha=head,
                repository=str(self.target),
                source_branch="feat/source",
                workspace_policy="reuse-or-create",
                parallel_group="ordered-group",
                integration_role="integrator",
                integration_target_branch="feat/source",
                integration_workers=["ordered-worker-two", "ordered-worker-one"],
            )

        self.assertEqual("PARALLEL_WRITE_PLAN_INCOMPLETE", raised.exception.code)
        self.assertTrue(raised.exception.requires_authorization)

    def test_writable_tasks_cannot_share_one_target_concurrently(self) -> None:
        with patch.dict(os.environ, {"FAKE_CLAUDE_DELAY_SECONDS": "1"}, clear=False):
            with ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(
                    self.lord.start,
                    "lease-owner",
                    "claude-cli",
                    str(self.target),
                    "edit",
                )
                deadline = time.time() + 5
                while time.time() < deadline and not any((self.root / "operations").glob("lease-owner-*.json")):
                    time.sleep(0.01)
                with self.assertRaises(AgentLordError) as raised:
                    self.lord.start(
                        "lease-contender",
                        "claude-cli",
                        str(self.target),
                        "edit concurrently",
                    )
                completed = first.result(timeout=5)

        self.assertEqual("WORKSPACE_WRITE_CONFLICT", raised.exception.code)
        self.assertEqual("SUCCEEDED", completed["status"])

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
        self._assert_warnings_match_the_result_schema(result["warnings"])
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
        preserved = load_operation(complete["operation_id"], self.root)
        self.assertEqual("succeeded", preserved["status"])
        self.assertEqual(complete["artifact"], preserved["artifact"])
        self.assertIsNone(preserved.get("invalidated_artifact"))

    def test_failed_export_does_not_terminalize_a_succeeded_operation(self) -> None:
        complete = self._complete_codex_start("export-guard")
        source = Path(self.temporary.name) / "export-guard.jsonl"
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
                                    {"type": "input_text", "text": operation_marker(complete["operation_id"])}
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
        with self.assertRaises(AgentLordError):
            self.lord.export_artifact("export-guard", complete["operation_id"], str(source), "codex-jsonl")
        after = self.lord.check("export-guard")
        self.assertEqual("SUCCEEDED", after["status"])
        self.assertEqual(complete["artifact"], after["artifact"])
        self.assertEqual(
            "initial report\n",
            Path(after["artifact"]["path"]).read_text(encoding="utf-8"),
        )

    def test_failed_export_still_invalidates_a_non_terminal_operation(self) -> None:
        complete = self._complete_codex_start("export-nonterminal")
        operation_id = complete["operation_id"]
        # Re-open the operation so the export runs against a still-live delivery.
        update_operation(operation_id, lambda record: dict(record, status="submitted"), self.root)
        source = Path(self.temporary.name) / "export-nonterminal.jsonl"
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
                                "content": [{"type": "input_text", "text": operation_marker(operation_id)}],
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
            self.lord.export_artifact("export-nonterminal", operation_id, str(source), "codex-jsonl")
        self.assertEqual("MODEL_MISMATCH", raised.exception.code)
        failed = load_operation(operation_id, self.root)
        self.assertEqual("failed", failed["status"])
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

    def _claude_session_line(self, session_id: str, text: str, model: str = "claude-opus-5") -> str:
        return json.dumps(
            {
                "type": "assistant",
                "sessionId": session_id,
                "message": {"role": "assistant", "model": model, "content": [{"type": "text", "text": text}]},
            }
        )

    def test_claude_export_binds_the_session_and_declares_unprovable_effort(self) -> None:
        start = self.lord.start(
            "claude-export",
            "claude-cli",
            str(self.target),
            "review",
            model="opus",
            effort="xhigh",
            read_only=True,
        )
        self.assertEqual("SUCCEEDED", start["status"])
        session_id = start["endpoint_id"]
        source = Path(self.temporary.name) / "claude-session.jsonl"
        source.write_text(
            "\n".join(
                [
                    self._claude_session_line("00000000-0000-4000-8000-0000000000ff", "other session final"),
                    self._claude_session_line(session_id, "bound intermediate"),
                    self._claude_session_line(session_id, "bound final"),
                ]
            )
            + "\n",
            encoding="utf-8",
        )

        exported = self.lord.export_artifact("claude-export", start["operation_id"], str(source), "claude-jsonl")

        self.assertEqual("bound final\n", Path(exported["artifact"]["path"]).read_text(encoding="utf-8"))
        self.assertEqual(["claude-opus-5"], exported["observed"]["models"])
        self.assertIsNone(exported["observed"]["effort"])
        self.assertEqual("unavailable", exported["observed"]["effort_verification"])
        self.assertEqual(
            [{"code": "EFFORT_UNVERIFIABLE_FORMAT", "source_format": "claude-jsonl", "expected_effort": "xhigh"}],
            exported["observed"]["warnings"],
        )
        self.assertEqual(exported["observed"]["warnings"], exported["warnings"])
        self._assert_warnings_match_the_result_schema(exported["warnings"])

    def _assert_warnings_match_the_result_schema(self, warnings: List[Dict[str, Any]]) -> None:
        schema = json.loads(
            (Path(__file__).resolve().parent.parent / "schemas" / "result-v1.schema.json").read_text(encoding="utf-8")
        )
        variants = schema["properties"]["warnings"]["items"]["oneOf"]
        for warning in warnings:
            matched = [
                variant
                for variant in variants
                if set(warning) <= set(variant["properties"]) and set(variant["required"]) <= set(warning)
            ]
            self.assertEqual(1, len(matched), warning)

    def test_claude_export_rejects_a_transcript_from_another_session(self) -> None:
        start = self.lord.start(
            "claude-export-foreign",
            "claude-cli",
            str(self.target),
            "review",
            model="opus",
            effort="xhigh",
            read_only=True,
        )
        source = Path(self.temporary.name) / "foreign-session.jsonl"
        source.write_text(
            self._claude_session_line("00000000-0000-4000-8000-0000000000ff", "foreign final") + "\n",
            encoding="utf-8",
        )

        with self.assertRaises(AgentLordError) as raised:
            self.lord.export_artifact("claude-export-foreign", start["operation_id"], str(source), "claude-jsonl")

        self.assertEqual("RESULT_INVALID", raised.exception.code)
        preserved = load_operation(start["operation_id"], self.root)
        self.assertEqual("succeeded", preserved["status"])
        self.assertEqual(start["artifact"], preserved["artifact"])

    def test_claude_export_rejects_a_codex_rollout_source(self) -> None:
        start = self.lord.start(
            "claude-export-format",
            "claude-cli",
            str(self.target),
            "review",
            read_only=True,
        )
        source = Path(self.temporary.name) / "not-a-session.jsonl"
        source.write_text("{}\n", encoding="utf-8")

        with self.assertRaises(AgentLordError) as raised:
            self.lord.export_artifact("claude-export-format", start["operation_id"], str(source), "codex-jsonl")

        self.assertEqual("CONFIG_INVALID", raised.exception.code)

    def _synthetic_operation(self, operation_id: str, task_id: str, **overrides: Any) -> Dict[str, Any]:
        now = utc_now()
        record = {
            "version": 1,
            "operation_id": operation_id,
            "task_id": task_id,
            "provider": "claude-cli",
            "kind": "start",
            "target": str(self.target),
            "status": "running",
            "message": "synthetic",
            "message_sha256": "0" * 64,
            "expected": {
                "model": "claude-opus-5",
                "effort": "high",
                "permission_mode": "dangerously_bypass",
                "permission_enforcement": "argument-enforced",
                "retry_plan": [{"model": "claude-opus-5", "attempts": 1}],
            },
            "observed": {},
            "source": {},
            "read_only": False,
            "artifact": None,
            "error": None,
            "created_at": now,
            "updated_at": now,
        }
        record.update(overrides)
        return create_operation(record, self.root)

    def test_accept_tolerates_a_codex_read_that_is_not_ready_yet(self) -> None:
        complete = self._complete_codex_start("codex-poll")
        turn = self.lord.turn("codex-poll", "second question")
        sent = self.lord.accept(turn["action"]["action_id"], {"threadId": "thread-1", "hostId": "old-host"})
        self.assertEqual("RUNNING", sent["status"])
        check = self.lord.check("codex-poll")
        operation_id = check["operation_id"]
        self.assertNotEqual(complete["operation_id"], operation_id)
        not_ready = {
            "thread": {"threadId": "thread-1", "hostId": "old-host", "status": "running"},
            "turns": [
                {
                    "items": [
                        {"role": "user", "content": [{"type": "text", "text": operation_marker(operation_id)}]},
                    ]
                }
            ],
        }

        polled = self.lord.accept(check["action"]["action_id"], not_ready)

        self.assertEqual("RUNNING", polled["status"])
        self.assertEqual("submitted", polled["operation_status"])
        self.assertNotIn("action", polled)

    def test_auto_read_accept_returns_the_next_read_and_cuts_polling_rounds(self) -> None:
        rounds = 5

        def poll(task_id: str, auto_read: bool) -> Dict[str, int]:
            counts = {"check": 0, "accept": 0, "tool": 0}
            start = self.lord.start(
                task_id,
                "codex-app",
                "project-1",
                "review",
                model="gpt-5.6-sol",
                effort="xhigh",
                read_only=True,
            )
            counts["accept"] += 1
            counts["tool"] += 1
            accepted = self.lord.accept(
                start["action"]["action_id"],
                {"threadId": task_id, "hostId": "host"},
                auto_read=auto_read,
            )
            operation_id = start["operation_id"]
            pending = accepted.get("action")
            for _ in range(rounds):
                if pending is None:
                    check = self.lord.check(task_id)
                    counts["check"] += 1
                    pending = check["action"]
                counts["tool"] += 1
                counts["accept"] += 1
                accepted = self.lord.accept(
                    pending["action_id"],
                    {
                        "thread": {"threadId": task_id, "hostId": "host", "status": "running"},
                        "turns": [
                            {
                                "items": [
                                    {
                                        "role": "user",
                                        "content": [{"type": "text", "text": operation_marker(operation_id)}],
                                    }
                                ]
                            }
                        ],
                    },
                    auto_read=auto_read,
                )
                self.assertIn(accepted["status"], ("RUNNING", "ACTION_REQUIRED"))
                pending = accepted.get("action")
            return counts

        baseline = poll("poll-baseline", False)
        optimized = poll("poll-auto-read", True)

        # One Python process per check/accept, one model action per process plus each host tool call.
        baseline_processes = 1 + baseline["check"] + baseline["accept"]
        optimized_processes = 1 + optimized["check"] + optimized["accept"]
        self.assertEqual((5, 6), (baseline["check"], baseline["accept"]))
        self.assertEqual((0, 6), (optimized["check"], optimized["accept"]))
        self.assertEqual(12, baseline_processes)
        self.assertEqual(7, optimized_processes)
        # One model action per Python process plus one per host tool call.
        self.assertEqual(18, baseline_processes + baseline["tool"])
        self.assertEqual(13, optimized_processes + optimized["tool"])
        self.assertEqual(3, (baseline["check"] + baseline["accept"] + baseline["tool"] - 2) // rounds)
        self.assertEqual(2, (optimized["check"] + optimized["accept"] + optimized["tool"] - 2) // rounds)

    def test_auto_read_is_opt_in_and_keeps_a_submitted_operation_quiet(self) -> None:
        complete = self._complete_codex_start("quiet-default")
        turn = self.lord.turn("quiet-default", "second question")
        self.lord.accept(turn["action"]["action_id"], {"threadId": "thread-1", "hostId": "old-host"})
        operation_id = load_task("quiet-default", self.root)["last_operation_id"]
        operation = load_operation(operation_id, self.root)

        self.assertEqual("submitted", operation["status"])
        self.assertNotEqual(complete["operation_id"], operation_id)
        result, quiet = self.lord.checkpoint(["quiet-default"], 1)
        self.assertTrue(quiet)
        self.assertEqual("CHECKPOINT_QUIET", result["status"])

    def test_writable_turn_advances_along_the_contract_branch(self) -> None:
        head = self._init_source_repo()
        self.lord.start(
            "advance-task",
            "claude-cli",
            None,
            "first edit",
            head_sha=head,
            repository=str(self.target),
            source_branch="feat/source",
            workspace_policy="reuse-or-create",
        )
        worktree = load_task("advance-task", self.root)["target"]
        advanced_head = self._commit_in(worktree, "worker commit")

        turn = self.lord.turn("advance-task", "second edit")

        self.assertEqual("SUCCEEDED", turn["status"])
        source = load_task("advance-task", self.root)["contract"]["source"]
        self.assertEqual(head, source["head_sha"])
        self.assertEqual(advanced_head, source["verified_head_sha"])

        second_head = self._commit_in(worktree, "another worker commit")
        self.assertEqual("SUCCEEDED", self.lord.turn("advance-task", "third edit")["status"])
        self.assertEqual(
            second_head,
            load_task("advance-task", self.root)["contract"]["source"]["verified_head_sha"],
        )

    def test_writable_turn_rejects_a_head_off_the_contract_branch(self) -> None:
        head = self._init_source_repo()
        self.lord.start(
            "diverged-task",
            "claude-cli",
            None,
            "first edit",
            head_sha=head,
            repository=str(self.target),
            source_branch="feat/source",
            workspace_policy="reuse-or-create",
        )
        worktree = load_task("diverged-task", self.root)["target"]
        subprocess.run(["git", "-C", worktree, "checkout", "-q", "-b", "side/branch"], check=True)
        self._commit_in(worktree, "off-contract commit")

        with self.assertRaises(AgentLordError) as raised:
            self.lord.turn("diverged-task", "second edit")

        self.assertEqual("SOURCE_MISMATCH", raised.exception.code)
        self.assertEqual("side/branch", raised.exception.details["observed_branch"])
        self.assertNotIn("verified_head_sha", load_task("diverged-task", self.root)["contract"]["source"])

    def test_read_only_turn_still_requires_the_frozen_head(self) -> None:
        head = self._init_source_repo()
        self.lord.start(
            "frozen-task",
            "claude-cli",
            None,
            "review",
            read_only=True,
            head_sha=head,
            repository=str(self.target),
            source_branch="feat/source",
            workspace_policy="reuse-or-create",
        )
        worktree = load_task("frozen-task", self.root)["target"]
        self._commit_in(worktree, "unexpected commit")

        with self.assertRaises(AgentLordError) as raised:
            self.lord.turn("frozen-task", "second review")

        self.assertEqual("SOURCE_MISMATCH", raised.exception.code)

    def _commit_in(self, worktree: str, message: str) -> str:
        marker = Path(worktree) / "tracked.txt"
        marker.write_text(marker.read_text(encoding="utf-8") + message + "\n", encoding="utf-8")
        subprocess.run(["git", "-C", worktree, "add", "tracked.txt"], check=True)
        subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "-C", worktree, "commit", "-q", "-m", message],
            check=True,
        )
        return subprocess.run(
            ["git", "-C", worktree, "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip().lower()

    def test_unfenced_writable_operation_blocks_a_second_writer_until_it_is_fenced(self) -> None:
        self._synthetic_operation("orphan-writer", "orphan-writer-task", status="running")

        with self.assertRaises(AgentLordError) as raised:
            self.lord.start("second-writer", "claude-cli", str(self.target), "edit")

        self.assertEqual("WORKSPACE_WRITE_CONFLICT", raised.exception.code)
        self.assertEqual("orphan-writer", raised.exception.details["operation_id"])
        self.assertEqual("RUN_CHECKPOINT_TO_FENCE_THEN_RETRY", raised.exception.safe_recovery)
        self.assertFalse(any((self.root / "operations").glob("second-writer-*.json")))

        update_operation("orphan-writer", lambda record: dict(record, status="failed"), self.root)

        self.assertEqual("SUCCEEDED", self.lord.start("second-writer", "claude-cli", str(self.target), "edit")["status"])

    def test_unfenced_read_only_operation_does_not_block_a_writer(self) -> None:
        self._synthetic_operation("orphan-reader", "orphan-reader-task", status="running", read_only=True)

        self.assertEqual("SUCCEEDED", self.lord.start("writer-after-reader", "claude-cli", str(self.target), "edit")["status"])

    def test_read_only_start_is_refused_while_a_writer_owns_the_worktree(self) -> None:
        with patch.dict(os.environ, {"FAKE_CLAUDE_DELAY_SECONDS": "1"}, clear=False):
            with ThreadPoolExecutor(max_workers=2) as executor:
                writer = executor.submit(self.lord.start, "worktree-writer", "claude-cli", str(self.target), "edit")
                deadline = time.time() + 5
                while time.time() < deadline and not any((self.root / "operations").glob("worktree-writer-*.json")):
                    time.sleep(0.01)
                with self.assertRaises(AgentLordError) as raised:
                    self.lord.start(
                        "worktree-reader",
                        "claude-cli",
                        str(self.target),
                        "review",
                        read_only=True,
                    )
                completed = writer.result(timeout=10)

        self.assertEqual("WORKSPACE_WRITE_CONFLICT", raised.exception.code)
        self.assertEqual("read-only", raised.exception.details["requested"])
        self.assertEqual("SUCCEEDED", completed["status"])

    def test_read_only_tasks_share_one_worktree_concurrently(self) -> None:
        with patch.dict(os.environ, {"FAKE_CLAUDE_DELAY_SECONDS": "1"}, clear=False):
            with ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(
                    self.lord.start, "reader-one", "claude-cli", str(self.target), "review", read_only=True
                )
                deadline = time.time() + 5
                while time.time() < deadline and not any((self.root / "operations").glob("reader-one-*.json")):
                    time.sleep(0.01)
                second = self.lord.start(
                    "reader-two",
                    "claude-cli",
                    str(self.target),
                    "review too",
                    read_only=True,
                )
                completed = first.result(timeout=10)

        self.assertEqual("SUCCEEDED", completed["status"])
        self.assertEqual("SUCCEEDED", second["status"])

    def test_preparing_codex_operation_with_a_dead_controller_is_terminalized(self) -> None:
        self._synthetic_operation(
            "stuck-preparing",
            "stuck-preparing-task",
            provider="codex-cli",
            status="preparing",
            controller_pid=99999999,
        )

        result, quiet = self.lord.checkpoint(["stuck-preparing-task"], 2)

        self.assertFalse(quiet)
        actionable = self._single_checkpoint_action(result)
        self.assertEqual("ERROR", actionable["status"])
        self.assertEqual("PROCESS_EXITED_WITHOUT_RESULT", actionable["error"]["code"])
        self.assertTrue(actionable["error"]["retryable"])
        self.assertEqual("failed", load_operation("stuck-preparing", self.root)["status"])

    def test_preparing_codex_operation_with_a_launched_command_needs_a_decision(self) -> None:
        self._synthetic_operation(
            "stuck-launched",
            "stuck-launched-task",
            provider="codex-cli",
            status="preparing",
            controller_pid=99999999,
            provider_command=["codex", "exec"],
        )

        result, quiet = self.lord.checkpoint(["stuck-launched-task"], 2)

        self.assertFalse(quiet)
        actionable = self._single_checkpoint_action(result)
        self.assertEqual("NEEDS_DECISION", actionable["status"])
        self.assertEqual("DELIVERY_UNKNOWN", actionable["error"]["code"])
        self.assertEqual("needs_decision", load_operation("stuck-launched", self.root)["status"])

    def test_preparing_codex_operation_with_a_live_controller_stays_quiet(self) -> None:
        self._synthetic_operation(
            "live-preparing",
            "live-preparing-task",
            provider="codex-cli",
            status="preparing",
            controller_pid=os.getpid(),
        )

        result, quiet = self.lord.checkpoint(["live-preparing-task"], 1)

        self.assertTrue(quiet)
        self.assertEqual("preparing", load_operation("live-preparing", self.root)["status"])

    def test_integrator_rejects_duplicate_integration_order(self) -> None:
        head = self._init_source_repo()
        for task_id, workspace_branch, order in (
            ("dup-worker-one", "fix/dup-one", 1),
            ("dup-worker-two", "fix/dup-two", 2),
        ):
            self.lord.start(
                task_id,
                "claude-cli",
                None,
                "edit",
                head_sha=head,
                repository=str(self.target),
                source_branch="feat/source",
                workspace_policy="isolated",
                workspace_branch=workspace_branch,
                parallel_group="dup-group",
                integration_role="worker",
                integration_target_branch="feat/source",
                integrator_task_id="dup-integrator",
                integration_order=order,
            )

        def duplicate_order(record: Dict[str, Any]) -> Dict[str, Any]:
            contract = dict(record["contract"])
            contract["parallel_plan"] = dict(contract["parallel_plan"], integration_order=1)
            return dict(record, contract=contract)

        # A concurrent worker start that slipped past the group scan leaves exactly this state.
        update_task("dup-worker-two", duplicate_order, self.root)

        with self.assertRaises(AgentLordError) as raised:
            self.lord.start(
                "dup-integrator",
                "claude-cli",
                None,
                "integrate",
                head_sha=head,
                repository=str(self.target),
                source_branch="feat/source",
                workspace_policy="reuse-or-create",
                parallel_group="dup-group",
                integration_role="integrator",
                integration_target_branch="feat/source",
                integration_workers=["dup-worker-one", "dup-worker-two"],
            )

        self.assertEqual("PARALLEL_WRITE_PLAN_INCOMPLETE", raised.exception.code)
        self.assertTrue(raised.exception.requires_authorization)
        self.assertEqual([1, 1], raised.exception.details["observed_order"])

    def test_concurrent_workers_cannot_claim_one_integration_order(self) -> None:
        head = self._init_source_repo()
        common = {
            "provider": "claude-cli",
            "target": None,
            "message": "edit",
            "head_sha": head,
            "repository": str(self.target),
            "source_branch": "feat/source",
            "workspace_policy": "isolated",
            "parallel_group": "race-group",
            "integration_role": "worker",
            "integration_target_branch": "feat/source",
            "integrator_task_id": "race-integrator",
            "integration_order": 1,
        }
        with ThreadPoolExecutor(max_workers=2) as executor:
            submitted = [
                executor.submit(self.lord.start, "race-worker-one", workspace_branch="fix/race-one", **common),
                executor.submit(self.lord.start, "race-worker-two", workspace_branch="fix/race-two", **common),
            ]
            outcomes = []
            for future in submitted:
                try:
                    outcomes.append(future.result(timeout=30)["status"])
                except AgentLordError as error:
                    outcomes.append(error.code)

        self.assertEqual(1, outcomes.count("SUCCEEDED"))
        self.assertEqual(1, outcomes.count("PARALLEL_WRITE_PLAN_INCOMPLETE"))

    def test_transient_codex_list_failure_is_retried_before_terminalizing(self) -> None:
        self._complete_codex_start("route-retry")
        turn = self.lord.turn("route-retry", "cross review")
        stale = self.lord.accept(
            turn["action"]["action_id"],
            "No AppServerManager registered for hostId: old-host",
        )
        self.assertEqual("codex_app__list_threads", stale["action"]["tool"])

        retried = self.lord.accept(stale["action"]["action_id"], "request timed out")

        self.assertEqual("ACTION_REQUIRED", retried["status"])
        self.assertEqual("codex_app__list_threads", retried["action"]["tool"])
        self.assertNotEqual(stale["action"]["action_id"], retried["action"]["action_id"])
        failed = load_action(stale["action"]["action_id"], self.root)
        self.assertEqual("failed", failed["status"])
        self.assertEqual("PROVIDER_FAILED", failed["error"]["code"])
        self.assertEqual(1, failed["error"]["details"]["list_attempt"])
        self.assertEqual("awaiting_action", load_operation(stale["operation_id"], self.root)["status"])

    def test_repeated_codex_list_failures_still_terminalize(self) -> None:
        self._complete_codex_start("route-retry-exhausted")
        turn = self.lord.turn("route-retry-exhausted", "cross review")
        pending = self.lord.accept(
            turn["action"]["action_id"],
            "No AppServerManager registered for hostId: old-host",
        )
        statuses = []
        for _ in range(4):
            pending = self.lord.accept(pending["action"]["action_id"], "request timed out")
            statuses.append(pending["status"])
            if pending["status"] != "ACTION_REQUIRED":
                break

        self.assertEqual("ERROR", statuses[-1])
        self.assertEqual("PROVIDER_FAILED", pending["error"]["code"])

    def _seed_checkpoint_scale(self, operations: int, actions: int) -> str:
        """One supervised task plus a large archive of records other tasks own."""
        self.lord.start("scan-active", "claude-cli", str(self.target), "review", read_only=True)
        active_id = load_task("scan-active", self.root)["last_operation_id"]
        update_operation(
            active_id,
            lambda record: dict(record, status="running", artifact=None, controller_pid=os.getpid()),
            self.root,
        )
        archived = operations - len(operation_paths(self.root))
        for index in range(archived):
            operation_id = "scan-archive-%04d" % index
            self._synthetic_operation(operation_id, "scan-other-%02d" % (index % 20), status="succeeded")
            if index < actions:
                now = utc_now()
                create_action(
                    {
                        "version": 1,
                        "action_id": "%s-a1" % operation_id,
                        "operation_id": operation_id,
                        "task_id": "scan-other-%02d" % (index % 20),
                        "provider": "codex-app",
                        "kind": "codex.read",
                        "tool": "codex_app__read_thread",
                        "arguments": {},
                        "status": "submitted",
                        "created_at": now,
                        "updated_at": now,
                    },
                    self.root,
                )
        return active_id

    def test_checkpoint_scan_stops_reparsing_records_it_already_attributed(self) -> None:
        self._seed_checkpoint_scale(500, 200)
        scan = _CheckpointScan(self.root)
        reads = {"count": 0}
        original = agent_lord.state._read_json

        def counting(*args: Any, **kwargs: Any) -> Dict[str, Any]:
            reads["count"] += 1
            return original(*args, **kwargs)

        with patch("agent_lord.state._read_json", counting):
            scan.tick(["scan-active"])
            first = reads["count"]
            reads["count"] = 0
            scan.tick(["scan-active"])
            second = reads["count"]
            reads["count"] = 0
            scan.tick(["scan-active"])
            third = reads["count"]

        self.assertGreaterEqual(first, 700)
        self.assertLessEqual(second, 10)
        self.assertEqual(second, third)

    def test_checkpoint_scan_cache_reports_the_same_envelope_as_a_cold_scan(self) -> None:
        self._seed_checkpoint_scale(500, 200)
        cold = _CheckpointScan(self.root)
        cold.tick(["scan-active"])
        warm = _CheckpointScan(self.root)
        for _ in range(3):
            warm.tick(["scan-active"])

        cold_active = self.lord._active_task_operations(["scan-active"], cold)
        warm_active = self.lord._active_task_operations(["scan-active"], warm)

        self.assertEqual(
            self.lord._compact_checkpoint_active(cold_active),
            self.lord._compact_checkpoint_active(warm_active),
        )
        self.assertEqual(
            self.lord._checkpoint_actionable(["scan-active"], cold_active, cold),
            self.lord._checkpoint_actionable(["scan-active"], warm_active, warm),
        )
        self.assertEqual(1, len(warm_active))
        self.assertEqual("scan-active", warm_active[0][0]["task_id"])

    def test_checkpoint_without_any_active_task_returns_immediately(self) -> None:
        self.lord.start("finished-task", "claude-cli", str(self.target), "review", read_only=True)

        started = time.monotonic()
        result, quiet = self.lord.checkpoint(None, 30)
        elapsed = time.monotonic() - started

        self.assertTrue(quiet)
        self.assertEqual("CHECKPOINT_QUIET", result["status"])
        self.assertEqual([], result["active"])
        self.assertLess(elapsed, 5)

    def _running_operation_for_task(self, task_id: str, controller_pid: int) -> str:
        self.lord.start(task_id, "claude-cli", str(self.target), "review", read_only=True)
        operation_id = load_task(task_id, self.root)["last_operation_id"]
        update_operation(
            operation_id,
            lambda record: dict(record, status="running", artifact=None, controller_pid=controller_pid),
            self.root,
        )
        return operation_id

    def test_check_reports_a_supervision_hint_for_a_dead_controller(self) -> None:
        self._running_operation_for_task("dead-controller-task", 99999999)

        envelope = self.lord.check("dead-controller-task")

        self.assertEqual("RUNNING", envelope["status"])
        self.assertEqual(
            {"controller_state": "exited", "recovery_command": "checkpoint"},
            envelope["observed"]["supervision"],
        )

    def test_check_adds_no_supervision_hint_while_the_controller_lives(self) -> None:
        self._running_operation_for_task("live-controller-task", os.getpid())

        envelope = self.lord.check("live-controller-task")

        self.assertEqual("RUNNING", envelope["status"])
        self.assertNotIn("supervision", envelope["observed"])

    def test_cli_rejects_codex_app_only_arguments_for_cli_providers(self) -> None:
        for extra in ({"codex_environment": "local"}, {"starting_branch": "feat/x"}):
            with self.subTest(extra=extra):
                with self.assertRaises(AgentLordError) as raised:
                    self.lord.start(
                        "cli-only-" + "".join(extra),
                        "claude-cli",
                        str(self.target),
                        "review",
                        read_only=True,
                        **extra,
                    )
                self.assertEqual("CONFIG_INVALID", raised.exception.code)

    def test_cli_start_parser_leaves_codex_environment_unset(self) -> None:
        parsed = build_parser().parse_args(
            ["start", "--task-id", "t", "--provider", "claude-cli", "--target", "/tmp", "--message-file", "m"]
        )
        self.assertIsNone(parsed.codex_environment)
        self.assertIsNone(parsed.starting_branch)

    def test_accept_parser_exposes_opt_in_auto_read(self) -> None:
        default = build_parser().parse_args(["accept", "--action-id", "a", "--result-file", "r"])
        enabled = build_parser().parse_args(["accept", "--action-id", "a", "--result-file", "r", "--auto-read"])
        self.assertFalse(default.auto_read)
        self.assertTrue(enabled.auto_read)

    def test_corrupt_provider_config_prints_one_json_error(self) -> None:
        broken = Path(self.temporary.name) / "broken-providers.json"
        broken.write_text("{ not json", encoding="utf-8")
        environment = dict(os.environ, AGENT_LORD_PROVIDER_CONFIG=str(broken))

        completed = subprocess.run(
            [sys.executable, str(Path(__file__).resolve().parent.parent / "scripts" / "agent_lord.py"), "check", "--task-id", "x"],
            capture_output=True,
            text=True,
            env=environment,
        )

        self.assertEqual(2, completed.returncode)
        self.assertEqual("", completed.stderr.strip())
        payload = json.loads(completed.stdout)
        self.assertEqual("ERROR", payload["status"])
        self.assertEqual("CONFIG_INVALID", payload["error"]["code"])

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

    def _handoff_packet(self, task_id: str, **overrides: Any) -> Dict[str, Any]:
        packet: Dict[str, Any] = {
            "schema": "handoff-v1",
            "handoff_id": "handoff-20260902-a",
            "created_at": "2026-09-02T10:00:00+00:00",
            "source_session": {"kind": "codex-desktop"},
            "continuation": {"task_id": task_id},
            "authorization": {
                "task": "continue the authorized refactor and add its tests",
                "workspace_writes": True,
                "external_writes": False,
            },
            "objective": "finish the user-specified continuation task",
            "completed_work": ["implemented the core module"],
            "remaining_work": ["add focused tests for the new module"],
            "constraints": ["do not commit, push, or publish"],
            "acceptance_criteria": ["focused tests pass"],
            "evidence": [{"path": "tracked.txt", "note": "existing source file"}],
            "sanitization": {"raw_provider_logs": False, "hidden_reasoning": False, "secrets": False},
        }
        packet.update({name: value for name, value in overrides.items() if name != "integrity"})
        if "integrity" in overrides:
            packet["integrity"] = overrides["integrity"]
        else:
            packet["integrity"] = {"sha256": hashlib.sha256(canonical_packet_bytes(packet)).hexdigest()}
        return packet

    def _write_packet(self, packet: Dict[str, Any], name: str = "packet.json") -> str:
        path = Path(self.temporary.name) / name
        path.write_text(json.dumps(packet, ensure_ascii=False), encoding="utf-8")
        return str(path)

    def _dirty_workspace(self) -> None:
        (self.target / "tracked.txt").write_text("source\nlocal work in progress\n", encoding="utf-8")
        (self.target / "wip.txt").write_text("uncommitted continuation evidence\n", encoding="utf-8")

    def test_handoff_starts_codex_continuation_with_lineage_and_snapshot(self) -> None:
        head = self._init_source_repo()
        self._dirty_workspace()
        packet = self._handoff_packet("xx-continuation")
        result = self.lord.handoff(
            "xx-continuation",
            self._write_packet(packet),
            provider="codex-cli",
            target=str(self.target),
            model="gpt-5.6-sol",
            effort="high",
            head_sha=head,
        )

        self.assertEqual("SUCCEEDED", result["status"])
        canonical = canonical_packet_bytes(packet)
        packet_sha = hashlib.sha256(canonical).hexdigest()
        self.assertEqual(packet_sha, result["handoff"]["packet_sha256"])
        self.assertEqual("continues_user_task", result["handoff"]["relationship"])
        self.assertTrue(result["handoff"]["workspace_snapshot"]["dirty"])
        self.assertEqual(2, result["handoff"]["workspace_snapshot"]["changed_path_count"])
        self.assertEqual(head, result["handoff"]["workspace_snapshot"]["head_sha"])

        task = load_task("xx-continuation", self.root)
        self.assertEqual("handoff", task["lineage"]["kind"])
        self.assertEqual(packet_sha, task["lineage"]["packet_sha256"])
        self.assertEqual("codex-desktop", task["lineage"]["source_session_kind"])
        self.assertEqual(result["endpoint_id"], task["endpoint_id"])

        operation = load_operation(result["operation_id"], self.root)
        self.assertEqual("handoff", operation["kind"])
        self.assertIn("packet_sha256: " + packet_sha, operation["message"])
        self.assertIn(packet["objective"], operation["message"])
        self.assertIn("external_writes: forbidden", operation["message"])
        self.assertEqual("codex final", Path(result["artifact"]["path"]).read_text(encoding="utf-8").strip())

        stored = Path(operation["handoff"]["packet"]["path"])
        self.assertEqual(str(self.root / "artifacts" / "xx-continuation" / (result["operation_id"] + ".handoff-v1.json")), str(stored))
        self.assertEqual(canonical, stored.read_bytes())

    def test_handoff_claude_continuation_delivers_packet_prompt_to_new_session(self) -> None:
        self._init_source_repo()
        self._dirty_workspace()
        packet = self._handoff_packet("cc-continuation", handoff_id="handoff-20260902-b")
        result = self.lord.handoff(
            "cc-continuation",
            self._write_packet(packet),
            provider="claude-cli",
            target=str(self.target),
        )

        self.assertEqual("SUCCEEDED", result["status"])
        arguments = json.loads(self.argv_log.read_text(encoding="utf-8").splitlines()[0])
        self.assertIn("--session-id", arguments)
        self.assertEqual(result["endpoint_id"], arguments[arguments.index("--session-id") + 1])
        packet_sha = hashlib.sha256(canonical_packet_bytes(packet)).hexdigest()
        artifact_text = Path(result["artifact"]["path"]).read_text(encoding="utf-8")
        self.assertIn("packet_sha256: " + packet_sha, artifact_text)
        self.assertIn(packet["objective"], artifact_text)
        task = load_task("cc-continuation", self.root)
        self.assertEqual(packet_sha, task["lineage"]["packet_sha256"])

    def test_handoff_replay_is_idempotent_and_starts_no_second_endpoint(self) -> None:
        self._init_source_repo()
        self._dirty_workspace()
        packet_path = self._write_packet(self._handoff_packet("replay-continuation"))
        first = self.lord.handoff(
            "replay-continuation",
            packet_path,
            provider="codex-cli",
            target=str(self.target),
        )
        second = self.lord.handoff(
            "replay-continuation",
            packet_path,
            provider="codex-cli",
            target=str(self.target),
        )

        self.assertEqual("SUCCEEDED", first["status"])
        self.assertEqual(first["operation_id"], second["operation_id"])
        self.assertEqual(first["endpoint_id"], second["endpoint_id"])
        self.assertEqual(1, len(self.codex_argv_log.read_text(encoding="utf-8").splitlines()))

    def test_handoff_same_task_with_a_different_packet_fails_closed(self) -> None:
        self._init_source_repo()
        self._dirty_workspace()
        self.lord.handoff(
            "conflict-continuation",
            self._write_packet(self._handoff_packet("conflict-continuation")),
            provider="codex-cli",
            target=str(self.target),
        )
        changed = self._handoff_packet("conflict-continuation", remaining_work=["a different follow-up task"])

        with self.assertRaises(AgentLordError) as raised:
            self.lord.handoff(
                "conflict-continuation",
                self._write_packet(changed, name="packet-2.json"),
                provider="codex-cli",
                target=str(self.target),
            )
        self.assertEqual("HANDOFF_CONFLICT", raised.exception.code)
        self.assertEqual(1, len(self.codex_argv_log.read_text(encoding="utf-8").splitlines()))

    def test_handoff_rejects_invalid_packets_before_any_dispatch(self) -> None:
        bad_packets = {
            "wrong-schema": self._handoff_packet("t1", schema="handoff-v2"),
            "unknown-field": self._handoff_packet("t1", transcript="raw provider text"),
            "missing-objective": {
                name: value for name, value in self._handoff_packet("t1").items() if name != "objective"
            },
            "absolute-evidence-path": self._handoff_packet("t1", evidence=[{"path": "/etc/passwd"}]),
            "escaping-evidence-path": self._handoff_packet("t1", evidence=[{"path": "../outside.txt"}]),
            "oversize-string": self._handoff_packet("t1", objective="x" * 9000),
            "oversize-packet": self._handoff_packet("t1", completed_work=["y" * 8000 for _ in range(9)]),
            "secret-token": self._handoff_packet("t1", completed_work=["token ghp_" + "a" * 36]),
            "unsanitized": self._handoff_packet(
                "t1",
                sanitization={"raw_provider_logs": True, "hidden_reasoning": False, "secrets": False},
            ),
            "tampered-digest": self._handoff_packet("t1", integrity={"sha256": "0" * 64}),
        }
        for name, packet in bad_packets.items():
            with self.subTest(packet=name):
                with self.assertRaises(AgentLordError) as raised:
                    self.lord.handoff("t1", self._write_packet(packet, name=name + ".json"), provider="codex-cli", target=str(self.target))
                self.assertEqual("HANDOFF_PACKET_INVALID", raised.exception.code)
        self.assertEqual([], operation_paths(self.root))
        self.assertFalse(self.codex_argv_log.exists())

    def test_handoff_binding_contract_and_permission_conflicts_fail_closed(self) -> None:
        conflicts = (
            (
                "other-task-binding",
                self._handoff_packet("someone-else"),
                {"provider": "codex-cli"},
                "HANDOFF_CONFLICT",
            ),
            (
                "provider-conflict",
                self._handoff_packet("t2", contract_request={"provider": "codex-cli"}),
                {"provider": "claude-cli"},
                "HANDOFF_CONFLICT",
            ),
            (
                "model-conflict",
                self._handoff_packet("t2", contract_request={"provider": "codex-cli", "model": "gpt-5.6-sol"}),
                {"model": "gpt-5.5"},
                "HANDOFF_CONFLICT",
            ),
            (
                "writes-need-writable",
                self._handoff_packet("t2"),
                {"provider": "codex-cli", "read_only": True},
                "HANDOFF_CONFLICT",
            ),
            (
                "readonly-packet-needs-read-only",
                self._handoff_packet(
                    "t2",
                    authorization={"task": "review only", "workspace_writes": False, "external_writes": False},
                ),
                {"provider": "codex-cli"},
                "HANDOFF_CONFLICT",
            ),
            (
                "codex-app-rejected",
                self._handoff_packet("t2"),
                {"provider": "codex-app"},
                "CONFIG_INVALID",
            ),
            (
                "no-provider-anywhere",
                self._handoff_packet("t2"),
                {},
                "CONFIG_INVALID",
            ),
        )
        for name, packet, kwargs, expected_code in conflicts:
            with self.subTest(conflict=name):
                with self.assertRaises(AgentLordError) as raised:
                    self.lord.handoff("t2", self._write_packet(packet, name=name + ".json"), target=str(self.target), **kwargs)
                self.assertEqual(expected_code, raised.exception.code)
        self.assertEqual([], operation_paths(self.root))
        self.assertFalse(self.codex_argv_log.exists())

    def test_handoff_source_identity_is_recorded_never_fabricated(self) -> None:
        self._init_source_repo()
        anonymous = self.lord.handoff(
            "anon-continuation",
            self._write_packet(self._handoff_packet("anon-continuation")),
            provider="codex-cli",
            target=str(self.target),
        )
        declared = self.lord.handoff(
            "declared-continuation",
            self._write_packet(
                self._handoff_packet(
                    "declared-continuation",
                    source_session={"kind": "codex-desktop", "opaque_id": "desktop-thread-123"},
                ),
                name="declared.json",
            ),
            provider="codex-cli",
            target=str(self.target),
        )

        anon_task = load_task("anon-continuation", self.root)
        self.assertEqual("unavailable", anon_task["lineage"]["source_session_identity"])
        self.assertIsNone(anon_task["lineage"]["source_session_id"])
        declared_task = load_task("declared-continuation", self.root)
        self.assertEqual("caller-declared", declared_task["lineage"]["source_session_identity"])
        self.assertEqual("desktop-thread-123", declared_task["lineage"]["source_session_id"])
        for envelope in (anonymous, declared):
            self.assertIn(envelope["handoff"]["source_session"]["identity_assurance"], ("caller-declared", "unavailable"))

    def test_handoff_head_mismatch_starts_no_endpoint(self) -> None:
        self._init_source_repo()
        with self.assertRaises(AgentLordError) as raised:
            self.lord.handoff(
                "pinned-continuation",
                self._write_packet(self._handoff_packet("pinned-continuation")),
                provider="codex-cli",
                target=str(self.target),
                head_sha="0" * 40,
            )
        self.assertEqual("SOURCE_MISMATCH", raised.exception.code)
        self.assertEqual([], operation_paths(self.root))
        self.assertFalse(self.codex_argv_log.exists())

    def test_handoff_workspace_drift_between_snapshot_and_dispatch_fails_closed(self) -> None:
        self._init_source_repo()
        self._dirty_workspace()
        snapshots = [
            {"head_sha": "1" * 40, "dirty": True, "changed_path_count": 2, "sha256": "a" * 64},
            {"head_sha": "1" * 40, "dirty": True, "changed_path_count": 3, "sha256": "b" * 64},
        ]
        with patch("agent_lord.engine.snapshot_exact_target", side_effect=snapshots):
            with self.assertRaises(AgentLordError) as raised:
                self.lord.handoff(
                    "drift-continuation",
                    self._write_packet(self._handoff_packet("drift-continuation")),
                    provider="codex-cli",
                    target=str(self.target),
                )
        self.assertEqual("SOURCE_MISMATCH", raised.exception.code)
        self.assertEqual("RETRY_SAME_COMMAND", raised.exception.safe_recovery)
        operations = [agent_lord.state.read_operation_path(path) for path in operation_paths(self.root)]
        self.assertEqual(["failed"], [operation["status"] for operation in operations])
        self.assertFalse(self.codex_argv_log.exists())

    def test_handoff_provider_failure_is_terminal_then_safely_retryable(self) -> None:
        self._init_source_repo()
        self._dirty_workspace()
        broken_codex = Path(self.temporary.name) / "broken-codex"
        broken_codex.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        broken_codex.chmod(broken_codex.stat().st_mode | stat.S_IXUSR)
        packet_path = self._write_packet(self._handoff_packet("retry-continuation"))

        with patch.dict(os.environ, {"AGENT_LORD_CODEX_BIN": str(broken_codex)}, clear=False):
            with self.assertRaises(AgentLordError) as raised:
                self.lord.handoff(
                    "retry-continuation",
                    packet_path,
                    provider="codex-cli",
                    target=str(self.target),
                )
        self.assertEqual("RESULT_INVALID", raised.exception.code)
        self.assertEqual("RETRY_SAME_COMMAND", raised.exception.safe_recovery)
        self.assertFalse((self.root / "retry-continuation.json").exists())

        retried = self.lord.handoff(
            "retry-continuation",
            packet_path,
            provider="codex-cli",
            target=str(self.target),
        )
        self.assertEqual("SUCCEEDED", retried["status"])
        self.assertNotEqual(raised.exception.details.get("operation_id"), retried["operation_id"])
        task = load_task("retry-continuation", self.root)
        self.assertEqual(retried["endpoint_id"], task["endpoint_id"])
        self.assertEqual("handoff", task["lineage"]["kind"])

    def test_handoff_validate_only_touches_no_durable_state(self) -> None:
        packet = self._handoff_packet("validate-continuation")
        result = self.lord.handoff(
            "validate-continuation",
            self._write_packet(packet),
            provider="codex-cli",
            validate_only=True,
        )

        self.assertEqual("SUCCEEDED", result["status"])
        self.assertTrue(result["handoff"]["validated_only"])
        self.assertEqual(
            hashlib.sha256(canonical_packet_bytes(packet)).hexdigest(),
            result["handoff"]["packet_sha256"],
        )
        self.assertNotIn("operation_id", result)
        self.assertEqual([], operation_paths(self.root))
        self.assertFalse((self.root / "validate-continuation.json").exists())

    def test_handoff_task_continues_with_turn_on_the_same_endpoint(self) -> None:
        self._init_source_repo()
        self._dirty_workspace()
        started = self.lord.handoff(
            "loop-continuation",
            self._write_packet(self._handoff_packet("loop-continuation")),
            provider="codex-cli",
            target=str(self.target),
        )
        turned = self.lord.turn("loop-continuation", "report the current test status")

        self.assertEqual("SUCCEEDED", turned["status"])
        self.assertEqual(started["endpoint_id"], turned["endpoint_id"])
        invocations = [json.loads(line) for line in self.codex_argv_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(2, len(invocations))
        self.assertIn("resume", invocations[1])
        self.assertIn(started["endpoint_id"], invocations[1])


if __name__ == "__main__":
    unittest.main()
