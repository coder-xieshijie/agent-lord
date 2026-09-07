#!/usr/bin/env python3
"""Public deterministic CLI for the Agent Lord skill."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any, Dict, List, Optional


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agent_lord import AgentLord, AgentLordError  # noqa: E402
from agent_lord.config import control_config  # noqa: E402


def read_text(path: str) -> str:
    try:
        return Path(path).expanduser().resolve().read_text(encoding="utf-8")
    except OSError as exc:
        raise AgentLordError("CONFIG_INVALID", "cannot read input file", details={"path": path, "error": str(exc)}, exit_code=2) from exc


def read_result(path: str) -> Any:
    text = read_text(path)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def print_json(value: Dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Deterministic durable-endpoint orchestration.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    start = subparsers.add_parser("start", help="create one durable endpoint")
    start.add_argument("--task-id", required=True)
    start.add_argument(
        "--provider",
        required=True,
        choices=("claude-cli", "codex", "codex-cli", "mcode", "mcode-cli", "codex-app"),
    )
    target = start.add_mutually_exclusive_group(required=True)
    target.add_argument("--target", help="existing provider working directory")
    target.add_argument("--repo", help="repository whose source-branch worktree should be prepared")
    start.add_argument("--message-file", required=True)
    start.add_argument("--model")
    start.add_argument("--effort")
    start.add_argument("--retry-attempts", type=int, help="override the primary Claude CLI attempt budget")
    start.add_argument(
        "--read-only",
        action="store_true",
        help="override the default dangerously_bypass permission posture with provider read-only enforcement",
    )
    start.add_argument("--head-sha")
    start.add_argument("--base-sha")
    start.add_argument("--source-branch", help="source branch to reuse or create when --repo is used")
    start.add_argument(
        "--workspace-policy",
        choices=("reuse-or-create", "shared-readonly", "isolated"),
        help="shared fixed-head review, canonical branch workspace, or isolated writable branch",
    )
    start.add_argument("--workspace-branch", help="explicit temporary branch for isolated writable work")
    start.add_argument("--worktree-root", help="optional parent directory for a newly created worktree")
    start.add_argument("--parallel-group", help="caller-declared parallel write group")
    start.add_argument("--integration-role", choices=("worker", "integrator"))
    start.add_argument("--integration-target-branch", help="original MR source branch receiving integrated changes")
    start.add_argument("--integrator-task-id", help="declared integrator for a parallel worker")
    start.add_argument("--integration-order", type=int, help="positive worker integration position")
    start.add_argument(
        "--integration-worker",
        action="append",
        dest="integration_workers",
        help="worker task id in integration order; repeat for the integrator",
    )
    start.add_argument(
        "--codex-environment",
        choices=("worktree", "local"),
        help="codex-app thread environment; rejected for CLI providers (default: worktree)",
    )
    start.add_argument("--starting-branch", help="codex-app starting branch; rejected for CLI providers")

    turn = subparsers.add_parser("turn", help="continue the exact saved endpoint")
    turn.add_argument("--task-id", required=True)
    turn.add_argument("--message-file", required=True)

    handoff = subparsers.add_parser(
        "handoff",
        help="validate a sanitized handoff-v1 packet and start its continuation CLI endpoint",
    )
    handoff.add_argument("--task-id", required=True, help="new continuation task id; must match the packet binding")
    handoff.add_argument("--packet-file", required=True, help="caller-owned handoff-v1 JSON packet file")
    handoff.add_argument(
        "--provider",
        choices=("claude-cli", "codex", "codex-cli", "mcode", "mcode-cli"),
        help="continuation provider; defaults to the packet's contract request",
    )
    handoff.add_argument("--target", help="exact existing workspace the continuation runs in")
    handoff.add_argument("--model")
    handoff.add_argument("--effort")
    handoff.add_argument("--retry-attempts", type=int, help="override the primary Claude CLI attempt budget")
    handoff.add_argument(
        "--read-only",
        action="store_true",
        help="require provider read-only enforcement; must match the packet's workspace-write authorization",
    )
    handoff.add_argument("--head-sha")
    handoff.add_argument("--base-sha")
    handoff.add_argument(
        "--validate-only",
        action="store_true",
        help="validate the packet, binding, and contract request without touching durable state",
    )

    accept = subparsers.add_parser("accept", help="validate one model-mediated Codex host-tool result")
    accept.add_argument("--action-id", required=True)
    accept.add_argument("--result-file", required=True)
    accept.add_argument(
        "--auto-read",
        action="store_true",
        help="return the next read action directly instead of requiring another check round",
    )

    check = subparsers.add_parser("check", help="reconstruct one task's current state")
    check.add_argument("--task-id", required=True)

    checkpoint = subparsers.add_parser(
        "checkpoint",
        help="run one bounded foreground supervision checkpoint",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    checkpoint.add_argument(
        "--task-id",
        action="append",
        dest="task_ids",
        help="task to supervise; repeat for one multi-task checkpoint (default: all active tasks)",
    )
    checkpoint.add_argument(
        "--seconds",
        type=int,
        default=control_config()["checkpoint_seconds"],
        help="maximum quiet interval before exit 124",
    )

    export = subparsers.add_parser("export-artifact", help="extract only the last final assistant message from a provider JSONL")
    export.add_argument("--task-id", required=True)
    export.add_argument("--operation-id", required=True)
    export.add_argument("--source-file", required=True)
    export.add_argument(
        "--source-format",
        required=True,
        choices=("claude-jsonl", "codex-jsonl", "mcode-stream-json"),
    )
    return parser


def run(args: argparse.Namespace) -> Dict[str, Any]:
    lord = AgentLord()
    if args.command == "start":
        return lord.start(
            args.task_id,
            args.provider,
            args.target,
            read_text(args.message_file),
            model=args.model,
            effort=args.effort,
            retry_attempts=args.retry_attempts,
            read_only=args.read_only,
            head_sha=args.head_sha,
            base_sha=args.base_sha,
            repository=args.repo,
            source_branch=args.source_branch,
            workspace_policy=args.workspace_policy,
            workspace_branch=args.workspace_branch,
            worktree_root=args.worktree_root,
            parallel_group=args.parallel_group,
            integration_role=args.integration_role,
            integration_target_branch=args.integration_target_branch,
            integrator_task_id=args.integrator_task_id,
            integration_order=args.integration_order,
            integration_workers=args.integration_workers,
            codex_environment=args.codex_environment,
            starting_branch=args.starting_branch,
        )
    if args.command == "turn":
        return lord.turn(args.task_id, read_text(args.message_file))
    if args.command == "handoff":
        return lord.handoff(
            args.task_id,
            args.packet_file,
            provider=args.provider,
            target=args.target,
            model=args.model,
            effort=args.effort,
            read_only=args.read_only,
            head_sha=args.head_sha,
            base_sha=args.base_sha,
            retry_attempts=args.retry_attempts,
            validate_only=args.validate_only,
        )
    if args.command == "accept":
        return lord.accept(args.action_id, read_result(args.result_file), auto_read=args.auto_read)
    if args.command == "check":
        return lord.check(args.task_id)
    if args.command == "checkpoint":
        result, quiet = lord.checkpoint(args.task_ids, args.seconds)
        result["_quiet_exit_124"] = quiet
        return result
    return lord.export_artifact(args.task_id, args.operation_id, args.source_file, args.source_format)


def main() -> int:
    try:
        # build_parser reads control config, so a corrupt config must still exit as one JSON object.
        parser = build_parser()
        args = parser.parse_args()
        result = run(args)
    except AgentLordError as error:
        status = "NEEDS_DECISION" if error.requires_authorization else "ERROR"
        print_json({"version": 1, "status": status, "error": error.as_dict()})
        return error.exit_code
    quiet = bool(result.pop("_quiet_exit_124", False))
    print_json(result)
    return 124 if quiet else 0


if __name__ == "__main__":
    raise SystemExit(main())
