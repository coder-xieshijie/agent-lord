"""Stable error taxonomy emitted by Agent Lord."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional


@dataclass
class AgentLordError(Exception):
    code: str
    message: str
    retryable: bool = False
    safe_recovery: Optional[str] = None
    requires_authorization: bool = False
    details: Dict[str, Any] = field(default_factory=dict)
    exit_code: int = 1

    def __post_init__(self) -> None:
        super().__init__(self.message)

    def as_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "requires_authorization": self.requires_authorization,
        }
        if self.safe_recovery:
            result["safe_recovery"] = self.safe_recovery
        if self.details:
            result["details"] = self.details
        return result


def usage_error(message: str, **details: Any) -> AgentLordError:
    return AgentLordError(
        "CONFIG_INVALID",
        message,
        details=details,
        exit_code=2,
    )
