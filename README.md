# 在线文档转 Markdown

将公开可访问的飞书、钉钉在线文档与微信公众号网页文章转换为 Markdown，同时识别标题层级、正文和原图。

## 主要功能

- 支持飞书 `docx` / `docs` / `wiki` 公开链接
- 支持钉钉 `alidocs` 公开链接
- 支持 `mp.weixin.qq.com` 公众号网页文章
- 下载纯 Markdown 文件
- 下载“Markdown + 全部原图” ZIP
- 自动将 ZIP 内的图片链接替换为本地相对路径

## 在线使用

[https://feishu-md-quick.yzbandy.chatgpt.site](https://feishu-md-quick.yzbandy.chatgpt.site)

## 本地运行

需要 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
```

## 验证

```bash
npm test
npm run lint
python tools/validate_repo.py
python -m unittest discover -s tests
```

后两条是仓库检查和反馈工作流脚本的测试，只需要 Python 3.10+，不用装额外依赖。

## 部署

项目基于 vinext 和 Cloudflare Workers 运行，`.openai/hosting.json` 保留了现有 Sites 项目绑定。GitHub Pages 只能托管静态页面，不能单独运行本项目的文档解析接口。

## 反馈

遇到转换失败或有想法，直接[提 issue](https://github.com/chengyi-ai/online-doc-to-markdown/issues/new/choose)。issue 是公开的，请不要贴私有文档的链接或内容；需要示例时，新建一个只含测试内容的公开文档来复现。

提交后 Agent 会自动读代码评估可行性，在 issue 下回复结论和实现思路；维护者确认后由 Agent 写代码、跑测试、提 PR，合并前一定有人审。社媒、群聊里的反馈也能登记进来，整套流程和配置见 [docs/agent-workflow.md](docs/agent-workflow.md)。
