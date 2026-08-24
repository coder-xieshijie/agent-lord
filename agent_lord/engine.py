"""Deep Agent Lord module: one interface over durable provider endpoints."""

from __future__ import annotations

from contextlib import ExitStack, contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from threading import Thread
import time
from typing import Any, Dict, Iterator, List, Optional, Tuple
from uuid import uuid4

from . import codex_adapter
from .artifacts import extract_codex_result, extract_jsonl_with_metadata, write_artifact
from .claude_adapter import (
    claude_output_activity_ms,
    claude_session_observed,
    recover_claude,
    run_claude,
    terminate_claude_process,
)
from .codex_cli_adapter import recover_codex_cli, run_codex_cli
from .config import (
    control_config,
    expected_model_matches,
    normalize_provider,
    permission_mode_policy,
    permission_policy,
    provider_config,
    resolve_execution_defaults,
    resolve_retry_plan,
)
from .errors import AgentLordError
from .state import (
    TERMINAL_OPERATION_STATES,
    all_operations,
    append_event,
    create_operation,
    create_task,
    ensure_layout,
    list_operations,
    list_tasks,
    load_action,
    load_operation,
    load_task,
    pending_action,
    record_lock,
    state_dir,
    task_path,
    update_action,
    update_operation,
    update_task,
    utc_now,
    validate_identifier,
)


SHA_PATTERN = re.compile(r"[0-9a-fA-F]{40}\Z")
WORKSPACE_POLICIES = {"reuse-or-create", "shared-readonly", "isolated"}


