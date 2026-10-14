#!/usr/bin/env python3
"""仓库不变量检查：npm 配置与锁文件、部署绑定、文档里引用的路径、文本编码、疑似凭据、脚本语法和标签配置。

只读，只用 Python 标准库，不安装依赖也不构建。网页应用的构建与测试走 `npm run lint` / `npm test`。
"""

import json
import py_compile
import re
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REQUIRED_FILES = (
    "README.md",
    "CLAUDE.md",
    "package.json",
    "package-lock.json",
    ".openai/hosting.json",
    ".github/labels.json",
    "docs/agent-workflow.md",
)
REQUIRED_SCRIPTS = ("dev", "build", "test", "lint")
# 文档里用反引号或 Markdown 链接引用的仓库内路径，必须真实存在。
PATH_PREFIXES = ("app/", "worker/", "tests/", "tools/", "docs/", "db/", "build/", "drizzle/", "examples/", "public/", ".github/", ".openai/")
ROOT_FILES = ("package.json", "package-lock.json", "vite.config.ts", "next.config.ts", "eslint.config.mjs", "tsconfig.json", "README.md", "CLAUDE.md")
PATH_PATTERN = re.compile(
    r"(?:`|\]\()((?:%s)[^`)\s]*|(?:%s)(?=[`)#]))"
    % ("|".join(re.escape(p) for p in PATH_PREFIXES), "|".join(re.escape(f) for f in ROOT_FILES))
)
DOCS = ("README.md", "CLAUDE.md", "docs/agent-workflow.md", ".github/pull_request_template.md")
# 工作流里调用的仓库脚本必须存在。
WORKFLOW_PATH_PATTERN = re.compile(r"(?<![\w/.-])((?:\.github/(?:scripts|agent)|tools)/[\w.-]+\.(?:py|sh|md))")
TEXT_SUFFIXES = {".md", ".yml", ".yaml", ".json", ".ts", ".tsx", ".mjs", ".js", ".css", ".py", ".sh", ".txt"}
SKIP_DIRS = {".git", "node_modules", "dist", ".next", ".vinext", ".wrangler", ".agent-in", ".agent-out", ".venv", "venv", "out", "outputs", "work", ".tools"}
SECRET_PATTERNS = (
    re.compile(r"sk-ant-[A-Za-z0-9_-]{8,}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
)


def load_json(path, errors):
    try:
        return json.loads((ROOT / path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        errors.append(f"{path} 无法解析：{exc}")
        return None


def check_package(errors):
    package = load_json("package.json", errors)
    lock = load_json("package-lock.json", errors)
    if package is None or lock is None:
        return
    scripts = package.get("scripts") or {}
    for name in REQUIRED_SCRIPTS:
        if not scripts.get(name):
            errors.append(f"package.json 缺少 scripts.{name}")
    if not (package.get("engines") or {}).get("node"):
        errors.append("package.json 缺少 engines.node")

    # npm test 显式列出测试文件：列出的要存在，tests/ 下的 *.test.mjs 也都要被列出，否则不会运行。
    test_script = scripts.get("test", "")
    listed = set(re.findall(r"tests/[\w./-]+\.test\.m?js", test_script))
    for path in sorted(listed):
        if not (ROOT / path).is_file():
            errors.append(f"package.json 的 test 脚本引用了不存在的文件：{path}")
    for path in sorted(ROOT.glob("tests/*.test.*js")):
        rel = path.relative_to(ROOT).as_posix()
        if rel not in listed:
            errors.append(f"测试文件没有加进 package.json 的 test 脚本：{rel}")

    # 依赖必须和锁文件一致：改了 package.json 却没更新锁文件，npm ci 会失败。
    if lock.get("name") != package.get("name"):
        errors.append("package-lock.json 的 name 与 package.json 不一致")
    if not isinstance(lock.get("lockfileVersion"), int) or lock["lockfileVersion"] < 2:
        errors.append("package-lock.json 的 lockfileVersion 需要 >= 2")
        return
    root_entry = (lock.get("packages") or {}).get("", {})
    for key in ("dependencies", "devDependencies"):
        if (package.get(key) or {}) != (root_entry.get(key) or {}):
            errors.append(f"package.json 的 {key} 与 package-lock.json 不一致，请运行 npm install 更新锁文件")


def check_hosting(errors):
    hosting = load_json(".openai/hosting.json", errors)
    if hosting is None:
        return
    if not isinstance(hosting, dict) or not isinstance(hosting.get("project_id"), str) or not hosting["project_id"]:
        errors.append(".openai/hosting.json 缺少 project_id")


def check_referenced_paths(errors):
    docs = list(DOCS) + sorted(p.relative_to(ROOT).as_posix() for p in ROOT.glob(".github/agent/*.md"))
    for doc in docs:
        if not (ROOT / doc).is_file():
            continue
        for raw in PATH_PATTERN.findall((ROOT / doc).read_text(encoding="utf-8")):
            path = raw.split("#", 1)[0].rstrip("/.,，。")
            if any(ch in path for ch in "*{<…"):
                continue
            if not (ROOT / path).exists():
                errors.append(f"{doc} 引用的路径不存在：{path}")


def check_workflows(errors):
    for workflow in sorted(ROOT.glob(".github/workflows/*.y*ml")):
        text = workflow.read_text(encoding="utf-8")
        for path in sorted(set(WORKFLOW_PATH_PATTERN.findall(text))):
            if not (ROOT / path).is_file():
                errors.append(f"{workflow.relative_to(ROOT).as_posix()} 引用的文件不存在：{path}")


def repo_files():
    """Tracked plus untracked-but-not-ignored files; falls back to walking the tree without git."""
    try:
        out = subprocess.run(
            ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            cwd=ROOT,
            check=True,
            capture_output=True,
        ).stdout.decode("utf-8")
        files = [ROOT / name for name in out.split("\0") if name]
    except (OSError, subprocess.CalledProcessError):
        files = [
            path
            for path in ROOT.rglob("*")
            if path.is_file() and not SKIP_DIRS.intersection(path.relative_to(ROOT).parts)
        ]
    return sorted(path for path in files if path.is_file())


def check_text_files(errors):
    for path in repo_files():
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        rel = path.relative_to(ROOT).as_posix()
        try:
            text = path.read_bytes().decode("utf-8")
        except UnicodeDecodeError:
            errors.append(f"不是 UTF-8 编码：{rel}")
            continue
        for pattern in SECRET_PATTERNS:
            if pattern.search(text):
                errors.append(f"疑似包含凭据或私钥：{rel}")
                break


def check_python(errors):
    files = sorted(ROOT.glob("tools/*.py")) + sorted(ROOT.glob(".github/scripts/*.py")) + sorted(ROOT.glob("tests/*.py"))
    with tempfile.TemporaryDirectory() as tmp:
        for i, path in enumerate(files):
            try:
                py_compile.compile(str(path), cfile=str(Path(tmp) / f"{i}.pyc"), doraise=True)
            except py_compile.PyCompileError as exc:
                errors.append(f"语法错误：{path.relative_to(ROOT)}：{exc.msg.strip()}")


def check_labels(errors):
    labels = load_json(".github/labels.json", errors)
    if labels is None:
        return
    names = [label["name"] for label in labels]
    if len(names) != len(set(names)):
        errors.append(".github/labels.json 有重名标签")
    for label in labels:
        if not re.fullmatch(r"[0-9a-f]{6}", label.get("color", "")):
            errors.append(f"标签颜色不是 6 位十六进制：{label['name']}")
    # Issue 模板自动打的标签必须在 labels.json 里定义。
    for template in sorted(ROOT.glob(".github/ISSUE_TEMPLATE/*.yml")):
        match = re.search(r"^labels:\s*\[(.*)\]\s*$", template.read_text(encoding="utf-8"), re.M)
        for name in re.findall(r'"([^"]+)"', match.group(1)) if match else []:
            if name not in names:
                errors.append(f"{template.relative_to(ROOT).as_posix()} 使用了未定义的标签：{name}")


def validate():
    errors = [f"缺少文件：{name}" for name in REQUIRED_FILES if not (ROOT / name).is_file()]
    if errors:
        return errors
    for check in (
        check_package,
        check_hosting,
        check_referenced_paths,
        check_workflows,
        check_text_files,
        check_python,
        check_labels,
    ):
        check(errors)
    return errors


def main():
    errors = validate()
    for error in errors:
        print(f"✗ {error}", file=sys.stderr)
    if errors:
        return 1
    print("✓ 仓库检查通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
