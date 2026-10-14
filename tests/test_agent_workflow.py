import importlib.util
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


APPLY = load("apply_triage", ".github/scripts/apply_triage.py")
INTAKE = load("intake_feedback", ".github/scripts/intake_feedback.py")
SUBMIT = load("submit_feedback", "tools/submit_feedback.py")
VALIDATE = load("validate_repo", "tools/validate_repo.py")


def verdict(**overrides):
    data = {
        "decision": "accepted",
        "type": "bug",
        "size": "S",
        "risk": "low",
        "duplicate_of": None,
        "summary": "飞书文档里的有序列表编号丢失",
        "reasoning": "问题在 worker/index.ts 的 renderDocument 列表分支。",
        "plan": ["在 renderDocument 中保留有序列表编号", "补充 tests/ 下的测试"],
        "questions": [],
    }
    data.update(overrides)
    return data


class TriageTests(unittest.TestCase):
    def load_verdict(self, **overrides):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "triage.json"
            path.write_text(json.dumps(verdict(**overrides)), encoding="utf-8")
            return APPLY.load_result(path)

    def test_collaborator_small_bug_is_auto_implemented(self):
        actions = APPLY.plan_actions(self.load_verdict(), "COLLABORATOR", "github", True)
        self.assertTrue(actions["implement"])
        self.assertIn("triage:accepted", actions["labels"])
        self.assertNotIn("status:awaiting-maintainer", actions["labels"])

    def test_outside_contributor_waits_for_maintainer(self):
        actions = APPLY.plan_actions(self.load_verdict(), "NONE", "github", True)
        self.assertFalse(actions["implement"])
        self.assertIn("status:awaiting-maintainer", actions["labels"])
        self.assertIn("agent:implement", actions["comment"])

    def test_intake_sources_are_trusted(self):
        actions = APPLY.plan_actions(self.load_verdict(), "NONE", "social", True)
        self.assertTrue(actions["implement"])

    def test_auto_implement_switch_off(self):
        actions = APPLY.plan_actions(self.load_verdict(), "OWNER", "github", False)
        self.assertFalse(actions["implement"])

    def test_large_or_high_risk_needs_human(self):
        for overrides in ({"size": "L"}, {"risk": "high"}, {"type": "question"}):
            with self.subTest(**overrides):
                actions = APPLY.plan_actions(self.load_verdict(**overrides), "OWNER", "github", True)
                self.assertFalse(actions["implement"])

    def test_invalid_fields_fall_back_to_conservative_values(self):
        result = self.load_verdict(size="XL", risk="none", type="layout", duplicate_of="12")
        self.assertEqual((result["size"], result["risk"], result["type"]), ("L", "high", "question"))
        self.assertIsNone(result["duplicate_of"])

    def test_invalid_decision_is_rejected(self):
        with self.assertRaises(ValueError):
            self.load_verdict(decision="merge-now")

    def test_needs_info_lists_questions(self):
        actions = APPLY.plan_actions(
            self.load_verdict(decision="needs-info", questions=["无痕窗口里不登录能打开这个文档吗？"]),
            "NONE",
            "github",
            True,
        )
        self.assertIn("- 无痕窗口里不登录能打开这个文档吗？", actions["comment"])
        self.assertNotIn("status:awaiting-maintainer", actions["labels"])

    def test_comment_redacts_credentials(self):
        # 拼接出来，避免仓库里出现完整的疑似凭据字面量（validate_repo 会扫描）。
        leaked = "sk-ant-" + "api03-abcdefghijklmnop"
        with mock.patch.dict(os.environ, {"GH_TOKEN": "ghs_secretvalue123"}):
            actions = APPLY.plan_actions(
                self.load_verdict(summary=f"{leaked} ghs_secretvalue123"), "OWNER", "github", True
            )
        self.assertNotIn(leaked, actions["comment"])
        self.assertNotIn("ghs_secretvalue123", actions["comment"])
        self.assertIn("[REDACTED]", actions["comment"])


class IntakeTests(unittest.TestCase):
    def test_repository_dispatch_payload(self):
        item = INTAKE.normalize(
            "repository_dispatch",
            {"client_payload": {"source": "social", "platform": "小红书", "url": "https://x/1", "title": "希望支持语雀文档", "body": "公开的语雀链接也想转成 Markdown"}},
        )
        self.assertEqual(item["source"], "social")
        body = INTAKE.render_issue(item)
        self.assertIn("小红书", body)
        self.assertIn("> 公开的语雀链接也想转成 Markdown", body)

    def test_unknown_source_defaults_to_social(self):
        item = INTAKE.normalize("workflow_dispatch", {"inputs": {"source": "evil", "title": "t", "body": "b"}})
        self.assertEqual(item["source"], "social")

    def test_title_falls_back_to_first_body_line(self):
        item = INTAKE.normalize("repository_dispatch", {"client_payload": {"body": "第一行\n第二行"}})
        self.assertEqual(item["title"], "第一行")

    def test_empty_feedback_is_rejected(self):
        with self.assertRaises(ValueError):
            INTAKE.normalize("repository_dispatch", {"client_payload": {}})

    def test_discussion_event(self):
        event = {
            "discussion": {
                "category": {"name": "Ideas"},
                "html_url": "https://github.com/o/r/discussions/3",
                "user": {"login": "alice"},
                "title": "ZIP 里的图片能按顺序命名吗",
                "body": None,
            }
        }
        item = INTAKE.normalize("discussion", event)
        self.assertEqual((item["source"], item["author"]), ("community", "alice"))

    def test_long_text_is_clipped(self):
        item = INTAKE.normalize("repository_dispatch", {"client_payload": {"title": "x" * 200, "body": "y"}})
        self.assertEqual(len(item["title"]), INTAKE.MAX_TITLE)


