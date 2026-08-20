#!/usr/bin/env python3
"""Compatibility CLI for Agent Lord task records.

New orchestration should use ``scripts/agent_lord.py``. This wrapper keeps the
original put/get/remove interface, adds an explicit version 1 upgrade path,
writes the version 2 execution-contract shape, and reads old handles safely.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from typing import Any, Dict


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agent_lord.config import permission_policy, provider_config, validate_effort  # noqa: E402
from agent_lord.errors import AgentLordError  # noqa: E402
from agent_lord.state import create_task, load_task, remove_task, update_task, utc_now, validate_identifier  # noqa: E402


SHA_PATTERN = re.compile(r"[0-9a-fA-F]{40}\Z")


def dump(value: Dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)


def put(args: argparse.Namespace) -> Dict[str, Any]:
    validate_identifier("task_id", args.task_id)
    provider_config(args.provider)
    for name in ("endpoint_id", "target"):
        value = getattr(args, name)
        if not isinstance(value, str) or not value or "\x00" in value:
            raise AgentLordError("CONFIG_INVALID", "%s must be a non-empty string without NUL bytes" % name, exit_code=2)
    if args.effort:
        validate_effort(args.provider, args.effort)
    if args.provider == "codex-app" and not args.host_id:
        raise AgentLordError("CONFIG_INVALID", "host_id is required for provider codex-app", exit_code=2)
    if args.provider == "claude-cli" and args.host_id:
        raise AgentLordError("CONFIG_INVALID", "host_id is not accepted for provider claude-cli", exit_code=2)
    now = utc_now()
    history = []
    if args.host_id:
        history.append({"host_id": args.host_id, "observed_at": now, "reason": "manual-registration"})
    permission = permission_policy(args.provider, args.read_only)
    value: Dict[str, Any] = {
        "version": 2,
        "task_id": args.task_id,
        "provider": args.provider,
        "endpoint_id": args.endpoint_id,
        "target": args.target,
        "route": {"host_id": args.host_id, "resolved_at": now, "history": history},
        "contract": {
            "model": args.model,
            "effort": args.effort,
            "read_only": args.read_only,
            "permission_mode": permission["mode"],
            "source": {},
        },
        "created_at": now,
        "updated_at": now,
        "last_operation_id": None,
    }
    return create_task(value)


def upgrade(args: argparse.Namespace) -> Dict[str, Any]:
    task = load_task(args.task_id)
    if task.get("legacy_version") != 1:
        raise AgentLordError("CONFIG_INVALID", "task record is already version 2", exit_code=2)
    validate_effort(task["provider"], args.effort)
    permission = permission_policy(task["provider"], args.read_only)
    source: Dict[str, str] = {}
    for name in ("head_sha", "base_sha"):
        value = getattr(args, name)
        if value:
            if not SHA_PATTERN.fullmatch(value):
                raise AgentLordError("CONFIG_INVALID", "%s must be a full 40-character git SHA" % name, exit_code=2)
            source[name] = value.lower()

    def mutate(value: Dict[str, Any]) -> Dict[str, Any]:
        value["contract"] = {
            "model": args.model,
            "effort": args.effort,
            "read_only": args.read_only,
            "permission_mode": permission["mode"],
            "source": source,
        }
        return value

    return update_task(args.task_id, mutate)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read, register, or explicitly upgrade Agent Lord task endpoints.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    put_parser = subparsers.add_parser("put", help="register a pre-existing endpoint")
    put_parser.add_argument("--task-id", required=True)
    put_parser.add_argument("--provider", required=True, choices=("codex-app", "claude-cli"))
    put_parser.add_argument("--endpoint-id", required=True)
    put_parser.add_argument("--host-id")
    put_parser.add_argument("--target", required=True)
    put_parser.add_argument("--model")
    put_parser.add_argument("--effort")
    put_parser.add_argument(
        "--read-only",
        action="store_true",
        help="override the default dangerously_bypass permission posture",
    )

    get_parser = subparsers.add_parser("get", help="read one endpoint")
    get_parser.add_argument("--task-id", required=True)

    upgrade_parser = subparsers.add_parser("upgrade", help="attach an explicit execution contract to a version 1 endpoint")
    upgrade_parser.add_argument("--task-id", required=True)
    upgrade_parser.add_argument("--model", required=True)
    upgrade_parser.add_argument("--effort", required=True)
    upgrade_parser.add_argument(
        "--read-only",
        action="store_true",
        help="override the default dangerously_bypass permission posture",
    )
    upgrade_parser.add_argument("--head-sha")
    upgrade_parser.add_argument("--base-sha")

    remove_parser = subparsers.add_parser("remove", help="remove a closed or verified non-start endpoint")
    remove_parser.add_argument("--task-id", required=True)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "put":
            value = put(args)
        elif args.command == "get":
            value = load_task(args.task_id)
        elif args.command == "upgrade":
            value = upgrade(args)
        else:
            value = remove_task(args.task_id)
    except AgentLordError as error:
        print("error[%s]: %s" % (error.code, error.message), file=sys.stderr)
        return error.exit_code
    print(dump(value))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
