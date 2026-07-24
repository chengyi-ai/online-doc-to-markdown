import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Feishu, DingTalk, and WeChat converter", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>文档转 MD｜飞书、钉钉、公众号内容一键转 Markdown<\/title>/i);
  assert.match(html, /飞书 \/ 钉钉 \/ 公众号文章链接/);
  assert.match(html, /支持飞书、钉钉 alidocs、微信公众号网页文章/);
  assert.match(html, /下载 ZIP/);
  assert.match(html, /不保存文档内容/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("keeps all document providers and localized-image ZIP support wired", async () => {
  const [page, layout, worker, wechat] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/wechat.ts", import.meta.url), "utf8"),
  ]);

  assert.match(worker, /FEISHU_HOSTS/);
  assert.match(worker, /DINGTALK_HOSTS/);
  assert.match(worker, /\/api\/document\/data/);
  assert.match(worker, /DINGTALK_IMAGE_PATH/);
  assert.match(worker, /DINGTALK_IMAGE_CDN_ROOTS/);
  assert.match(worker, /hostname\.endsWith\(`\.\$\{root\}`\)/);
  assert.match(worker, /sanitizeDingTalkSourceUrl/);
  assert.match(worker, /key\.toLowerCase\(\) === "authcode"/);
  assert.match(worker, /"A-TOKEN"/);
  assert.match(worker, /isAllowedDingTalkImageHost/);
  assert.match(worker, /extractWeChatDocument/);
  assert.match(worker, /proxyWeChatImage/);
  assert.match(wechat, /isAllowedWeChatDocumentUrl/);
  assert.match(wechat, /mp\.weixin\.qq\.com/);
  assert.match(wechat, /qpic\.cn/);
  assert.match(wechat, /data-src/);
  assert.match(wechat, /renderWeChatArticle/);
  assert.match(wechat, /provider", "wechat"/);

  assert.match(page, /createZip/);
  assert.match(page, /htmlEscapedUrl/);
  assert.match(page, /下载 MD \+ 全部图片 ZIP/);
  assert.match(layout, /飞书、钉钉、公众号内容一键转 Markdown/);
});
