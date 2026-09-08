"""Content-free MCode lifecycle summaries for supervision and observers."""

from __future__ import annotations

import re
from typing import Any, Dict


class MCodeProgress:
    def __init__(self) -> None:
        self.tools: Dict[str, str] = {}
        self.last_tool: str | None = None

    def observe(self, event: Dict[str, Any]) -> Dict[str, Any]:
        kind = event["type"]
        item = event.get("item") or {}
        if not isinstance(item, dict):
            item = {}
        if item.get("type") == "tool_call":
            tool = item.get("toolCall") or {}
            if not isinstance(tool, dict):
                tool = {}
            identity = tool.get("id") or item.get("id")
            name = tool.get("name")
            name = name if isinstance(name, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_.:-]{0,79}", name) else "tool"
            self.last_tool = name
            if isinstance(identity, str):
                if kind == "item.completed" or tool.get("status") in (2, 3):
                    self.tools.pop(identity, None)
                else:
                    self.tools[identity] = name
        state = "tool_wait" if self.tools else "progressing"
        if kind in ("exec.started", "session.started", "session.resumed", "turn.started"):
            state = "provider_wait"
        if kind in ("turn.completed", "turn.failed", "exec.completed"):
            self.tools.clear()
            state = "provider_failed" if kind == "turn.failed" else "progressing"
            if kind == "exec.completed":
                state = "succeeded" if (event.get("result") or {}).get("status") == "succeeded" else "provider_failed"
        return {
            "state": state,
            "last_event_type": kind,
            "active_tool_count": len(self.tools),
            "active_tools": sorted(set(self.tools.values()))[:5],
            "last_tool": self.last_tool,
        }
