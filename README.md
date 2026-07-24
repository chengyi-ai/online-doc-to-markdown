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
```

## 部署

项目基于 vinext 和 Cloudflare Workers 运行，`.openai/hosting.json` 保留了现有 Sites 项目绑定。GitHub Pages 只能托管静态页面，不能单独运行本项目的文档解析接口。
