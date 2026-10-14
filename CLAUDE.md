# CLAUDE.md

本仓库是「在线文档转 Markdown」网页应用：粘贴公开可访问的飞书 / Lark（`docx` / `docs` / `wiki`）、钉钉 `alidocs` 文档或微信公众号网页文章链接，转换成 Markdown，保留标题层级、正文和原图，可下载 `.md` 或「Markdown + 全部原图」ZIP。基于 vinext（Next.js 兼容）运行在 Cloudflare Workers 上。

## 目录

- `worker/index.ts`：Worker 入口与接口路由；飞书、钉钉的访客访问、解析、Markdown 渲染和图片代理，主机白名单（`FEISHU_HOSTS`、`DINGTALK_HOSTS`、`DINGTALK_IMAGE_CDN_ROOTS`）也在这里。
- `worker/wechat.ts`：公众号文章解析与图片地址校验。
- `app/`：前端页面（`app/page.tsx` 负责输入、预览、`.md` 与 ZIP 下载）和布局；`app/chatgpt-auth.ts` 是托管平台模板自带的登录辅助，目前未使用。
- `db/`、`drizzle/`、`examples/d1/`：托管平台模板自带的 D1 / Drizzle 脚手架，本项目目前不使用数据库。
- `build/sites-vite-plugin.ts`、`vite.config.ts`、`.openai/hosting.json`：构建与部署绑定。
- `tests/rendered-html.test.mjs`：`node:test` 测试（`npm test` 先构建再运行）；`tests/test_agent_workflow.py`：反馈工作流脚本与仓库检查的 `unittest` 测试。
- `tools/`：维护用脚本（`validate_repo.py` 仓库检查、`submit_feedback.py` 登记反馈）。
- `.github/`：CI 与 Agent 工作流，见 `docs/agent-workflow.md`。

## 不可违背的原则

- 只转换未登录也能打开的公开文档：不绕过登录、权限、分享范围、付费墙或反爬限制；不接收、伪造或转发用户的 Cookie、账号或 Token。遇到登录页要明确提示，而不是想办法绕过。
- 只请求白名单内的主机，跳转同样要校验；接口不能变成任意 URL 代理。
- 不在服务端保存、记录或转发文档内容，不把内容发给第三方服务；链接里的 `authcode` / `code` 等敏感参数不能出现在输出和日志里。
- 转换忠实于原文：不改写、摘要、增删正文。

## 开发约定

- Node.js `>=22.13.0`，依赖用 `npm ci` 按 `package-lock.json` 安装；改依赖要同时提交锁文件。
- Python 3.10+ 只用于 `tools/` 与 `.github/scripts/`，只依赖标准库。
- 提交前必须通过：

  ```bash
  npm run lint
  npm test
  python tools/validate_repo.py
  python -m unittest discover -s tests
  ```

- 行为改动配测试。测试不能访问外网：解析逻辑用本地构造的 HTML / JSON 片段验证；新的 `tests/*.test.mjs` 要加进 `package.json` 的 `test` 脚本（`validate_repo.py` 会检查）。
- 用户可见变化（支持的平台或链接类型、下载格式、提示文案）同步 `README.md`。
- 不要提交 `.env*`、私钥或任何 Token；issue、PR 和测试里不要出现真实的私有文档链接或内容。
- 提交信息使用 `fix:` / `feat:` / `docs:` / `test:` / `ci:` 前缀，简体中文描述。
