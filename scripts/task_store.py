#!/usr/bin/env python3
"""Minimal fail-closed endpoint store for Agent Lord."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import Any


PROVIDERS = ("codex-app", "claude-cli")
TASK_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


class StoreError(Exception):
    """An expected, user-actionable store failure."""


def state_dir() -> Path:
    configured = os.environ.get("AGENT_LORD_STATE_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return Path.home() / ".codex" / "state" / "agent-lord"


def validate_task_id(task_id: str) -> str:
    if not TASK_ID_PATTERN.fullmatch(task_id):
        raise StoreError(
            "task_id must start with an alphanumeric character and contain only "
            "letters, digits, dot, underscore, or hyphen (maximum 128 characters)"
        )
    return task_id


def validate_text(name: str, value: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise StoreError(f"{name} must be a non-empty string without NUL bytes")
    return value


def task_path(task_id: str) -> Path:
    return state_dir() / f"{validate_task_id(task_id)}.json"


def load_record(task_id: str) -> dict[str, Any]:
    path = task_path(task_id)
    try:
        with path.open("r", encoding="utf-8") as handle:
            record = json.load(handle)
    except FileNotFoundError as exc:
        raise StoreError(f"unknown task_id: {task_id}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise StoreError(f"cannot read task record {path}: {exc}") from exc

    return validate_record(path, task_id, record)


def validate_record(path: Path, task_id: str, record: Any) -> dict[str, Any]:
    expected_keys = {
        "version",
        "task_id",
        "provider",
        "endpoint_id",
        "host_id",
        "target",
        "created_at",
    }
    if not isinstance(record, dict):
        raise StoreError(f"task record {path} is not a JSON object")
    if set(record) != expected_keys:
        raise StoreError(f"task record {path} has an unexpected shape")
    if record["version"] != 1 or record["task_id"] != task_id:
        raise StoreError(f"task record {path} has inconsistent identity or version")
    if record["provider"] not in PROVIDERS:
        raise StoreError(f"task record {path} has an unknown provider")

    validate_text("endpoint_id", record["endpoint_id"])
    validate_text("target", record["target"])
    validate_text("created_at", record["created_at"])
    host_id = record["host_id"]
    if record["provider"] == "codex-app":
        validate_text("host_id", host_id)
    elif host_id is not None:
        raise StoreError(f"task record {path} gives claude-cli an invalid host_id")
    return record


def dump(record: dict[str, Any]) -> str:
    return json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True)


def put(args: argparse.Namespace) -> dict[str, Any]:
    task_id = validate_task_id(args.task_id)
    endpoint_id = validate_text("endpoint_id", args.endpoint_id)
    target = validate_text("target", args.target)

    if args.provider == "codex-app" and not args.host_id:
        raise StoreError("host_id is required for provider codex-app")
    if args.provider == "claude-cli" and args.host_id:
        raise StoreError("host_id is not accepted for provider claude-cli")

    record: dict[str, Any] = {
        "version": 1,
        "task_id": task_id,
        "provider": args.provider,
        "endpoint_id": endpoint_id,
        "host_id": args.host_id or None,
        "target": target,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    directory = state_dir()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = task_path(task_id)

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=directory,
            prefix=f".{task_id}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(dump(record))
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(temporary_path, 0o600)
        try:
            os.link(temporary_path, path)
        except FileExistsError as exc:
            raise StoreError(f"task_id already exists: {task_id}") from exc
    except StoreError:
        raise
    except OSError as exc:
        raise StoreError(f"cannot create task record {path}: {exc}") from exc
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass

    return record


def remove(task_id: str) -> dict[str, Any]:
    record = load_record(task_id)
    path = task_path(task_id)
    try:
        path.unlink()
    except OSError as exc:
        raise StoreError(f"cannot remove task record {path}: {exc}") from exc
    return record


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Store Agent Lord task endpoints outside repositories."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    put_parser = subparsers.add_parser("put", help="register a new task endpoint")
    put_parser.add_argument("--task-id", required=True)
    put_parser.add_argument("--provider", required=True, choices=PROVIDERS)
    put_parser.add_argument("--endpoint-id", required=True)
    put_parser.add_argument("--host-id")
    put_parser.add_argument("--target", required=True)

    get_parser = subparsers.add_parser("get", help="read one task endpoint")
    get_parser.add_argument("--task-id", required=True)

    remove_parser = subparsers.add_parser(
        "remove", help="remove a closed or verified non-start task endpoint"
    )
    remove_parser.add_argument("--task-id", required=True)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "put":
            record = put(args)
        elif args.command == "get":
            record = load_record(args.task_id)
        else:
            record = remove(args.task_id)
    except StoreError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(dump(record))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
