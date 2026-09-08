from pathlib import Path
import subprocess
import tempfile
import unittest

from agent_lord import AgentLordError
from agent_lord.delivery import requirements, verify


class DeliveryTests(unittest.TestCase):
    def test_files_must_be_nonempty_and_remain_inside_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "work"
            workspace.mkdir()
            spec = requirements(str(workspace), ["result.md"], False)
            op = {"target": str(workspace), "delivery_requirements": spec}
            self.assertEqual("incomplete", verify(op)["status"])
            (workspace / "result.md").write_text("")
            self.assertEqual("incomplete", verify(op)["status"])
            (workspace / "result.md").write_text("done")
            self.assertEqual("verified", verify(op)["status"])
            (workspace / "result.md").unlink()
            (root / "outside").write_text("not our delivery")
            (workspace / "result.md").symlink_to(root / "outside")
            self.assertEqual("incomplete", verify(op)["status"])
            for invalid in ("../outside", "/tmp/outside", "result.md"):
                with self.subTest(invalid=invalid), self.assertRaises(AgentLordError):
                    requirements(str(workspace), [invalid], False)

    def test_commit_requires_new_descendant_and_clean_worktree(self):
        with tempfile.TemporaryDirectory() as tmp:
            def git(*args):
                return subprocess.run(["git", "-C", tmp, *args], check=True, capture_output=True, text=True).stdout.strip()
            git("init")
            git("config", "user.name", "Fixture")
            git("config", "user.email", "fixture@example.invalid")
            file = Path(tmp) / "result.md"
            file.write_text("initial")
            git("add", ".")
            git("commit", "-m", "initial")
            op = {"target": tmp, "delivery_requirements": requirements(tmp, ["result.md"], True)}
            self.assertEqual("incomplete", verify(op)["status"])
            file.write_text("delivered")
            git("commit", "-am", "deliver")
            self.assertEqual("verified", verify(op)["status"])
            file.write_text("uncommitted")
            self.assertEqual("incomplete", verify(op)["status"])
