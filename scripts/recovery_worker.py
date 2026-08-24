#!/usr/bin/env python3
"""Private deterministic controller for an already-authorized Claude recovery."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agent_lord import AgentLord, AgentLordError  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--operation-id", required=True)
    args = parser.parse_args()
    try:
        AgentLord(Path(args.state_dir).expanduser().resolve())._recover_claude_operation(args.operation_id)
    except AgentLordError as error:
        return error.exit_code
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