class AgentLord:
    def __init__(self, root: Optional[Path] = None) -> None:
        self.root = ensure_layout(root or state_dir())
        self.control = control_config()

    @staticmethod
    def _message_hash(message: str) -> str:
        return hashlib.sha256(message.encode("utf-8")).hexdigest()

    @staticmethod
    def _operation_id(task_id: str, kind: str) -> str:
        prefix = task_id[:105]
        return "%s-%s-%s" % (prefix, kind, uuid4().hex[:12])

    @staticmethod
    def _validate_source(head_sha: Optional[str], base_sha: Optional[str]) -> Dict[str, str]:
        source: Dict[str, str] = {}
        for name, value in (("head_sha", head_sha), ("base_sha", base_sha)):
            if value:
                if not SHA_PATTERN.fullmatch(value):
                    raise AgentLordError(
                        "CONFIG_INVALID",
                        "%s must be a full 40-character git SHA" % name,
                        details={name: value},
                        exit_code=2,
                    )
                source[name] = value.lower()
        return source

    @staticmethod
    def _verify_checkout(target: str, source: Dict[str, str]) -> None:
        expected = source.get("head_sha")
        if expected:
            try:
                result = subprocess.run(
                    ["git", "-C", target, "rev-parse", "HEAD"],
                    check=True,
                    capture_output=True,
                    text=True,
                )
            except (OSError, subprocess.CalledProcessError) as exc:
                raise AgentLordError(
                    "SOURCE_UNVERIFIED",
                    "cannot verify the requested source checkout",
                    details={"target": target, "expected_head": expected, "error": str(exc)},
                ) from exc
            observed = result.stdout.strip().lower()
            if observed != expected:
                raise AgentLordError(
                    "SOURCE_MISMATCH",
                    "working directory is not at the requested fixed head",
                    details={"target": target, "expected_head": expected, "observed_head": observed},
                )
        expected_base = source.get("base_sha")
        if expected_base:
            try:
                subprocess.run(
                    ["git", "-C", target, "cat-file", "-e", expected_base + "^{commit}"],
                    check=True,
                    capture_output=True,
                    text=True,
                )
            except (OSError, subprocess.CalledProcessError) as exc:
                raise AgentLordError(
                    "SOURCE_UNVERIFIED",
                    "fixed base commit is not available in the requested checkout",
                    details={"target": target, "expected_base": expected_base, "error": str(exc)},
                ) from exc

    @staticmethod
    def _git(repository: str, arguments: List[str], *, check: bool = True) -> subprocess.CompletedProcess:
        try:
            return subprocess.run(
                ["git", "-C", repository] + arguments,
                check=check,
                capture_output=True,
                text=True,
            )
        except (OSError, subprocess.CalledProcessError) as exc:
            stderr = exc.stderr.strip() if isinstance(exc, subprocess.CalledProcessError) and exc.stderr else str(exc)
            raise AgentLordError(
                "SOURCE_UNVERIFIED",
                "git could not prepare the requested source worktree",
                details={"repository": repository, "arguments": arguments, "error": stderr},
            ) from exc

    @classmethod
    def _worktrees(cls, repository: str) -> List[Dict[str, str]]:
        result = cls._git(repository, ["worktree", "list", "--porcelain"])
        worktrees: List[Dict[str, str]] = []
        for record in result.stdout.strip().split("\n\n"):
            if not record:
                continue
            item: Dict[str, str] = {}
            for line in record.splitlines():
                if " " in line:
                    key, value = line.split(" ", 1)
                    item[key] = value
            if item.get("worktree"):
                worktrees.append(item)
        return worktrees

    @classmethod
    def _ref_head(cls, repository: str, ref: str) -> Optional[str]:
        result = cls._git(repository, ["rev-parse", "--verify", ref + "^{commit}"], check=False)
        if result.returncode != 0:
            return None
        return result.stdout.strip().lower()

    def _resolve_workspace_target(
        self,
        task_id: str,
        repository: str,
        checkout_branch: str,
        worktree_root: Optional[str],
    ) -> str:
        branch_ref = "refs/heads/" + checkout_branch
        matches = [item for item in self._worktrees(repository) if item.get("branch") == branch_ref]
        if len(matches) > 1:
            raise AgentLordError(
                "SOURCE_UNVERIFIED",
                "checkout branch is bound to more than one worktree",
                details={"checkout_branch": checkout_branch, "worktrees": [item["worktree"] for item in matches]},
            )
        if matches:
            return str(Path(matches[0]["worktree"]).expanduser().resolve())
        parent = Path(worktree_root).expanduser().resolve() if worktree_root else self.root / "worktrees"
        return str((parent / task_id).resolve())

    def _prepare_workspace(
        self,
        repository: str,
        source_branch: str,
        expected_head: str,
        target: str,
        workspace_policy: str,
        workspace_branch: Optional[str],
    ) -> str:
        checkout_branch = workspace_branch if workspace_policy == "isolated" else source_branch
        assert checkout_branch is not None
        branch_ref = "refs/heads/" + checkout_branch
        matches = [item for item in self._worktrees(repository) if item.get("branch") == branch_ref]
        if len(matches) > 1:
            raise AgentLordError(
                "SOURCE_UNVERIFIED",
                "checkout branch is bound to more than one worktree",
                details={"checkout_branch": checkout_branch, "worktrees": [item["worktree"] for item in matches]},
            )
        if matches:
            target = str(Path(matches[0]["worktree"]).expanduser().resolve())
        else:
            target_path = Path(target)
            if target_path.exists():
                raise AgentLordError(
                    "SOURCE_UNVERIFIED",
                    "planned worktree path already exists",
                    details={"target": target},
                )
            target_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            local_head = self._ref_head(repository, branch_ref)
            if local_head and local_head != expected_head:
                raise AgentLordError(
                    "SOURCE_MISMATCH",
                    "local checkout branch is not at the requested fixed head",
                    details={"checkout_branch": checkout_branch, "expected_head": expected_head, "observed_head": local_head},
                )
            if local_head:
                arguments = ["worktree", "add", target, checkout_branch]
            elif workspace_policy == "isolated":
                if self._ref_head(repository, expected_head) is None:
                    raise AgentLordError(
                        "SOURCE_UNVERIFIED",
                        "fixed source commit is not available in the local repository",
                        details={"repository": repository, "expected_head": expected_head},
                    )
                arguments = ["worktree", "add", "-b", checkout_branch, target, expected_head]
            else:
                remote_ref = "refs/remotes/origin/" + source_branch
                remote_head = self._ref_head(repository, remote_ref)
                if remote_head and remote_head != expected_head:
                    raise AgentLordError(
                        "SOURCE_MISMATCH",
                        "local remote-tracking source branch is not at the requested fixed head",
                        details={"source_branch": source_branch, "expected_head": expected_head, "observed_head": remote_head},
                    )
                if remote_head:
                    arguments = ["worktree", "add", "--track", "-b", source_branch, target, remote_ref]
                else:
                    if self._ref_head(repository, expected_head) is None:
                        raise AgentLordError(
                            "SOURCE_UNVERIFIED",
                            "fixed source commit is not available in the local repository",
                            details={"repository": repository, "expected_head": expected_head},
                        )
                    arguments = ["worktree", "add", "-b", source_branch, target, expected_head]
            self._git(repository, arguments)

        status = self._git(target, ["status", "--porcelain", "--untracked-files=normal"])
        if status.stdout.strip():
            raise AgentLordError(
                "SOURCE_MISMATCH",
                "source worktree has uncommitted changes",
                details={"target": target},
            )
        observed_head = self._ref_head(target, "HEAD")
        if observed_head != expected_head:
            raise AgentLordError(
                "SOURCE_MISMATCH",
                "source worktree is not at the requested fixed head",
                details={"target": target, "expected_head": expected_head, "observed_head": observed_head},
            )
        return target

    @staticmethod
    def _lease_id(prefix: str, value: str) -> str:
        return prefix + "-" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:32]

    @classmethod
    def _target_identity(cls, target: str) -> str:
        result = subprocess.run(
            ["git", "-C", target, "rev-parse", "--show-toplevel"],
            check=False,
            capture_output=True,
            text=True,
        )
        path = result.stdout.strip() if result.returncode == 0 else target
        return str(Path(path).expanduser().resolve())

    @staticmethod
    def _repository_identity(repository: str) -> str:
        result = subprocess.run(
            ["git", "-C", repository, "rev-parse", "--path-format=absolute", "--git-common-dir"],
            check=False,
            capture_output=True,
            text=True,
        )
        path = result.stdout.strip() if result.returncode == 0 else repository
        return str(Path(path).expanduser().resolve())

    @contextmanager
    def _write_leases(
        self,
        target: str,
        read_only: bool,
        workspace: Dict[str, Any],
    ) -> Iterator[None]:
        if read_only:
            yield
            return
        workspace_identity = self._target_identity(target)
        checkout_branch = workspace.get("workspace_branch") or workspace.get("source_branch")
        repository = workspace.get("repository")
        with ExitStack() as stack:
            try:
                stack.enter_context(
                    record_lock(
                        "workspace-write",
                        self._lease_id("workspace", workspace_identity),
                        self.root,
                    )
                )
            except AgentLordError as error:
                if error.code != "STATE_BUSY":
                    raise
                raise AgentLordError(
                    "WORKSPACE_WRITE_CONFLICT",
                    "another writable task owns this worktree",
                    retryable=True,
                    safe_recovery="WAIT_FOR_WRITER_OR_USE_ISOLATED_WORKTREE",
                    details={"target": workspace_identity},
                ) from error
            if isinstance(repository, str) and repository and isinstance(checkout_branch, str) and checkout_branch:
                branch_identity = self._repository_identity(repository) + "\0" + checkout_branch
                try:
                    stack.enter_context(
                        record_lock(
                            "branch-write",
                            self._lease_id("branch", branch_identity),
                            self.root,
                        )
                    )
                except AgentLordError as error:
                    if error.code != "STATE_BUSY":
                        raise
                    raise AgentLordError(
                        "BRANCH_WRITE_CONFLICT",
                        "another writable task owns this checkout branch",
                        retryable=True,
                        safe_recovery="WAIT_FOR_WRITER_OR_USE_ISOLATED_WORKTREE",
                        details={"repository": repository, "branch": checkout_branch},
                    ) from error
            yield

    def _parallel_plan(
        self,
        task_id: str,
        read_only: bool,
        workspace: Dict[str, Any],
        parallel_group: Optional[str],
        integration_role: Optional[str],
        integration_target_branch: Optional[str],
        integrator_task_id: Optional[str],
        integration_order: Optional[int],
        integration_workers: Optional[List[str]],
    ) -> Dict[str, Any]:
        values = (
            parallel_group,
            integration_role,
            integration_target_branch,
            integrator_task_id,
            integration_order,
            integration_workers,
        )
        if not any(value is not None and value != [] for value in values):
            return {}
        if read_only:
            raise AgentLordError(
                "CONFIG_INVALID",
                "parallel integration metadata is only valid for writable tasks",
                exit_code=2,
            )
        if not parallel_group or integration_role not in ("worker", "integrator") or not integration_target_branch:
            raise AgentLordError(
                "PARALLEL_WRITE_PLAN_INCOMPLETE",
                "parallel writes require a group, role, and MR source integration target",
                requires_authorization=True,
                details={"task_id": task_id},
                exit_code=2,
            )
        validate_identifier("parallel_group", parallel_group)
        source_branch = workspace.get("source_branch")
        if integration_target_branch != source_branch:
            raise AgentLordError(
                "PARALLEL_WRITE_PLAN_INCOMPLETE",
                "integration target must equal the declared MR source branch",
                requires_authorization=True,
                details={"source_branch": source_branch, "integration_target_branch": integration_target_branch},
                exit_code=2,
            )
        if integration_role == "worker":
            if (
                workspace.get("policy") != "isolated"
                or not workspace.get("workspace_branch")
                or not integrator_task_id
                or not isinstance(integration_order, int)
                or isinstance(integration_order, bool)
                or integration_order < 1
                or integration_workers
            ):
                raise AgentLordError(
                    "PARALLEL_WRITE_PLAN_INCOMPLETE",
                    "parallel workers require isolated workspace, integrator task id, and positive integration order",
                    requires_authorization=True,
                    details={"task_id": task_id},
                    exit_code=2,
                )
            validate_identifier("integrator_task_id", integrator_task_id)
            existing_specs = [
                (
                    existing.get("task_id"),
                    existing.get("contract", {}).get("parallel_plan") or {},
                    existing.get("contract", {}).get("workspace") or {},
                )
                for existing in list_tasks(self.root)
            ]
            existing_specs.extend(
                (
                    existing.get("task_id"),
                    existing.get("parallel_plan") or {},
                    existing.get("workspace") or {},
                )
                for existing in all_operations(self.root)
            )
            for existing_task_id, plan, existing_workspace in existing_specs:
                if (
                    existing_task_id != task_id
                    and plan.get("group") == parallel_group
                    and plan.get("role") == "worker"
                    and (
                        plan.get("integration_order") == integration_order
                        or existing_workspace.get("workspace_branch") == workspace.get("workspace_branch")
                    )
                ):
                    raise AgentLordError(
                        "PARALLEL_WRITE_PLAN_INCOMPLETE",
                        "parallel workers must have unique integration order and workspace branch",
                        requires_authorization=True,
                        details={"task_id": task_id, "conflicting_task_id": existing_task_id},
                        exit_code=2,
                    )
            return {
                "group": parallel_group,
                "role": "worker",
                "integration_target_branch": integration_target_branch,
                "integrator_task_id": integrator_task_id,
                "integration_order": integration_order,
            }
        if (
            workspace.get("policy") != "reuse-or-create"
            or integrator_task_id is not None
            or integration_order is not None
            or not isinstance(integration_workers, list)
            or not integration_workers
            or len(set(integration_workers)) != len(integration_workers)
        ):
            raise AgentLordError(
                "PARALLEL_WRITE_PLAN_INCOMPLETE",
                "integrator requires ordered unique worker task ids on the MR source worktree",
                requires_authorization=True,
                details={"task_id": task_id},
                exit_code=2,
            )
        worker_heads = set()
        for worker_id in integration_workers:
            validate_identifier("integration_worker", worker_id)
            try:
                worker = load_task(worker_id, self.root)
            except AgentLordError as error:
                if error.code != "TASK_UNKNOWN":
                    raise
                raise AgentLordError(
                    "PARALLEL_WRITE_PLAN_INCOMPLETE",
                    "integrator references a worker without a completed task handle",
                    requires_authorization=True,
                    details={"task_id": task_id, "worker_task_id": worker_id},
                    exit_code=2,
                ) from error
            worker_plan = worker.get("contract", {}).get("parallel_plan") or {}
            worker_workspace = worker.get("contract", {}).get("workspace") or {}
            worker_repository = worker_workspace.get("repository")
            integrator_repository = workspace.get("repository")
            worker_head = worker.get("contract", {}).get("source", {}).get("head_sha")
            worker_heads.add(worker_head)
            worker_operation_id = worker.get("last_operation_id")
            worker_operation = load_operation(worker_operation_id, self.root) if worker_operation_id else None
            if (
                worker_plan.get("group") != parallel_group
                or worker_plan.get("role") != "worker"
                or worker_plan.get("integrator_task_id") != task_id
                or worker_plan.get("integration_target_branch") != integration_target_branch
                or not isinstance(worker_repository, str)
                or not isinstance(integrator_repository, str)
                or self._repository_identity(worker_repository) != self._repository_identity(integrator_repository)
                or worker_operation is None
                or worker_operation.get("status") != "succeeded"
            ):
                raise AgentLordError(
                    "PARALLEL_WRITE_PLAN_INCOMPLETE",
                    "integrator worker set is incomplete or inconsistent",
                    requires_authorization=True,
                    details={"task_id": task_id, "worker_task_id": worker_id},
                    exit_code=2,
                )
        if None in worker_heads or len(worker_heads) != 1:
            raise AgentLordError(
                "PARALLEL_WRITE_PLAN_INCOMPLETE",
                "parallel workers must share one fixed source head",
                requires_authorization=True,
                details={"worker_heads": sorted(str(head) for head in worker_heads)},
                exit_code=2,
            )
        ordered_workers = sorted(
            integration_workers,
            key=lambda worker_id: load_task(worker_id, self.root)["contract"]["parallel_plan"]["integration_order"],
        )
        if ordered_workers != integration_workers:
            raise AgentLordError(
                "PARALLEL_WRITE_PLAN_INCOMPLETE",
                "integration workers must be listed in declared integration order",
                requires_authorization=True,
                details={"expected_order": ordered_workers, "observed_order": integration_workers},
                exit_code=2,
            )
        return {
            "group": parallel_group,
            "role": "integrator",
            "integration_target_branch": integration_target_branch,
            "integration_workers": integration_workers,
        }

    def _task_exists(self, task_id: str) -> bool:
        return task_path(task_id, self.root).exists()

    @staticmethod
    def _dispatch_lock_id(task_id: str) -> str:
        return "dispatch-" + hashlib.sha256(task_id.encode("utf-8")).hexdigest()[:32]

    @staticmethod
    def _operation_control_lock_id(operation_id: str) -> str:
        return "control-" + hashlib.sha256(operation_id.encode("utf-8")).hexdigest()[:32]

    @staticmethod
    def _controller_lease_lock_id(operation_id: str) -> str:
        return "controller-" + hashlib.sha256(operation_id.encode("utf-8")).hexdigest()[:32]

    def _active_operation(self, task_id: str) -> Optional[Dict[str, Any]]:
        active = [
            operation
            for operation in list_operations(task_id, self.root)
            if operation.get("status") not in TERMINAL_OPERATION_STATES
        ]
        if len(active) > 1:
            raise AgentLordError(
                "STATE_CORRUPT",
                "task has more than one in-flight operation",
                details={"task_id": task_id, "operation_ids": [item.get("operation_id") for item in active]},
            )
        return active[0] if active else None

    @staticmethod
    def _same_start_spec(
        operation: Dict[str, Any],
        provider: str,
        target: str,
        message_hash: str,
        expected: Dict[str, Any],
        source: Dict[str, str],
        read_only: bool,
        workspace: Dict[str, Any],
        parallel_plan: Dict[str, Any],
    ) -> bool:
        return all(
            (
                operation.get("kind") == "start",
                operation.get("provider") == provider,
                operation.get("target") == target,
                operation.get("message_sha256") == message_hash,
                operation.get("expected") == expected,
                operation.get("source") == source,
                bool(operation.get("read_only")) == bool(read_only),
                operation.get("workspace", {}) == workspace,
                operation.get("parallel_plan", {}) == parallel_plan,
            )
        )

    def _new_operation(
        self,
        task_id: str,
        provider: str,
        kind: str,
        target: str,
        message: str,
        expected: Dict[str, Any],
        source: Dict[str, str],
        read_only: bool,
        workspace: Optional[Dict[str, Any]] = None,
        parallel_plan: Optional[Dict[str, Any]] = None,
        operation_id: Optional[str] = None,
        controller_pid: Optional[int] = None,
        endpoint_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        operation_id = operation_id or self._operation_id(task_id, kind)
        now = utc_now()
        value: Dict[str, Any] = {
            "version": 1,
            "operation_id": operation_id,
            "task_id": task_id,
            "provider": provider,
            "kind": kind,
            "target": target,
            "status": "preparing",
            "message": message,
            "message_sha256": self._message_hash(message),
            "expected": expected,
            "observed": {},
            "source": source,
            "read_only": bool(read_only),
            "workspace": workspace or {},
            "parallel_plan": parallel_plan or {},
            "artifact": None,
            "error": None,
            "created_at": now,
            "updated_at": now,
        }
        if controller_pid is not None:
            value["controller_pid"] = controller_pid
        if endpoint_id is not None:
            value["endpoint_id"] = endpoint_id
        create_operation(value, self.root)
        append_event(task_id, "operation-created", {"kind": kind, "provider": provider}, operation_id, self.root)
        return value

    def _fail_operation(self, operation: Dict[str, Any], error: AgentLordError) -> Dict[str, Any]:
        def mutate(value: Dict[str, Any]) -> Dict[str, Any]:
            value["status"] = "needs_decision" if error.requires_authorization else "failed"
            value["error"] = error.as_dict()
            if value.get("artifact"):
                value["invalidated_artifact"] = value["artifact"]
                value["artifact"] = None
            value["completed_at"] = utc_now()
            return value

        updated = update_operation(operation["operation_id"], mutate, self.root)
        append_event(operation["task_id"], "operation-failed", error.as_dict(), operation["operation_id"], self.root)
        return updated

    def _set_operation_status(self, operation_id: str, status: str, **fields: Any) -> Dict[str, Any]:
        def mutate(value: Dict[str, Any]) -> Dict[str, Any]:
            value["status"] = status
            for key, item in fields.items():
                value[key] = item
            if status in TERMINAL_OPERATION_STATES:
                value["completed_at"] = utc_now()
            return value

        return update_operation(operation_id, mutate, self.root)

    def _set_task_last_operation(self, task_id: str, operation_id: str) -> Dict[str, Any]:
        return update_task(task_id, lambda value: dict(value, last_operation_id=operation_id), self.root)

    @staticmethod
    def _expected_contract(
        provider: str,
        model: Optional[str],
        effort: Optional[str],
        read_only: bool,
        permission_mode: Optional[str] = None,
        retry_plan: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        permission = (
            permission_mode_policy(provider, permission_mode)
            if permission_mode is not None
            else permission_policy(provider, read_only)
        )
        if read_only != (permission["mode"] == "read_only"):
            raise AgentLordError(
                "STATE_CORRUPT",
                "saved permission mode contradicts the read-only contract",
                details={"provider": provider, "permission_mode": permission["mode"], "read_only": read_only},
            )
        return {
            "model": model,
            "effort": effort,
            "permission_mode": permission["mode"],
            "permission_enforcement": permission["enforcement"],
            "retry_plan": retry_plan if retry_plan is not None else resolve_retry_plan(provider, model),
        }

    @staticmethod
    def _codex_observation(operation: Dict[str, Any], **values: Any) -> Dict[str, Any]:
        expected = operation.get("expected", {})
        permission = permission_policy("codex-app", bool(operation.get("read_only")))
        result = {
            "execution_contract": "model-effort-tool-arguments",
            "permission_mode": expected.get("permission_mode", permission["mode"]),
            "permission_enforcement": expected.get("permission_enforcement", permission["enforcement"]),
        }
        result.update(values)
        return result

    def _task_record(
        self,
        operation: Dict[str, Any],
        endpoint_id: str,
        host_id: Optional[str],
    ) -> Dict[str, Any]:
        now = utc_now()
        expected = operation.get("expected", {})
        permission_mode = expected.get("permission_mode")
        if not isinstance(permission_mode, str) or not permission_mode:
            permission_mode = permission_policy(
                operation["provider"],
                bool(operation.get("read_only")),
            )["mode"]
        history: List[Dict[str, Any]] = []
        if host_id:
            history.append({"host_id": host_id, "observed_at": now, "reason": "endpoint-created"})
        return {
            "version": 2,
            "task_id": operation["task_id"],
            "provider": operation["provider"],
            "endpoint_id": endpoint_id,
            "target": operation["target"],
            "route": {"host_id": host_id, "resolved_at": now, "history": history},
            "contract": {
                "model": expected.get("model"),
                "effort": expected.get("effort"),
                "read_only": operation.get("read_only", False),
                "permission_mode": permission_mode,
                "source": operation.get("source", {}),
                "retry_plan": expected.get("retry_plan") or resolve_retry_plan(operation["provider"], expected.get("model")),
                "workspace": operation.get("workspace", {}),
                "parallel_plan": operation.get("parallel_plan", {}),
            },
            "created_at": now,
            "updated_at": now,
            "last_operation_id": operation["operation_id"],
        }

    def _publish_cli_result(
        self,
        operation: Dict[str, Any],
        endpoint_id: str,
        resume: bool,
        result: Dict[str, Any],
    ) -> Dict[str, Any]:
        finalize_lock_id = "finalize-" + hashlib.sha256(operation["operation_id"].encode("utf-8")).hexdigest()[:32]
        busy_error: Optional[AgentLordError] = None
        for _ in range(self.control["finalize_lock_attempts"]):
            try:
                with record_lock("finalize", finalize_lock_id, self.root):
                    current = load_operation(operation["operation_id"], self.root)
                    if current.get("status") == "succeeded":
                        return self.envelope(current)
                    if current.get("status") in TERMINAL_OPERATION_STATES:
                        raise AgentLordError(
                            "STATE_CONFLICT",
                            "CLI operation was finalized with a different terminal result",
                            details={"operation_id": operation["operation_id"], "status": current.get("status")},
                        )
                    artifact = write_artifact(
                        operation["task_id"],
                        operation["operation_id"],
                        result["assistant_text"],
                        self.root,
                    )
                    if not resume:
                        if self._task_exists(operation["task_id"]):
                            task = load_task(operation["task_id"], self.root)
                            if task.get("endpoint_id") != endpoint_id or task.get("last_operation_id") != operation["operation_id"]:
                                raise AgentLordError(
                                    "IDENTITY_CONFLICT",
                                    "existing task handle does not match the recovered CLI start",
                                    details={"task_id": operation["task_id"], "endpoint_id": task.get("endpoint_id")},
                                )
                        else:
                            create_task(self._task_record(current, endpoint_id, None), self.root)
                    else:
                        self._set_task_last_operation(operation["task_id"], operation["operation_id"])
                    result_fields: Dict[str, Any] = {
                        "observed": result["observed"],
                        "artifact": artifact,
                        "error": None,
                        "provider_command": result["command"],
                        "stdout_path": result["stdout_path"],
                        "stderr_path": result["stderr_path"],
                        "endpoint_id": endpoint_id,
                        "active_attempt": None,
                    }
                    if result.get("result_path"):
                        result_fields["result_path"] = result["result_path"]
                    updated = self._set_operation_status(
                        operation["operation_id"],
                        "succeeded",
                        **result_fields,
                    )
                    append_event(
                        operation["task_id"],
                        "operation-succeeded",
                        {"artifact": artifact},
                        operation["operation_id"],
                        self.root,
                    )
                    return self.envelope(updated)
            except AgentLordError as error:
                if error.code != "STATE_BUSY":
                    raise
                busy_error = error
                current = load_operation(operation["operation_id"], self.root)
                if current.get("status") == "succeeded":
                    return self.envelope(current)
                time.sleep(self.control["finalize_lock_retry_interval_ms"] / 1000)
        assert busy_error is not None
        raise busy_error

    @staticmethod
    def _expanded_retry_models(operation: Dict[str, Any]) -> List[str]:
        result: List[str] = []
        for stage in operation.get("expected", {}).get("retry_plan", []):
            model = stage.get("model")
            attempts = stage.get("attempts")
            if isinstance(model, str) and isinstance(attempts, int):
                result.extend([model] * attempts)
        return result

    def _record_claude_attempt(
        self,
        operation: Dict[str, Any],
        attempt_number: int,
        model: str,
        status: str,
        error: Optional[AgentLordError] = None,
        session_observed: Optional[bool] = None,
        retrying: bool = False,
        claim_controller: bool = True,
        warnings: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        def mutate(value: Dict[str, Any]) -> Dict[str, Any]:
            history = list(value.get("attempt_history") or [])
            entry: Dict[str, Any] = {"number": attempt_number, "model": model, "status": status}
            active = value.get("active_attempt") or {}
            for name in (
                "attempt_id",
                "prompt_kind",
                "recovery_marker",
                "prompt_delivery",
                "prompt_delivered_at_ms",
                "progress_seq",
            ):
                if active.get(name) is not None:
                    entry[name] = active[name]
            if error is not None:
                entry["error"] = error.as_dict()
            if session_observed is not None:
                entry["session_observed"] = session_observed
            if warnings:
                entry["warnings"] = [
                    {key: warning[key] for key in ("code", "source", "model") if key in warning}
                    for warning in warnings
                ]
            history.append(entry)
            value["attempt_history"] = history
            if status == "failed":
                value["active_attempt"] = None
                if retrying:
                    value["status"] = "recovering"
                    controller_pid = os.getpid() if claim_controller else None
                    value["controller_pid"] = controller_pid
                    value["recovery_controller_pid"] = controller_pid
                value["observed"] = dict(value.get("observed") or {}, supervision={
                    "state": "recovering" if retrying else (
                        "provider_failed" if error and error.code != "PROVIDER_STALLED" else "suspected_stall"
                    ),
                    "attempt": attempt_number,
                    "error_code": error.code if error else None,
                })
            return value

        updated = update_operation(operation["operation_id"], mutate, self.root)
        append_event(
            operation["task_id"],
            "provider-attempt-%s" % status,
            {"attempt": attempt_number, "model": model, "error": error.as_dict() if error else None},
            operation["operation_id"],
            self.root,
        )
        for warning in warnings or []:
            append_event(
                operation["task_id"],
                "provider-attempt-warning",
                {
                    "attempt": attempt_number,
                    **{key: warning[key] for key in ("code", "source", "model") if key in warning},
                },
                operation["operation_id"],
                self.root,
            )
        return updated

    @staticmethod
    def _claude_recovery_message(operation_id: str, attempt_number: int, reason: str) -> Tuple[str, str]:
        marker = "agent-lord-recovery:%s:%d" % (operation_id, attempt_number)
        return (
            "[%s]\n"
            "Continue the same task in this existing Claude session after the previous provider attempt ended "
            "with %s. Inspect the conversation and current worktree first, do not repeat work that is already "
            "complete, then finish the original request and return its final answer.\n" % (marker, reason),
            marker,
        )

    def _raise_cli_failure(self, operation: Dict[str, Any], error: AgentLordError, exhausted: bool = False) -> Dict[str, Any]:
        failed, terminal_error = self._terminalize_cli_failure(operation, error, exhausted)
        raise AgentLordError(
            terminal_error.code,
            terminal_error.message,
            retryable=terminal_error.retryable,
            safe_recovery=terminal_error.safe_recovery,
            requires_authorization=terminal_error.requires_authorization,
            details=dict(terminal_error.details, operation_id=failed["operation_id"], task_id=failed["task_id"]),
            exit_code=terminal_error.exit_code,
        ) from error

    def _terminalize_cli_failure(
        self,
        operation: Dict[str, Any],
        error: AgentLordError,
        exhausted: bool,
    ) -> Tuple[Dict[str, Any], AgentLordError]:
        terminal_error = AgentLordError(
            error.code,
            error.message,
            retryable=False if exhausted else error.retryable,
            safe_recovery=None if exhausted else error.safe_recovery,
            requires_authorization=error.requires_authorization,
            details=dict(
                error.details,
                attempts=operation.get("attempt_history") or [],
                retry_exhausted=exhausted,
            ),
            exit_code=error.exit_code,
        )
        return self._fail_operation(operation, terminal_error), terminal_error

    @staticmethod
    def _claude_delivery_requires_continuation(operation: Dict[str, Any]) -> bool:
        attempts = list(operation.get("attempt_history") or [])
        active = operation.get("active_attempt")
        if isinstance(active, dict):
            attempts.append(active)
        return any(
            attempt.get("prompt_delivery") in ("delivery-unknown", "stdin-attached")
            for attempt in attempts
            if isinstance(attempt, dict)
        )

    def _finish_claude(self, operation: Dict[str, Any], session_id: str, resume: bool) -> Dict[str, Any]:
        models = self._expanded_retry_models(operation)
        if not models:
            raise AgentLordError("STATE_CORRUPT", "Claude operation has no retry plan")
        current = load_operation(operation["operation_id"], self.root)
        start_index = len(current.get("attempt_history") or [])
        attempt_resume = (
            resume
            or (start_index > 0 and claude_session_observed(current))
            or self._claude_delivery_requires_continuation(current)
        )
        prior_history = current.get("attempt_history") or []
        previous_reason = (
            prior_history[-1].get("error", {}).get("code", "PROVIDER_FAILED")
            if prior_history
            else "PROVIDER_FAILED"
        )
        for index in range(start_index, len(models)):
            model = models[index]
            prompt = operation["message"]
            prompt_kind = "original"
            recovery_marker: Optional[str] = None
            if index > 0 and attempt_resume:
                prompt, recovery_marker = self._claude_recovery_message(
                    operation["operation_id"],
                    index + 1,
                    previous_reason,
                )
                prompt_kind = "continuation"
                current = self._set_operation_status(
                    operation["operation_id"],
                    "recovering",
                    recovery_controller_pid=os.getpid(),
                    observed=dict(current.get("observed") or {}, supervision={
                        "state": "recovering",
                        "attempt": index + 1,
                        "reason": previous_reason,
                        "recovery_marker": recovery_marker,
                    }),
                )
                append_event(
                    operation["task_id"],
                    "provider-recovery-query-prepared",
                    {"attempt": index + 1, "reason": previous_reason, "recovery_marker": recovery_marker},
                    operation["operation_id"],
                    self.root,
                )
            try:
                result = run_claude(
                    operation["operation_id"],
                    operation["target"],
                    prompt,
                    session_id,
                    attempt_resume,
                    model,
                    operation.get("expected", {}).get("effort"),
                    bool(operation.get("read_only")),
                    operation.get("expected", {}).get("permission_mode"),
                    index + 1,
                    self.root,
                    self.control["claude_stall_seconds"],
                    self.control["claude_tool_stall_seconds"],
                    self.control["claude_terminate_grace_seconds"],
                    self.control["claude_progress_poll_interval_ms"],
                    prompt_kind,
                    recovery_marker,
                )
            except AgentLordError as error:
                if error.code == "STATE_BUSY":
                    raise
                current = load_operation(operation["operation_id"], self.root)
                session_observed = claude_session_observed(current)
                attempt_resume = (
                    attempt_resume
                    or session_observed
                    or self._claude_delivery_requires_continuation(current)
                )
                retrying = error.retryable and index + 1 < len(models)
                current = self._record_claude_attempt(
                    current,
                    index + 1,
                    model,
                    "failed",
                    error,
                    session_observed=session_observed,
                    retrying=retrying,
                )
                previous_reason = error.code
                if not retrying:
                    return self._raise_cli_failure(current, error, exhausted=error.retryable)
                continue
            current = self._record_claude_attempt(
                operation,
                index + 1,
                model,
                "succeeded",
                warnings=result.get("observed", {}).get("warnings"),
            )
            history = current.get("attempt_history") or []
            result["observed"].update(
                {
                    "attempts": len(history),
                    "attempt_history": history,
                    "requested_model": operation.get("expected", {}).get("model"),
                    "fallback_used": model != operation.get("expected", {}).get("model"),
                }
            )
            return self._publish_cli_result(current, session_id, resume, result)
        raise AgentLordError("STATE_CORRUPT", "Claude retry plan was exhausted without a terminal result")

    def _finish_codex_cli(
        self,
        operation: Dict[str, Any],
        endpoint_id: Optional[str],
        resume: bool,
    ) -> Dict[str, Any]:
        try:
            result = run_codex_cli(
                operation["operation_id"],
                operation["target"],
                operation["message"],
                endpoint_id,
                resume,
                operation.get("expected", {}).get("model"),
                operation.get("expected", {}).get("effort"),
                bool(operation.get("read_only")),
                operation.get("expected", {}).get("permission_mode"),
                self.root,
            )
            return self._publish_cli_result(operation, result["endpoint_id"], resume, result)
        except AgentLordError as error:
            if error.code == "STATE_BUSY":
                raise
            return self._raise_cli_failure(load_operation(operation["operation_id"], self.root), error)

    def start(
        self,
        task_id: str,
        provider: str,
        target: Optional[str],
        message: str,
        model: Optional[str] = None,
        effort: Optional[str] = None,
        read_only: bool = False,
        head_sha: Optional[str] = None,
        base_sha: Optional[str] = None,
        repository: Optional[str] = None,
        source_branch: Optional[str] = None,
        workspace_policy: Optional[str] = None,
        workspace_branch: Optional[str] = None,
        worktree_root: Optional[str] = None,
        parallel_group: Optional[str] = None,
        integration_role: Optional[str] = None,
        integration_target_branch: Optional[str] = None,
        integrator_task_id: Optional[str] = None,
        integration_order: Optional[int] = None,
        integration_workers: Optional[List[str]] = None,
        codex_environment: str = "worktree",
        starting_branch: Optional[str] = None,
        retry_attempts: Optional[int] = None,
    ) -> Dict[str, Any]:
        validate_identifier("task_id", task_id)
        provider = normalize_provider(provider)
        provider_config(provider)
        model, effort = resolve_execution_defaults(provider, model, effort)
        retry_plan = resolve_retry_plan(provider, model, retry_attempts)
        if not isinstance(message, str) or not message:
            raise AgentLordError("CONFIG_INVALID", "message must be non-empty", exit_code=2)
        message_hash = self._message_hash(message)
        source = self._validate_source(head_sha, base_sha)
        workspace_requested = repository is not None
        workspace: Dict[str, Any] = {}
        if workspace_requested:
            if target is not None or provider not in ("claude-cli", "codex-cli"):
                raise AgentLordError(
                    "CONFIG_INVALID",
                    "repository workspace preparation requires a local CLI provider and no target",
                    exit_code=2,
                )
            if (
                not isinstance(repository, str)
                or not repository
                or not isinstance(source_branch, str)
                or not source_branch
                or source_branch.startswith("-")
                or workspace_policy not in WORKSPACE_POLICIES
                or not source.get("head_sha")
            ):
                raise AgentLordError(
                    "CONFIG_INVALID",
                    "repo workspace preparation requires source-branch, a supported workspace policy, and a full head-sha",
                    exit_code=2,
                )
            if workspace_policy == "shared-readonly" and not read_only:
                raise AgentLordError(
                    "CONFIG_INVALID",
                    "shared-readonly workspace policy requires --read-only",
                    exit_code=2,
                )
            if workspace_policy == "isolated":
                if read_only or not isinstance(workspace_branch, str) or not workspace_branch or workspace_branch == source_branch:
                    raise AgentLordError(
                        "CONFIG_INVALID",
                        "isolated workspace policy requires a writable task and a distinct workspace-branch",
                        exit_code=2,
                    )
            elif workspace_branch is not None:
                raise AgentLordError(
                    "CONFIG_INVALID",
                    "workspace-branch is accepted only with isolated workspace policy",
                    exit_code=2,
                )
            repository = str(Path(repository).expanduser().resolve())
            self._git(repository, ["check-ref-format", "--branch", source_branch])
            if workspace_branch:
                self._git(repository, ["check-ref-format", "--branch", workspace_branch])
            checkout_branch = workspace_branch or source_branch
            target = self._resolve_workspace_target(task_id, repository, checkout_branch, worktree_root)
            workspace = {
                "policy": workspace_policy,
                "repository": repository,
                "source_branch": source_branch,
            }
            if workspace_branch:
                workspace["workspace_branch"] = workspace_branch
        elif source_branch is not None or workspace_policy is not None or workspace_branch is not None or worktree_root is not None:
            raise AgentLordError(
                "CONFIG_INVALID",
                "source-branch, workspace-policy, workspace-branch, and worktree-root require repo workspace preparation",
                exit_code=2,
            )
        if not isinstance(target, str) or not target:
            raise AgentLordError("CONFIG_INVALID", "target must be non-empty", exit_code=2)
        if provider in ("claude-cli", "codex-cli"):
            target = str(Path(target).expanduser().resolve())
            if not workspace:
                workspace = {"policy": "exact-target"}
            if not workspace_requested:
                self._verify_checkout(target, source)
        elif codex_environment not in ("worktree", "local"):
            raise AgentLordError("CONFIG_INVALID", "Codex environment must be worktree or local", exit_code=2)

        parallel_plan = self._parallel_plan(
            task_id,
            read_only,
            workspace,
            parallel_group,
            integration_role,
            integration_target_branch,
            integrator_task_id,
            integration_order,
            integration_workers,
        )
        expected = self._expected_contract(provider, model, effort, read_only, retry_plan=retry_plan)
        action: Optional[Dict[str, Any]] = None
        claude_lease = None
        write_leases = None
        workspace_prepare_lease = None
        session_id = str(uuid4()) if provider == "claude-cli" else None
        try:
            with record_lock("dispatch", self._dispatch_lock_id(task_id), self.root):
                if self._task_exists(task_id):
                    task = load_task(task_id, self.root)
                    last_operation_id = task.get("last_operation_id")
                    if last_operation_id:
                        last_operation = load_operation(last_operation_id, self.root)
                        if self._same_start_spec(
                            last_operation,
                            provider,
                            target,
                            message_hash,
                            expected,
                            source,
                            read_only,
                            workspace,
                            parallel_plan,
                        ):
                            return self.envelope(last_operation)
                    raise AgentLordError(
                        "TASK_EXISTS",
                        "task_id already has a durable endpoint",
                        details={"task_id": task_id},
                        exit_code=2,
                    )
                inflight = self._active_operation(task_id)
                if inflight:
                    if self._same_start_spec(
                        inflight,
                        provider,
                        target,
                        message_hash,
                        expected,
                        source,
                        read_only,
                        workspace,
                        parallel_plan,
                    ):
                        return self.envelope(inflight)
                    raise AgentLordError(
                        "OPERATION_IN_FLIGHT",
                        "task_id already has a different start in flight",
                        retryable=True,
                        safe_recovery="CHECK_SAME_OPERATION",
                        details={"operation_id": inflight["operation_id"], "status": inflight.get("status")},
                    )
                if workspace_requested:
                    assert repository is not None and source_branch is not None
                    checkout_branch = workspace_branch or source_branch
                    prepare_identity = self._repository_identity(repository) + "\0" + checkout_branch
                    candidate_prepare_lease = record_lock(
                        "workspace-prepare",
                        self._lease_id("prepare", prepare_identity),
                        self.root,
                    )
                    candidate_prepare_lease.__enter__()
                    workspace_prepare_lease = candidate_prepare_lease
                    target = self._resolve_workspace_target(task_id, repository, checkout_branch, worktree_root)
                if provider in ("claude-cli", "codex-cli"):
                    candidate_leases = self._write_leases(target, read_only, workspace)
                    candidate_leases.__enter__()
                    write_leases = candidate_leases
                if workspace_requested:
                    assert repository is not None and source_branch is not None
                    target = self._prepare_workspace(
                        repository,
                        source_branch,
                        source["head_sha"],
                        target,
                        workspace_policy,
                        workspace_branch,
                    )
                    self._verify_checkout(target, source)
                    assert workspace_prepare_lease is not None
                    workspace_prepare_lease.__exit__(None, None, None)
                    workspace_prepare_lease = None
                operation_id = self._operation_id(task_id, "start")
                if provider == "claude-cli":
                    claude_lease = record_lock(
                        "controller-lease",
                        self._controller_lease_lock_id(operation_id),
                        self.root,
                    )
                    claude_lease.__enter__()
                operation = self._new_operation(
                    task_id,
                    provider,
                    "start",
                    target,
                    message,
                    expected,
                    source,
                    read_only,
                    workspace,
                    parallel_plan,
                    operation_id=operation_id,
                    controller_pid=os.getpid() if provider == "claude-cli" else None,
                    endpoint_id=session_id,
                )
                if provider == "codex-app":
                    action = codex_adapter.create_thread_action(operation, codex_environment, starting_branch, self.root)
                    operation = self._set_operation_status(
                        operation["operation_id"],
                        "awaiting_action",
                        action_id=action["action_id"],
                    )
        except BaseException:
            if claude_lease is not None:
                claude_lease.__exit__(*sys.exc_info())
            if write_leases is not None:
                write_leases.__exit__(*sys.exc_info())
            if workspace_prepare_lease is not None:
                workspace_prepare_lease.__exit__(*sys.exc_info())
            raise
        if provider == "claude-cli":
            assert session_id is not None and claude_lease is not None
            try:
                return self._finish_claude(operation, session_id, resume=False)
            finally:
                claude_lease.__exit__(None, None, None)
                assert write_leases is not None
                write_leases.__exit__(None, None, None)
        if provider == "codex-cli":
            try:
                return self._finish_codex_cli(operation, endpoint_id=None, resume=False)
            finally:
                assert write_leases is not None
                write_leases.__exit__(None, None, None)

        assert action is not None
        append_event(task_id, "action-required", {"action_id": action["action_id"], "tool": action["tool"]}, operation["operation_id"], self.root)
        return self.envelope(operation, action)

    def turn(self, task_id: str, message: str) -> Dict[str, Any]:
        if not isinstance(message, str) or not message:
            raise AgentLordError("CONFIG_INVALID", "message must be non-empty", exit_code=2)
        message_hash = self._message_hash(message)
        action: Optional[Dict[str, Any]] = None
        claude_lease = None
        write_leases = None
        try:
            with record_lock("dispatch", self._dispatch_lock_id(task_id), self.root):
                task = load_task(task_id, self.root)
                if task.get("legacy_version") == 1:
                    raise AgentLordError(
                        "EXECUTION_CONTRACT_REQUIRED",
                        "version 1 task must be explicitly upgraded before another turn",
                        requires_authorization=True,
                        details={"task_id": task_id, "recovery": "scripts/task_store.py upgrade"},
                        exit_code=2,
                    )
                inflight = self._active_operation(task_id)
                if inflight:
                    if inflight.get("message_sha256") == message_hash:
                        return self.envelope(inflight)
                    raise AgentLordError(
                        "OPERATION_IN_FLIGHT",
                        "the previous turn has not reached a terminal state",
                        retryable=True,
                        safe_recovery="CHECK_SAME_OPERATION",
                        details={"operation_id": inflight["operation_id"], "status": inflight.get("status")},
                    )
                contract = task.get("contract") or {}
                source = contract.get("source") or {}
                workspace = contract.get("workspace") or {"policy": "exact-target"}
                parallel_plan = contract.get("parallel_plan") or {}
                if task["provider"] in ("claude-cli", "codex-cli"):
                    self._verify_checkout(task["target"], source)
                    candidate_leases = self._write_leases(
                        task["target"],
                        bool(contract.get("read_only")),
                        workspace,
                    )
                    candidate_leases.__enter__()
                    write_leases = candidate_leases
                expected = self._expected_contract(
                    task["provider"],
                    contract.get("model"),
                    contract.get("effort"),
                    bool(contract.get("read_only")),
                    contract.get("permission_mode"),
                    contract.get("retry_plan"),
                )
                operation_id = self._operation_id(task_id, "turn")
                if task["provider"] == "claude-cli":
                    claude_lease = record_lock(
                        "controller-lease",
                        self._controller_lease_lock_id(operation_id),
                        self.root,
                    )
                    claude_lease.__enter__()
                operation = self._new_operation(
                    task_id,
                    task["provider"],
                    "turn",
                    task["target"],
                    message,
                    expected,
                    source,
                    bool(contract.get("read_only")),
                    workspace,
                    parallel_plan,
                    operation_id=operation_id,
                    controller_pid=os.getpid() if task["provider"] == "claude-cli" else None,
                    endpoint_id=task.get("endpoint_id") if task["provider"] == "claude-cli" else None,
                )
                if task["provider"] == "codex-app":
                    action = codex_adapter.send_action(operation, task, self.root)
                    operation = self._set_operation_status(
                        operation["operation_id"],
                        "awaiting_action",
                        action_id=action["action_id"],
                    )
                self._set_task_last_operation(task_id, operation["operation_id"])
        except BaseException:
            if claude_lease is not None:
                claude_lease.__exit__(*sys.exc_info())
            if write_leases is not None:
                write_leases.__exit__(*sys.exc_info())
            raise
        if task["provider"] == "claude-cli":
            assert claude_lease is not None
            try:
                return self._finish_claude(operation, task["endpoint_id"], resume=True)
            finally:
                claude_lease.__exit__(None, None, None)
                assert write_leases is not None
                write_leases.__exit__(None, None, None)
        if task["provider"] == "codex-cli":
            try:
                return self._finish_codex_cli(operation, task["endpoint_id"], resume=True)
            finally:
                assert write_leases is not None
                write_leases.__exit__(None, None, None)
        assert action is not None
        return self.envelope(operation, action)

    @staticmethod
    def _result_digest(value: Any) -> str:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def _mark_action(self, action_id: str, status: str, result: Any = None, error: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        def mutate(value: Dict[str, Any]) -> Dict[str, Any]:
            value["status"] = status
            value["result_sha256"] = self._result_digest(result) if result is not None else None
            value["error"] = error
            value["completed_at"] = utc_now()
            return value

        return update_action(action_id, mutate, self.root)

    def _rebind_task(self, task_id: str, host_id: str, reason: str) -> Dict[str, Any]:
        def mutate(value: Dict[str, Any]) -> Dict[str, Any]:
            route = value.setdefault("route", {})
            old_host = route.get("host_id")
            history = route.setdefault("history", [])
            if old_host != host_id:
                history.append({"host_id": host_id, "observed_at": utc_now(), "reason": reason, "previous_host_id": old_host})
            route["host_id"] = host_id
            route["resolved_at"] = utc_now()
            return value

        return update_task(task_id, mutate, self.root)

    def _route_stale(self, operation: Dict[str, Any], action: Dict[str, Any], error_text: str) -> Dict[str, Any]:
        error = AgentLordError(
            "ENDPOINT_ROUTE_STALE",
            "Codex endpoint route is stale; resolving the same thread before retry",
            retryable=True,
            safe_recovery="RESOLVE_SAME_ENDPOINT_AND_RETRY",
            details={"provider_error": error_text},
        )
        self._mark_action(action["action_id"], "failed", error=error.as_dict())
        updated = self._set_operation_status(operation["operation_id"], "awaiting_action", error=error.as_dict())
        followup = codex_adapter.list_threads_action(
            updated,
            self.root,
            resume_action_id=action["action_id"],
            resume_kind=action["kind"],
        )
        updated = self._set_operation_status(operation["operation_id"], "awaiting_action", action_id=followup["action_id"], error=error.as_dict())
        append_event(operation["task_id"], "route-stale", error.as_dict(), operation["operation_id"], self.root)
        return self.envelope(updated, followup)

    def accept(self, action_id: str, raw_result: Any) -> Dict[str, Any]:
        action = load_action(action_id, self.root)
        with record_lock(
            "operation-control",
            self._operation_control_lock_id(action["operation_id"]),
            self.root,
        ):
            return self._accept_locked(action_id, raw_result)

    def _accept_locked(self, action_id: str, raw_result: Any) -> Dict[str, Any]:
        action = load_action(action_id, self.root)
        operation = load_operation(action["operation_id"], self.root)
        if action.get("status") != "pending":
            return self.envelope(operation)
        result = codex_adapter.unwrap_result(raw_result)
        provider_error = codex_adapter.error_text(result)
        if provider_error:
            if codex_adapter.ROUTE_STALE_FRAGMENT in provider_error and action["kind"] in ("codex.send", "codex.read"):
                return self._route_stale(operation, action, provider_error)
            if action["kind"] == "codex.send":
                error = AgentLordError(
                    "DELIVERY_UNKNOWN",
                    "Codex send failed without a trustworthy delivery receipt",
                    retryable=True,
                    safe_recovery="CHECK_SAME_ENDPOINT_BEFORE_RESEND",
                    details={"provider_error": provider_error},
                )
                self._mark_action(action_id, "uncertain", error=error.as_dict())
                task = load_task(operation["task_id"], self.root)
                followup = codex_adapter.read_action(operation, task, self.root)
                updated = self._set_operation_status(operation["operation_id"], "awaiting_action", action_id=followup["action_id"], error=error.as_dict())
                return self.envelope(updated, followup)
            error = AgentLordError(
                "PROVIDER_FAILED",
                "Codex host tool returned an error",
                retryable=action["kind"] == "codex.read",
                safe_recovery="RETRY_CHECK_SAME_ENDPOINT" if action["kind"] == "codex.read" else None,
                details={"provider_error": provider_error},
            )
            failed = self._fail_operation(operation, error)
            self._mark_action(action_id, "failed", error=error.as_dict())
            return self.envelope(failed)

        if action["kind"] == "codex.create":
            endpoint_id, host_id = codex_adapter.endpoint_identity(result)
            if not endpoint_id or not host_id:
                error = AgentLordError("RESULT_INVALID", "Codex create result lacks a real threadId and hostId")
                failed = self._fail_operation(operation, error)
                self._mark_action(action_id, "failed", error=error.as_dict())
                return self.envelope(failed)
            create_task(self._task_record(operation, endpoint_id, host_id), self.root)
            self._mark_action(action_id, "accepted", result=result)
            updated = self._set_operation_status(
                operation["operation_id"],
                "submitted",
                endpoint_id=endpoint_id,
                observed=self._codex_observation(operation, host_id=host_id),
                error=None,
            )
            append_event(operation["task_id"], "endpoint-created", {"endpoint_id": endpoint_id, "host_id": host_id}, operation["operation_id"], self.root)
            return self.envelope(updated)

        task = load_task(operation["task_id"], self.root)
        if action["kind"] == "codex.send":
            endpoint_id, host_id = codex_adapter.endpoint_identity(result)
            if endpoint_id and endpoint_id != task["endpoint_id"]:
                error = AgentLordError(
                    "ENDPOINT_MISMATCH",
                    "Codex send receipt belongs to a different thread",
                    details={"expected": task["endpoint_id"], "observed": endpoint_id},
                )
                failed = self._fail_operation(operation, error)
                self._mark_action(action_id, "failed", error=error.as_dict())
                return self.envelope(failed)
            if host_id:
                task = self._rebind_task(task["task_id"], host_id, "send-receipt")
            self._mark_action(action_id, "accepted", result=result)
            updated = self._set_operation_status(
                operation["operation_id"],
                "submitted",
                observed=self._codex_observation(operation, host_id=task.get("route", {}).get("host_id")),
                error=None,
            )
            append_event(operation["task_id"], "message-accepted", {"action_id": action_id}, operation["operation_id"], self.root)
            return self.envelope(updated)

        if action["kind"] == "codex.list":
            thread = codex_adapter.find_thread(result, task["endpoint_id"])
            host_id = thread.get("hostId") if thread else None
            if not isinstance(host_id, str) or not host_id:
                error = AgentLordError(
                    "ENDPOINT_GONE",
                    "the original Codex thread was not found on any current host",
                    requires_authorization=True,
                    details={"endpoint_id": task["endpoint_id"]},
                )
                failed = self._fail_operation(operation, error)
                self._mark_action(action_id, "accepted", result=result, error=error.as_dict())
                return self.envelope(failed)
            task = self._rebind_task(task["task_id"], host_id, "host-rediscovery")
            self._mark_action(action_id, "accepted", result=result)
            prior = load_action(action["resume_action_id"], self.root)
            if action.get("resume_kind") == "codex.send":
                followup = codex_adapter.send_action(operation, task, self.root, prepared_prompt=prior["arguments"]["prompt"])
            else:
                followup = codex_adapter.read_action(operation, task, self.root)
            updated = self._set_operation_status(operation["operation_id"], "awaiting_action", action_id=followup["action_id"], error=None)
            append_event(operation["task_id"], "route-rebound", {"host_id": host_id}, operation["operation_id"], self.root)
            return self.envelope(updated, followup)

        if action["kind"] == "codex.read":
            self._mark_action(action_id, "accepted", result=result)
            marker = codex_adapter.operation_marker(operation["operation_id"])
            serialized = json.dumps(result, ensure_ascii=False, default=str)
            try:
                text = extract_codex_result(result, marker)
            except AgentLordError:
                text = ""
            if text:
                artifact = write_artifact(operation["task_id"], operation["operation_id"], text, self.root)
                status = codex_adapter.thread_status(result, task["endpoint_id"])
                updated = self._set_operation_status(
                    operation["operation_id"],
                    "succeeded",
                    artifact=artifact,
                    observed=self._codex_observation(operation, thread_status=status),
                    error=None,
                )
                append_event(operation["task_id"], "operation-succeeded", {"artifact": artifact}, operation["operation_id"], self.root)
                return self.envelope(updated)
            if operation.get("error", {}).get("code") == "DELIVERY_UNKNOWN" and marker not in serialized:
                error = AgentLordError(
                    "DELIVERY_UNKNOWN",
                    "the operation marker is absent from the bounded transcript; resend requires an explicit decision",
                    requires_authorization=True,
                    details={"operation_id": operation["operation_id"]},
                )
                failed = self._fail_operation(operation, error)
                return self.envelope(failed)
            status = codex_adapter.thread_status(result, task["endpoint_id"])
            updated = self._set_operation_status(
                operation["operation_id"],
                "submitted",
                observed=self._codex_observation(operation, thread_status=status),
            )
            return self.envelope(updated)

        error = AgentLordError("RESULT_INVALID", "unknown Codex action kind", details={"kind": action["kind"]})
        failed = self._fail_operation(operation, error)
        return self.envelope(failed)

    def check(self, task_id: str) -> Dict[str, Any]:
        task = load_task(task_id, self.root)
        operation_id = task.get("last_operation_id")
        if not operation_id:
            return {
                "version": 1,
                "status": "IDLE",
                "task_id": task_id,
                "provider": task["provider"],
                "endpoint_id": task["endpoint_id"],
            }
        with record_lock(
            "operation-control",
            self._operation_control_lock_id(operation_id),
            self.root,
        ):
            operation = load_operation(operation_id, self.root)
            action = pending_action(operation_id, self.root)
            if action:
                return self.envelope(operation, action)
            if operation.get("status") in TERMINAL_OPERATION_STATES:
                return self.envelope(operation)
            if task["provider"] == "codex-app":
                action = codex_adapter.read_action(operation, task, self.root)
                updated = self._set_operation_status(operation_id, "awaiting_action", action_id=action["action_id"])
                return self.envelope(updated, action)
            return self.envelope(operation)

    @staticmethod
    def _pid_alive(pid: Any) -> bool:
        if not isinstance(pid, int) or pid <= 0:
            return False
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True

    @staticmethod
    def _claude_controller_pid(operation: Dict[str, Any]) -> Any:
        active_attempt = operation.get("active_attempt") or {}
        return (
            active_attempt.get("controller_pid")
            or operation.get("recovery_controller_pid")
            or operation.get("controller_pid")
        )

    def _active_task_operations(self, task_ids: Optional[List[str]]) -> List[Tuple[Dict[str, Any], Dict[str, Any]]]:
        tasks: List[Dict[str, Any]] = []
        if task_ids is not None:
            for task_id in task_ids:
                try:
                    tasks.append(load_task(task_id, self.root))
                except AgentLordError as error:
                    if error.code != "TASK_UNKNOWN":
                        raise
        else:
            tasks = list_tasks(self.root)
        tasks_by_id = {task["task_id"]: task for task in tasks}
        result: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
        operations = all_operations(self.root)
        known_task_ids = set(tasks_by_id) | {operation.get("task_id") for operation in operations}
        if task_ids is not None:
            unknown = [task_id for task_id in task_ids if task_id not in known_task_ids]
            if unknown:
                raise AgentLordError(
                    "TASK_UNKNOWN",
                    "checkpoint contains an unknown task_id",
                    details={"task_ids": unknown},
                    exit_code=2,
                )
        for operation in operations:
            if operation.get("status") in TERMINAL_OPERATION_STATES:
                continue
            if task_ids is not None and operation.get("task_id") not in task_ids:
                continue
            task = tasks_by_id.get(operation["task_id"])
            if task is not None and task.get("last_operation_id") != operation["operation_id"]:
                continue
            if task is None:
                task = {
                    "task_id": operation["task_id"],
                    "provider": operation["provider"],
                    "target": operation["target"],
                    "endpoint_id": operation.get("endpoint_id"),
                    "route": {"host_id": None, "history": []},
                    "last_operation_id": operation["operation_id"],
                }
            result.append((task, operation))
        return result

    @staticmethod
    def _checkpoint_progress_seq(operation: Dict[str, Any]) -> Optional[int]:
        active_attempt = operation.get("active_attempt") or {}
        supervision = operation.get("observed", {}).get("supervision") or {}
        for value in (active_attempt.get("progress_seq"), supervision.get("progress_seq")):
            if isinstance(value, int) and not isinstance(value, bool):
                return value
        return None

    @classmethod
    def _compact_checkpoint_active(
        cls,
        active: List[Tuple[Dict[str, Any], Dict[str, Any]]],
    ) -> List[Dict[str, Any]]:
        result: List[Dict[str, Any]] = []
        for task, operation in active:
            active_attempt = operation.get("active_attempt") or {}
            supervision = operation.get("observed", {}).get("supervision") or {}
            result.append(
                {
                    "task_id": task["task_id"],
                    "operation_id": operation["operation_id"],
                    "provider": task["provider"],
                    "operation_status": operation.get("status"),
                    "supervision_state": supervision.get("state") or active_attempt.get("progress_state"),
                    "progress_seq": cls._checkpoint_progress_seq(operation),
                }
            )
        return result

    def _checkpoint_batch(
        self,
        envelopes: List[Dict[str, Any]],
        active: List[Tuple[Dict[str, Any], Dict[str, Any]]],
    ) -> Dict[str, Any]:
        actionable_ids = {item.get("operation_id") for item in envelopes}
        return {
            "version": 1,
            "status": "CHECKPOINT_ACTIONABLE",
            "actionable": envelopes,
            "active": self._compact_checkpoint_active(
                [pair for pair in active if pair[1].get("operation_id") not in actionable_ids]
            ),
        }

    def _checkpoint_actionable(
        self,
        task_ids: Optional[List[str]],
        active: List[Tuple[Dict[str, Any], Dict[str, Any]]],
    ) -> Optional[Dict[str, Any]]:
        latest_by_task: Dict[str, Dict[str, Any]] = {}
        durable_tasks = list_tasks(self.root)
        durable_task_ids = {task.get("task_id") for task in durable_tasks}
        for task in durable_tasks:
            task_id = task.get("task_id")
            operation_id = task.get("last_operation_id")
            if (
                isinstance(task_id, str)
                and isinstance(operation_id, str)
                and (task_ids is None or task_id in task_ids)
            ):
                latest_by_task[task_id] = load_operation(operation_id, self.root)
        for operation in all_operations(self.root):
            task_id = operation.get("task_id")
            if not isinstance(task_id, str) or (task_ids is not None and task_id not in task_ids):
                continue
            current = latest_by_task.get(task_id)
            if current is None:
                latest_by_task[task_id] = operation
            elif task_id not in durable_task_ids and (
                operation.get("created_at", ""), operation.get("operation_id", "")
            ) > (
                current.get("created_at", ""), current.get("operation_id", "")
            ):
                latest_by_task[task_id] = operation

        envelopes: List[Dict[str, Any]] = []
        for task_id in sorted(latest_by_task):
            operation = latest_by_task[task_id]
            if operation.get("status") in TERMINAL_OPERATION_STATES:
                envelopes.append(self.envelope(operation))
                continue
            action = pending_action(operation["operation_id"], self.root)
            if action is not None:
                envelopes.append(self.envelope(operation, action))
        return self._checkpoint_batch(envelopes, active) if envelopes else None

    def _finish_claimed_claude_recovery(self, operation: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        try:
            with self._write_leases(
                operation["target"],
                bool(operation.get("read_only")),
                operation.get("workspace") or {"policy": "exact-target"},
            ):
                return self._finish_claude(
                    operation,
                    operation["endpoint_id"],
                    resume=operation.get("kind") == "turn",
                )
        except AgentLordError as error:
            current = load_operation(operation["operation_id"], self.root)
            if current.get("status") in TERMINAL_OPERATION_STATES:
                return self.envelope(current)
            if error.code in ("STATE_BUSY", "WORKSPACE_WRITE_CONFLICT", "BRANCH_WRITE_CONFLICT"):
                return None
            raise

    def _recover_claude_operation(self, operation_id: str) -> Dict[str, Any]:
        """Run one already-claimed Claude recovery from a script-only controller."""
        validate_identifier("operation_id", operation_id)
        busy_error: Optional[AgentLordError] = None
        for _ in range(self.control["finalize_lock_attempts"]):
            try:
                with record_lock(
                    "controller-lease",
                    self._controller_lease_lock_id(operation_id),
                    self.root,
                ):
                    current = load_operation(operation_id, self.root)
                    if current.get("status") in TERMINAL_OPERATION_STATES:
                        return self.envelope(current)
                    if current.get("provider") != "claude-cli" or current.get("status") != "recovering":
                        raise AgentLordError(
                            "STATE_CONFLICT",
                            "operation is not awaiting Claude recovery",
                            details={"operation_id": operation_id, "status": current.get("status")},
                        )
                    owner_pid = current.get("recovery_controller_pid")
                    if owner_pid != os.getpid():
                        if self._pid_alive(owner_pid):
                            return self.envelope(current)
                        current = self._set_operation_status(
                            operation_id,
                            "recovering",
                            recovery_controller_pid=os.getpid(),
                            controller_pid=os.getpid(),
                        )
                    recovered = self._finish_claimed_claude_recovery(current)
                    return recovered if recovered is not None else self.envelope(load_operation(operation_id, self.root))
            except AgentLordError as error:
                if error.code != "STATE_BUSY":
                    raise
                busy_error = error
                time.sleep(self.control["finalize_lock_retry_interval_ms"] / 1000)
        else:
            assert busy_error is not None
            raise busy_error

    def _launch_claude_recovery(self, operation_id: str) -> Optional[Dict[str, Any]]:
        try:
            with record_lock(
                "controller-lease",
                self._controller_lease_lock_id(operation_id),
                self.root,
            ):
                operation = load_operation(operation_id, self.root)
                if operation.get("status") in TERMINAL_OPERATION_STATES:
                    return self.envelope(operation)
                if operation.get("provider") != "claude-cli" or operation.get("status") != "recovering":
                    return None
                owner_pid = operation.get("recovery_controller_pid")
                if self._pid_alive(owner_pid):
                    return None
                models = self._expanded_retry_models(operation)
                attempts = len(operation.get("attempt_history") or [])
                launches = operation.get("recovery_controller_launches", 0)
                if not isinstance(launches, int) or isinstance(launches, bool) or launches < 0:
                    launches = 0
                if attempts >= len(models) or launches >= max(1, len(models)):
                    error = AgentLordError(
                        "PROVIDER_FAILED",
                        "Claude recovery budget is exhausted",
                        details={
                            "attempts": attempts,
                            "retry_budget": len(models),
                            "controller_launches": launches,
                        },
                    )
                    failed, _ = self._terminalize_cli_failure(operation, error, exhausted=True)
                    return self.envelope(failed)
                endpoint_id = operation.get("endpoint_id")
                if not isinstance(endpoint_id, str) or not endpoint_id:
                    error = AgentLordError(
                        "PROCESS_EXITED_WITHOUT_RESULT",
                        "Claude recovery cannot continue without the original session identity",
                        details={"operation_id": operation_id},
                    )
                    failed, _ = self._terminalize_cli_failure(operation, error, exhausted=False)
                    return self.envelope(failed)
                worker = Path(__file__).resolve().parent.parent / "scripts" / "recovery_worker.py"
                try:
                    process = subprocess.Popen(
                        [
                            sys.executable,
                            str(worker),
                            "--state-dir",
                            str(self.root),
                            "--operation-id",
                            operation_id,
                        ],
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        start_new_session=os.name == "posix",
                    )
                except OSError as exc:
                    error = AgentLordError(
                        "PROVIDER_UNAVAILABLE",
                        "cannot launch the deterministic Claude recovery controller",
                        details={"error": str(exc)},
                    )
                    failed, _ = self._terminalize_cli_failure(operation, error, exhausted=False)
                    return self.envelope(failed)
                self._set_operation_status(
                    operation_id,
                    "recovering",
                    recovery_controller_pid=process.pid,
                    controller_pid=process.pid,
                    recovery_controller_launches=launches + 1,
                )
                append_event(
                    operation["task_id"],
                    "provider-recovery-controller-launched",
                    {"controller_pid": process.pid, "launch": launches + 1},
                    operation_id,
                    self.root,
                )
                Thread(
                    target=process.wait,
                    name="agent-lord-recovery-reaper-%d" % process.pid,
                    daemon=True,
                ).start()
                return None
        except AgentLordError as error:
            if error.code == "STATE_BUSY":
                return None
            raise

    def _retry_or_terminalize_claude(
        self,
        operation: Dict[str, Any],
        error: AgentLordError,
        session_observed: bool = False,
    ) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        active_attempt = operation.get("active_attempt") or {}
        attempt_number = active_attempt.get("number")
        attempt_model = active_attempt.get("model")
        models = self._expanded_retry_models(operation)
        if not isinstance(attempt_number, int) or not isinstance(attempt_model, str):
            failed, _ = self._terminalize_cli_failure(operation, error, exhausted=False)
            return None, self.envelope(failed)
        retrying = error.retryable and len(operation.get("attempt_history") or []) + 1 < len(models)
        updated = self._record_claude_attempt(
            operation,
            attempt_number,
            attempt_model,
            "failed",
            error,
            session_observed=session_observed,
            retrying=retrying,
            claim_controller=False,
        )
        if retrying:
            return updated, None
        failed, _ = self._terminalize_cli_failure(updated, error, exhausted=error.retryable)
        return None, self.envelope(failed)

    def _supervise_claude(self, operation: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        operation_id = operation["operation_id"]
        if operation.get("status") == "recovering" and not operation.get("active_attempt"):
            return self._launch_claude_recovery(operation_id)
        if self._pid_alive(self._claude_controller_pid(operation)):
            return None

        recovery_claim: Optional[Dict[str, Any]] = None
        try:
            with record_lock(
                "controller-lease",
                self._controller_lease_lock_id(operation_id),
                self.root,
            ):
                operation = load_operation(operation_id, self.root)
                if operation.get("status") in TERMINAL_OPERATION_STATES:
                    return self.envelope(operation)
                if self._pid_alive(self._claude_controller_pid(operation)):
                    return None
                active_attempt = operation.get("active_attempt") or {}
                provider_pid = active_attempt.get("pid") or operation.get("pid")

                if operation.get("status") == "preparing":
                    delivery = active_attempt.get("prompt_delivery")
                    if delivery in ("delivery-unknown", "stdin-attached") and not isinstance(provider_pid, int):
                        error = AgentLordError(
                            "DELIVERY_UNKNOWN",
                            "Claude may have received the prompt but its provider process cannot be fenced",
                            details={"operation_id": operation_id, "prompt_delivery": delivery},
                        )
                        failed, _ = self._terminalize_cli_failure(operation, error, exhausted=False)
                        return self.envelope(failed)
                    if isinstance(provider_pid, int) and self._pid_alive(provider_pid):
                        try:
                            terminate_claude_process(
                                provider_pid,
                                active_attempt.get("process_group_id"),
                                self.control["claude_terminate_grace_seconds"],
                            )
                        except AgentLordError as error:
                            failed, _ = self._terminalize_cli_failure(operation, error, exhausted=False)
                            return self.envelope(failed)
                    if active_attempt:
                        error = AgentLordError(
                            "CONTROLLER_EXITED_DURING_DELIVERY",
                            "Claude controller exited before attempt delivery was resolved",
                            retryable=True,
                            safe_recovery=(
                                "RETRY_ORIGINAL_PROMPT"
                                if delivery == "not-delivered"
                                else "RESUME_SAME_ENDPOINT_WITH_CONTINUATION_QUERY"
                            ),
                            details={"prompt_delivery": delivery},
                        )
                        recovery_claim, terminal = self._retry_or_terminalize_claude(
                            operation,
                            error,
                            session_observed=claude_session_observed(operation),
                        )
                        if terminal is not None:
                            return terminal
                    elif self._expanded_retry_models(operation) and isinstance(operation.get("endpoint_id"), str):
                        recovery_claim = self._set_operation_status(
                            operation_id,
                            "recovering",
                            controller_pid=None,
                            recovery_controller_pid=None,
                        )
                    else:
                        error = AgentLordError(
                            "PROCESS_EXITED_WITHOUT_RESULT",
                            "Claude controller exited before a recoverable attempt was prepared",
                        )
                        failed, _ = self._terminalize_cli_failure(operation, error, exhausted=False)
                        return self.envelope(failed)
                elif self._pid_alive(provider_pid):
                    activity_ms = claude_output_activity_ms(operation)
                    progress_state = active_attempt.get("progress_state")
                    stall_seconds = (
                        self.control["claude_tool_stall_seconds"]
                        if progress_state == "tool_wait"
                        else self.control["claude_stall_seconds"]
                    )
                    if not isinstance(activity_ms, int) or int(time.time() * 1000) - activity_ms < stall_seconds * 1000:
                        return None
                    self._set_operation_status(
                        operation_id,
                        operation.get("status", "running"),
                        observed=dict(operation.get("observed") or {}, supervision={
                            "state": "suspected_stall",
                            "attempt": active_attempt.get("number"),
                            "last_progress_at_ms": activity_ms,
                            "controller_state": "dead",
                        }),
                    )
                    try:
                        terminate_claude_process(
                            provider_pid,
                            active_attempt.get("process_group_id"),
                            self.control["claude_terminate_grace_seconds"],
                        )
                    except AgentLordError as error:
                        failed, _ = self._terminalize_cli_failure(operation, error, exhausted=False)
                        return self.envelope(failed)
                    error = AgentLordError(
                        "PROVIDER_STALLED",
                        "Claude controller disappeared and the live provider attempt stopped making progress",
                        retryable=True,
                        safe_recovery="RESUME_SAME_ENDPOINT_WITH_CONTINUATION_QUERY",
                        details={"provider_pid": provider_pid},
                    )
                    recovery_claim, terminal = self._retry_or_terminalize_claude(
                        operation,
                        error,
                        session_observed=bool(active_attempt.get("session_observed")) or claude_session_observed(operation),
                    )
                    if terminal is not None:
                        return terminal
                else:
                    if isinstance(provider_pid, int):
                        try:
                            terminate_claude_process(
                                provider_pid,
                                active_attempt.get("process_group_id"),
                                self.control["claude_terminate_grace_seconds"],
                            )
                        except AgentLordError as error:
                            failed, _ = self._terminalize_cli_failure(operation, error, exhausted=False)
                            return self.envelope(failed)
                    try:
                        recovered = recover_claude(operation)
                    except AgentLordError as error:
                        if error.code == "RESULT_INVALID":
                            first_seen = operation.get("dead_process_observed_at_ms")
                            now_ms = int(time.time() * 1000)
                            if not isinstance(first_seen, int):
                                self._set_operation_status(
                                    operation_id,
                                    operation.get("status", "running"),
                                    dead_process_observed_at_ms=now_ms,
                                )
                                return None
                            if now_ms - first_seen < self.control["dead_process_result_grace_seconds"] * 1000:
                                return None
                            error = AgentLordError(
                                "PROCESS_EXITED_WITHOUT_RESULT",
                                "Claude process exited without publishing a recoverable terminal result",
                                retryable=True,
                                safe_recovery="RESUME_SAME_ENDPOINT_WITH_CONTINUATION_QUERY",
                                details={"provider_error": error.as_dict()},
                            )
                        recovery_claim, terminal = self._retry_or_terminalize_claude(
                            operation,
                            error,
                            session_observed=claude_session_observed(operation),
                        )
                        if terminal is not None:
                            return terminal
                    else:
                        endpoint_id = recovered.get("endpoint_id") or operation.get("endpoint_id")
                        if not isinstance(endpoint_id, str) or not endpoint_id:
                            error = AgentLordError("RESULT_INVALID", "recovered Claude result lacks endpoint identity")
                            failed, _ = self._terminalize_cli_failure(operation, error, exhausted=False)
                            return self.envelope(failed)
                        attempt_number = active_attempt.get("number")
                        attempt_model = active_attempt.get("model")
                        if isinstance(attempt_number, int) and isinstance(attempt_model, str):
                            operation = self._record_claude_attempt(
                                operation,
                                attempt_number,
                                attempt_model,
                                "succeeded",
                                warnings=recovered.get("observed", {}).get("warnings"),
                            )
                        history = operation.get("attempt_history") or []
                        recovered["observed"].update(
                            {
                                "attempts": len(history),
                                "attempt_history": history,
                                "requested_model": operation.get("expected", {}).get("model"),
                                "fallback_used": bool(
                                    isinstance(attempt_model, str)
                                    and attempt_model != operation.get("expected", {}).get("model")
                                ),
                            }
                        )
                        return self._publish_cli_result(
                            operation,
                            endpoint_id,
                            operation.get("kind") == "turn",
                            recovered,
                        )
        except AgentLordError as error:
            if error.code == "STATE_BUSY":
                return None
            raise
        return self._launch_claude_recovery(recovery_claim["operation_id"]) if recovery_claim else None

    def _supervise_codex_cli(self, operation: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if self._pid_alive(operation.get("pid")):
            return None
        try:
            with record_lock(
                "operation-control",
                self._operation_control_lock_id(operation["operation_id"]),
                self.root,
            ):
                operation = load_operation(operation["operation_id"], self.root)
                if operation.get("status") != "running" or self._pid_alive(operation.get("pid")):
                    return None
                try:
                    recovered = recover_codex_cli(operation)
                except AgentLordError as error:
                    if error.code == "RESULT_INVALID":
                        first_seen = operation.get("dead_process_observed_at_ms")
                        now_ms = int(time.time() * 1000)
                        if not isinstance(first_seen, int):
                            self._set_operation_status(
                                operation["operation_id"],
                                "running",
                                dead_process_observed_at_ms=now_ms,
                            )
                            return None
                        if now_ms - first_seen < self.control["dead_process_result_grace_seconds"] * 1000:
                            return None
                        error = AgentLordError(
                            "PROCESS_EXITED_WITHOUT_RESULT",
                            "Codex CLI process exited without publishing a recoverable terminal result",
                            retryable=True,
                            safe_recovery="INSPECT_LOGS_THEN_RETRY_SAME_ENDPOINT",
                            details={"provider_error": error.as_dict()},
                        )
                    return self.envelope(self._fail_operation(operation, error))
                endpoint_id = recovered.get("endpoint_id") or operation.get("endpoint_id")
                if not isinstance(endpoint_id, str) or not endpoint_id:
                    error = AgentLordError("RESULT_INVALID", "recovered Codex CLI result lacks endpoint identity")
                    return self.envelope(self._fail_operation(operation, error))
                return self._publish_cli_result(
                    operation,
                    endpoint_id,
                    operation.get("kind") == "turn",
                    recovered,
                )
        except AgentLordError as error:
            if error.code == "STATE_BUSY":
                return None
            raise

    def checkpoint(self, task_ids: Optional[List[str]], seconds: int) -> Tuple[Dict[str, Any], bool]:
        if seconds <= 0:
            raise AgentLordError("CONFIG_INVALID", "checkpoint seconds must be greater than zero", exit_code=2)
        active = self._active_task_operations(task_ids)
        selected_task_ids = task_ids if task_ids is not None else [task["task_id"] for task, _ in active]
        actionable = self._checkpoint_actionable(selected_task_ids, active)
        if actionable is not None:
            return actionable, False
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            current_active = self._active_task_operations(selected_task_ids)
            actionable = self._checkpoint_actionable(selected_task_ids, current_active)
            if actionable is not None:
                return actionable, False
            for task, operation in current_active:
                if task["provider"] == "claude-cli":
                    envelope = self._supervise_claude(operation)
                elif task["provider"] == "codex-cli" and operation.get("status") == "running":
                    envelope = self._supervise_codex_cli(operation)
                else:
                    envelope = None
                if envelope is not None:
                    return self._checkpoint_batch([envelope], current_active), False
            poll_seconds = min(0.25, max(0.05, self.control["claude_progress_poll_interval_ms"] / 1000))
            time.sleep(min(poll_seconds, max(0.0, deadline - time.monotonic())))

        active = self._active_task_operations(selected_task_ids)
        actionable = self._checkpoint_actionable(selected_task_ids, active)
        if actionable is not None:
            return actionable, False
        return {
            "version": 1,
            "status": "CHECKPOINT_QUIET",
            "seconds": seconds,
            "active": self._compact_checkpoint_active(active),
        }, True

    def export_artifact(self, task_id: str, operation_id: str, source_file: str, source_format: str) -> Dict[str, Any]:
        operation = load_operation(operation_id, self.root)
        if operation.get("task_id") != task_id:
            raise AgentLordError("ENDPOINT_MISMATCH", "operation does not belong to task_id")
        required_marker = (
            codex_adapter.operation_marker(operation_id)
            if operation.get("provider") in ("codex-app", "codex-cli")
            else None
        )
        extracted = extract_jsonl_with_metadata(
            Path(source_file).expanduser().resolve(),
            source_format,
            required_operation_marker=required_marker,
        )
        observed = extracted["observed"]
        expected = operation.get("expected", {})
        expected_model = expected.get("model")
        observed_models = observed.get("models") or []
        if expected_model:
            matches = [
                expected_model_matches(expected_model, model)
                if operation["provider"] == "claude-cli"
                else expected_model.lower() == model.lower()
                for model in observed_models
            ]
            if not matches or not all(matches):
                error = AgentLordError(
                    "MODEL_MISMATCH" if observed_models else "MODEL_UNVERIFIED",
                    "provider log does not satisfy the saved model contract",
                    retryable=True,
                    safe_recovery="RETRY_SAME_ENDPOINT_WITH_SAVED_EXECUTION_CONTRACT",
                    details={"expected": expected_model, "observed": observed_models},
                )
                self._fail_operation(operation, error)
                raise error
        expected_effort = expected.get("effort")
        if expected_effort:
            observed_effort = observed.get("effort")
            if not observed_effort or expected_effort != observed_effort:
                error = AgentLordError(
                    "EFFORT_MISMATCH" if observed_effort else "EFFORT_UNVERIFIED",
                    "provider log does not satisfy the saved reasoning-effort contract",
                    retryable=True,
                    safe_recovery="RETRY_SAME_ENDPOINT_WITH_SAVED_EXECUTION_CONTRACT",
                    details={"expected": expected_effort, "observed": observed_effort},
                )
                self._fail_operation(operation, error)
                raise error
        artifact = write_artifact(task_id, operation_id, extracted["text"], self.root)
        updated = self._set_operation_status(
            operation_id,
            operation.get("status", "submitted"),
            artifact=artifact,
            observed=observed,
        )
        append_event(task_id, "artifact-exported", artifact, operation_id, self.root)
        return self.envelope(updated)

    def envelope(self, operation: Dict[str, Any], action: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if action is None:
            action = pending_action(operation["operation_id"], self.root)
        status_map = {
            "preparing": "RUNNING",
            "running": "RUNNING",
            "recovering": "RUNNING",
            "submitted": "RUNNING",
            "awaiting_action": "ACTION_REQUIRED" if action else "RUNNING",
            "succeeded": "SUCCEEDED",
            "failed": "ERROR",
            "needs_decision": "NEEDS_DECISION",
        }
        result: Dict[str, Any] = {
            "version": 1,
            "status": status_map.get(operation.get("status"), "ERROR"),
            "task_id": operation["task_id"],
            "operation_id": operation["operation_id"],
            "provider": operation["provider"],
            "operation_status": operation.get("status"),
            "expected": operation.get("expected", {}),
            "observed": operation.get("observed", {}),
            "source": operation.get("source", {}),
            "workspace": operation.get("workspace", {}),
            "parallel_plan": operation.get("parallel_plan", {}),
        }
        try:
            task = load_task(operation["task_id"], self.root)
        except AgentLordError as error:
            if error.code != "TASK_UNKNOWN":
                raise
        else:
            result["endpoint_id"] = task.get("endpoint_id")
            result["route"] = task.get("route")
            result["target"] = task.get("target")
        if operation.get("artifact"):
            result["artifact"] = operation["artifact"]
        if operation.get("error"):
            result["error"] = operation["error"]
        warnings = operation.get("observed", {}).get("warnings")
        if isinstance(warnings, list) and warnings:
            result["warnings"] = warnings
        if action:
            result["action"] = codex_adapter.action_public(action)
        return result