class SubmitFeedbackTests(unittest.TestCase):
    def test_payload_shape(self):
        args = SUBMIT.argparse.Namespace(
            source="social", platform="微博", url="https://weibo.com/1", author="a", title="t", body="b"
        )
        payload = SUBMIT.build_payload(args)
        self.assertEqual(payload["event_type"], "feedback")
        self.assertEqual(payload["client_payload"]["platform"], "微博")


class ValidateRepoTests(unittest.TestCase):
    def test_repository_passes(self):
        self.assertEqual(VALIDATE.validate(), [])

    def test_missing_referenced_path_is_reported(self):
        errors = []
        with mock.patch.object(Path, "read_text", return_value="见 `worker/不存在.ts` 和 [链接](docs/没有.md)"):
            VALIDATE.check_referenced_paths(errors)
        self.assertTrue(any("worker/不存在.ts" in e for e in errors))
        self.assertTrue(any("docs/没有.md" in e for e in errors))

    def test_existing_and_wildcard_paths_pass(self):
        errors = []
        with mock.patch.object(Path, "read_text", return_value="`worker/index.ts`、`tests/*.test.mjs`、`package.json`"):
            VALIDATE.check_referenced_paths(errors)
        self.assertEqual(errors, [])

    def test_dependency_drift_is_reported(self):
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        package["dependencies"] = {**package.get("dependencies", {}), "left-pad": "^1.3.0"}
        real_load = VALIDATE.load_json

        def fake_load(path, errors):
            return package if path == "package.json" else real_load(path, errors)

        errors = []
        with mock.patch.object(VALIDATE, "load_json", side_effect=fake_load):
            VALIDATE.check_package(errors)
        self.assertTrue(any("dependencies" in e and "package-lock.json" in e for e in errors))

    def test_secret_like_text_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            leaked = Path(tmp) / "notes.md"
            leaked.write_text("token: gh" + "p_" + "a" * 36, encoding="utf-8")
            errors = []
            with mock.patch.object(VALIDATE, "ROOT", Path(tmp)), mock.patch.object(
                VALIDATE, "repo_files", return_value=[leaked]
            ):
                VALIDATE.check_text_files(errors)
        self.assertEqual(errors, ["疑似包含凭据或私钥：notes.md"])


class LabelConfigTests(unittest.TestCase):
    def test_every_label_used_by_scripts_is_defined(self):
        defined = {label["name"] for label in json.loads((ROOT / ".github/labels.json").read_text(encoding="utf-8"))}
        required = {"needs-triage", "agent:implement", "agent:in-progress", "agent:pr-open", "agent:failed", "agent-pr"}
        required |= {f"triage:{d}" for d in APPLY.DECISIONS}
        required |= {f"type:{t}" for t in APPLY.TYPES}
        required |= {f"size:{s}" for s in APPLY.SIZES}
        required |= {f"risk:{r}" for r in APPLY.RISKS}
        required |= {"agent:skip", "status:awaiting-maintainer"}
        required |= {f"source:{s}" for s in INTAKE.SOURCES}
        self.assertEqual(required - defined, set())


class AgentPrScriptTests(unittest.TestCase):
    def test_forbidden_paths_block_sensitive_files(self):
        script = (ROOT / ".github/scripts/open_agent_pr.sh").read_text(encoding="utf-8")
        line = next(l for l in script.splitlines() if l.startswith("forbidden="))
        pattern = re.search(r"grep -E '([^']+)'", line).group(1)
        blocked = [".github/workflows/x.yml", ".openai/hosting.json", "drizzle/0001.sql", "LICENSE",
                   "package-lock.json", ".env.local", "app/.env", "certs/key.pem"]
        allowed = ["worker/index.ts", "app/page.tsx", "README.md", "package.json", "tests/a.test.mjs"]
        for path in blocked:
            with self.subTest(path=path):
                self.assertRegex(path, pattern)
        for path in allowed:
            with self.subTest(path=path):
                self.assertNotRegex(path, pattern)

    def test_agent_pr_runs_every_check(self):
        script = (ROOT / ".github/scripts/open_agent_pr.sh").read_text(encoding="utf-8")
        for command in ("npm run lint", "npm test", "python tools/validate_repo.py", "python -m unittest discover -s tests"):
            self.assertIn(f"check {command}", script)


if __name__ == "__main__":
    unittest.main()
