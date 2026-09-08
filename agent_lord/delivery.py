"""Deterministic file/commit evidence, separate from provider execution success.

This checks declared structural requirements only. Tests, browser behaviour and
semantic acceptance are never inferred from the provider's final prose.
"""

from __future__ import annotations

from pathlib import Path
import subprocess
from typing import Any, Dict, List, Optional

from .errors import AgentLordError


def _git(target: str, *args: str) -> Optional[str]:
    try:
        result = subprocess.run(["git", "-C", target, *args], capture_output=True, text=True, check=False, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def same_request(operation: Dict[str, Any], files: Optional[List[str]], require_commit: bool) -> bool:
    spec = operation.get("delivery_requirements") or {}
    return spec.get("files", []) == sorted(set(Path(name).as_posix() for name in files or [])) and bool(spec.get("require_commit")) == require_commit


def requirements(target: str, files: Optional[List[str]], require_commit: bool) -> Optional[Dict[str, Any]]:
    if not files and not require_commit:
        return None
    base = Path(target).resolve()
    paths = []
    for name in files or []:
        if (
            not isinstance(name, str) or not name or "\x00" in name or "\\" in name
            or Path(name).is_absolute() or ".." in Path(name).parts
        ):
            raise AgentLordError("CONFIG_INVALID", "required files must be relative workspace paths", exit_code=2)
        try:
            (base / name).resolve().relative_to(base)
        except (ValueError, OSError, RuntimeError) as exc:
            raise AgentLordError("CONFIG_INVALID", "required file escapes the workspace", exit_code=2) from exc
        paths.append(Path(name).as_posix())
    head = _git(target, "rev-parse", "--verify", "HEAD") if require_commit else None
    if require_commit and head is None:
        raise AgentLordError("CONFIG_INVALID", "--require-commit needs an existing Git HEAD", exit_code=2)
    return {"files": sorted(set(paths)), "require_commit": require_commit, "base_head": head}


def verify(operation: Dict[str, Any]) -> Dict[str, Any]:
    spec = operation.get("delivery_requirements")
    result: Dict[str, Any] = {
        "status": "unverified", "scope": "declared-files-and-commit", "checks": [],
    }
    if not spec:
        return result
    base = Path(operation["target"]).resolve()
    for name in spec["files"]:
        candidate = base / name
        try:
            resolved = candidate.resolve()
            resolved.relative_to(base)
            ok = resolved.is_file() and resolved.stat().st_size > 0
        except (ValueError, OSError, RuntimeError):
            ok = False
        result["checks"].append({"kind": "file", "path": name, "ok": ok})
    if spec["require_commit"]:
        target = str(base)
        head = _git(target, "rev-parse", "--verify", "HEAD")
        clean = _git(target, "status", "--porcelain") == ""
        descendant = _git(target, "merge-base", "--is-ancestor", spec["base_head"], head or "HEAD") is not None
        ok = bool(head and head != spec["base_head"] and clean and descendant)
        result["commit_sha"] = head
        result["checks"].append({"kind": "commit", "ok": ok, "clean": clean})
    result["status"] = "verified" if all(item["ok"] for item in result["checks"]) else "incomplete"
    return result
