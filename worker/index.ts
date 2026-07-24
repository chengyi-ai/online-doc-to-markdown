/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  isAllowedWeChatDocumentUrl,
  isAllowedWeChatHost,
  isAllowedWeChatImageUrl,
  renderWeChatArticle,
  WeChatContentError,
} from "./wechat";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const FEISHU_HOSTS = ["feishu.cn", "larksuite.com"];
const FEISHU_PATHS = ["/docx/", "/docs/", "/wiki/"];
const DINGTALK_HOSTS = ["alidocs.dingtalk.com"];
const DINGTALK_PATHS = ["/i/nodes/", "/i/team/", "/note/"];
const DINGTALK_IMAGE_CDN_ROOTS = ["dingtalk.com", "dingtalk.cn", "aliyuncs.com", "alicdn.com"];
const WECHAT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 MicroMessenger/8.0";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,120}$/;
const DINGTALK_IMAGE_PATH = /^\/core\/api\/resources\/img\/[A-Za-z0-9_-]{40,1024}$/;
const dingTalkAccessCache = new Map<string, { token: string; cookieHeader: string; expiresAt: number }>();
const dingTalkAccessRequests = new Map<string, Promise<{ token: string; cookieHeader: string }>>();

type BlockText = {
  initialAttributedTexts?: {
    text?: Record<string, string> | null;
  } | null;
};

type ClientBlock = {
  id?: string;
  data?: {
    type?: string;
    parent_id?: string;
    children?: string[];
    text?: BlockText;
    seq?: string | number;
    checked?: boolean;
    done?: boolean;
    language?: string;
    code?: { language?: string };
    image?: {
      token?: string;
      mimeType?: string;
      name?: string;
      caption?: { text?: BlockText };
    };
    file?: { token?: string; name?: string };
  };
};

type ClientVars = {
  data?: {
    block_map?: Record<string, ClientBlock>;
    block_sequence?: string[];
    id?: string;
    meta_map?: Record<string, { title?: string }>;
  };
};

class ExtractionError extends Error {
  code: string;
  status: number;
  help?: string;

  constructor(code: string, message: string, status = 502, help?: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.help = help;
  }
}

function json(payload: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(payload), { ...init, headers });
}

function isAllowedFeishuDocumentUrl(value: string) {
  try {
    const parsed = new URL(value);
    const allowedHost =
      parsed.protocol === "https:" &&
      FEISHU_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
    return allowedHost && FEISHU_PATHS.some((path) => parsed.pathname.includes(path));
  } catch {
    return false;
  }
}

function isAllowedFeishuHost(hostname: string) {
  return FEISHU_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function isAllowedDingTalkDocumentUrl(value: string) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      DINGTALK_HOSTS.includes(parsed.hostname) &&
      DINGTALK_PATHS.some((path) => parsed.pathname.includes(path))
    );
  } catch {
    return false;
  }
}

function isAllowedDingTalkHost(hostname: string) {
  return DINGTALK_HOSTS.includes(hostname);
}

function isAllowedDingTalkImageHost(hostname: string) {
  return DINGTALK_IMAGE_CDN_ROOTS.some((root) => hostname === root || hostname.endsWith(`.${root}`));
}

function sanitizeDingTalkSourceUrl(value: string) {
  const parsed = new URL(value);
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase() === "code" || key.toLowerCase() === "authcode") {
      parsed.searchParams.delete(key);
    }
  }
  return parsed.toString();
}

function getSetCookieValues(headers: Headers) {
  const cookieHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof cookieHeaders.getSetCookie === "function") return cookieHeaders.getSetCookie();
  const combined = headers.get("set-cookie");
  return combined ? combined.split(/,(?=\s*[^;,\s]+=)/g) : [];
}

function updateCookies(cookies: Map<string, string>, headers: Headers) {
  for (const value of getSetCookieValues(headers)) {
    const pair = value.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const cookieValue = pair.slice(separator + 1).trim();
    if (/max-age=0/i.test(value)) cookies.delete(name);
    else cookies.set(name, cookieValue);
  }
}

function serializeCookies(cookies: Map<string, string>) {
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function fetchGuestPage(
  sourceUrl: string,
  isAllowedHost: (hostname: string) => boolean,
  providerName: string,
  extraHeaders: Record<string, string> = {},
) {
  const cookies = new Map<string, string>();
  const signal = AbortSignal.timeout(50_000);
  let currentUrl = sourceUrl;
  let response: Response | null = null;

  for (let step = 0; step < 12; step += 1) {
    const cookieHeader = serializeCookies(cookies);
    response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
        ...extraHeaders,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      signal,
    });
    updateCookies(cookies, response.headers);

    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) break;
    const nextUrl = new URL(location, currentUrl);
    if (!isAllowedHost(nextUrl.hostname)) {
      throw new ExtractionError("UNSAFE_REDIRECT", `${providerName}返回了无法验证的跳转地址。`, 502);
    }
    currentUrl = nextUrl.toString();
  }

  if (!response) throw new ExtractionError("NO_RESPONSE", `没有收到${providerName}的响应。`, 502);
  return { response, cookies, cookieHeader: serializeCookies(cookies), finalUrl: currentUrl };
}

function fetchWithGuestSession(sourceUrl: string) {
  return fetchGuestPage(sourceUrl, isAllowedFeishuHost, "飞书");
}

function fetchDingTalkGuestSession(sourceUrl: string) {
  return fetchGuestPage(sourceUrl, isAllowedDingTalkHost, "钉钉文档");
}

function fetchWeChatGuestSession(sourceUrl: string) {
  return fetchGuestPage(sourceUrl, isAllowedWeChatHost, "微信公众号", {
    "User-Agent": WECHAT_USER_AGENT,
  });
}

function parseJsonObjectAt(input: string, start: number) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < input.length; index += 1) {
    const character = input[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(input.slice(start, index + 1)) as ClientVars;
    }
  }
  throw new ExtractionError("PARSE_ERROR", "文档已经可以匿名打开，但没有识别出完整的正文数据。", 422);
}

function extractClientVars(html: string) {
  const marker = /clientVars:\s*Object\(/g.exec(html);
  if (!marker) {
    const isLoginPage = /Log In With QR Code|登录飞书|扫码登录|accounts\/page\/login/i.test(html);
    if (isLoginPage) {
      throw new ExtractionError(
        "NOT_PUBLIC",
        "飞书仍然要求登录，当前链接还不能匿名读取。",
        403,
        "请在分享设置中选择“互联网上获得链接的任何人可阅读/编辑”。如果这是知识库页面，还要确认知识库本身允许对外分享。",
      );
    }
    throw new ExtractionError("PARSE_ERROR", "文档已打开，但暂时不支持这种飞书页面结构。", 422);
  }
  const objectStart = html.indexOf("{", marker.index + marker[0].length);
  if (objectStart < 0) throw new ExtractionError("PARSE_ERROR", "没有找到文档正文数据。", 422);
  return parseJsonObjectAt(html, objectStart);
}

function getBlockText(text?: BlockText | null) {
  const fragments = text?.initialAttributedTexts?.text;
  if (!fragments) return "";
  return Object.entries(fragments)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, value]) => value || "")
    .join("")
    .trimEnd();
}

function getListDepth(blockId: string, blockMap: Record<string, ClientBlock>, documentId: string) {
  let depth = 0;
  let parentId = blockMap[blockId]?.data?.parent_id;
  const visited = new Set<string>();
  while (parentId && parentId !== documentId && !visited.has(parentId) && depth < 8) {
    visited.add(parentId);
    const parentType = blockMap[parentId]?.data?.type;
    if (parentType === "bullet" || parentType === "ordered" || parentType === "todo") depth += 1;
    parentId = blockMap[parentId]?.data?.parent_id;
  }
  return depth;
}

function hasQuotedParent(blockId: string, blockMap: Record<string, ClientBlock>, documentId: string) {
  let parentId = blockMap[blockId]?.data?.parent_id;
  const visited = new Set<string>();
  while (parentId && parentId !== documentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parentType = blockMap[parentId]?.data?.type;
    if (parentType === "callout" || parentType === "quote_container") return true;
    parentId = blockMap[parentId]?.data?.parent_id;
  }
  return false;
}

function escapeAltText(value: string) {
  return value.replace(/[\[\]\n\r]/g, " ").trim() || "文档图片";
}

function renderDocument(clientVars: ClientVars, sourceUrl: string, requestOrigin: string) {
  const data = clientVars.data;
  const blockMap = data?.block_map;
  const blockSequence = data?.block_sequence;
  const documentId = data?.id || "";
  if (!blockMap || !blockSequence?.length || !documentId) {
    throw new ExtractionError("EMPTY_DOCUMENT", "文档可以匿名打开，但没有找到可导出的正文。", 422);
  }

  const pageBlock = blockMap[documentId];
  const title = (
    data?.meta_map?.[documentId]?.title ||
    getBlockText(pageBlock?.data?.text) ||
    "飞书文档"
  ).trim();
  const lines: string[] = [`# ${title}`, ""];
  const imageUrls: string[] = [];
  const images: Array<{ url: string; name: string; mimeType: string }> = [];
  const plainText: string[] = [title];
  let headingCount = 0;

  for (const blockId of blockSequence) {
    if (blockId === documentId) continue;
    const block = blockMap[blockId];
    const blockData = block?.data;
    const type = blockData?.type || "";
    const text = getBlockText(blockData?.text);
    const quoted = hasQuotedParent(blockId, blockMap, documentId);
    const quotePrefix = quoted ? "> " : "";
    let rendered = "";

    if (/^heading[1-6]$/.test(type) && text) {
      const level = Math.min(Number(type.slice(-1)) + 1, 6);
      rendered = `${"#".repeat(level)} ${text}`;
      headingCount += 1;
    } else if (type === "bullet" && text) {
      rendered = `${"  ".repeat(getListDepth(blockId, blockMap, documentId))}- ${text}`;
    } else if (type === "ordered" && text) {
      rendered = `${"  ".repeat(getListDepth(blockId, blockMap, documentId))}1. ${text}`;
    } else if ((type === "todo" || type === "task") && text) {
      rendered = `${"  ".repeat(getListDepth(blockId, blockMap, documentId))}- [${blockData?.checked || blockData?.done ? "x" : " "}] ${text}`;
    } else if ((type === "quote" || type === "quote_text") && text) {
      rendered = `> ${text.replace(/\n/g, "\n> ")}`;
    } else if (type === "code" && text) {
      const language = blockData?.code?.language || blockData?.language || "";
      rendered = `\`\`\`${language}\n${text}\n\`\`\``;
    } else if (type === "divider") {
      rendered = "---";
    } else if (type === "image" && blockData?.image?.token) {
      const token = blockData.image.token;
      const caption = getBlockText(blockData.image.caption?.text);
      const alt = escapeAltText(caption || blockData.image.name || "文档图片");
      const imageUrl = new URL("/api/image", requestOrigin);
      imageUrl.searchParams.set("url", sourceUrl);
      imageUrl.searchParams.set("token", token);
      imageUrl.searchParams.set("docToken", documentId);
      imageUrls.push(imageUrl.toString());
      images.push({
        url: imageUrl.toString(),
        name: blockData.image.name || `image-${String(images.length + 1).padStart(3, "0")}`,
        mimeType: blockData.image.mimeType || "application/octet-stream",
      });
      rendered = `![${alt}](${imageUrl.toString()})`;
    } else if (type === "file" && blockData?.file?.token) {
      rendered = `[附件：${blockData.file.name || "未命名文件"}](feishu://file/${blockData.file.token})`;
    } else if (text) {
      rendered = text;
    }

    if (!rendered) continue;
    if (text) plainText.push(text);
    if (quotePrefix && !rendered.startsWith("> ")) rendered = `${quotePrefix}${rendered.replace(/\n/g, "\n> ")}`;
    lines.push(rendered, "");
  }

  const markdown = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (markdown.length < title.length + 4) {
    throw new ExtractionError("EMPTY_DOCUMENT", "文档中没有识别到可导出的正文。", 422);
  }

  return {
    title,
    markdown,
    sourceUrl,
    imageUrls,
    images,
    stats: {
      characters: plainText.join("").replace(/\s/g, "").length,
      images: imageUrls.length,
      headings: headingCount,
    },
  };
}

type JsonObject = Record<string, unknown>;
type DingTalkNode = unknown[];

type DingTalkMeta = {
  docKey: string;
  dentryKey: string;
  title: string;
};

type DingTalkRenderContext = DingTalkMeta & {
  sourceUrl: string;
  requestOrigin: string;
  imageUrls: string[];
  images: Array<{ url: string; name: string; mimeType: string }>;
  headingCount: number;
};

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function isDingTalkNode(value: unknown): value is DingTalkNode {
  return Array.isArray(value) && typeof value[0] === "string";
}

function dingTalkNodeType(node: DingTalkNode) {
  return String(node[0] || "").toLowerCase();
}

function dingTalkNodeAttrs(node: DingTalkNode) {
  return asObject(node[1]) || {};
}

function dingTalkNodeChildren(node: DingTalkNode) {
  return node.slice(2);
}

function cleanDingTalkText(value: string) {
  return value.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").replace(/\r\n?/g, "\n");
}

function dingTalkPlainText(value: unknown): string {
  if (typeof value === "string") return cleanDingTalkText(value);
  if (!isDingTalkNode(value)) return "";
  return dingTalkNodeChildren(value).map(dingTalkPlainText).join("");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeHttpLink(value: unknown) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function dingTalkImageMimeType(attrs: JsonObject) {
  const extraData = asObject(attrs.extraData);
  const metaData = asObject(extraData?.metaData);
  const format = typeof metaData?.format === "string" ? metaData.format.toLowerCase() : "";
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    heic: "image/heic",
    heif: "image/heif",
  };
  return mimeTypes[format] || "application/octet-stream";
}

function registerDingTalkImage(attrs: JsonObject, context: DingTalkRenderContext) {
  const src = typeof attrs.src === "string" ? attrs.src : "";
  if (!DINGTALK_IMAGE_PATH.test(src)) return null;

  const imageUrl = new URL("/api/image", context.requestOrigin);
  imageUrl.searchParams.set("provider", "dingtalk");
  imageUrl.searchParams.set("url", context.sourceUrl);
  imageUrl.searchParams.set("src", src);
  imageUrl.searchParams.set("docKey", context.docKey);
  imageUrl.searchParams.set("dentryKey", context.dentryKey);
  const proxiedUrl = imageUrl.toString();
  const name = typeof attrs.name === "string" && attrs.name.trim()
    ? attrs.name.trim()
    : `image-${String(context.images.length + 1).padStart(3, "0")}`;
  const mimeType = dingTalkImageMimeType(attrs);
  context.imageUrls.push(proxiedUrl);
  context.images.push({ url: proxiedUrl, name, mimeType });
  return { url: proxiedUrl, name };
}

function renderDingTalkInline(value: unknown, context: DingTalkRenderContext): string {
  if (typeof value === "string") return cleanDingTalkText(value);
  if (!isDingTalkNode(value)) return "";

  const type = dingTalkNodeType(value);
  const attrs = dingTalkNodeAttrs(value);
  if (type === "br") return "  \n";
  if (type === "img") {
    const image = registerDingTalkImage(attrs, context);
    return image ? `![${escapeAltText(image.name)}](${image.url})` : "";
  }

  let content = dingTalkNodeChildren(value).map((child) => renderDingTalkInline(child, context)).join("");
  if (type === "a") {
    const href = safeHttpLink(attrs.href);
    const label = content.trim() || href;
    return href ? `[${label.replace(/\]/g, "\\]")}](${href})` : label;
  }
  if (type === "span" && content) {
    if (attrs.bold === true) content = `**${content}**`;
    if (attrs.italic === true) content = `*${content}*`;
    if (attrs.strike === true || attrs.strikethrough === true) content = `~~${content}~~`;
  }
  return content;
}

function renderDingTalkHtmlInline(value: unknown, context: DingTalkRenderContext): string {
  if (typeof value === "string") return escapeHtml(cleanDingTalkText(value));
  if (!isDingTalkNode(value)) return "";

  const type = dingTalkNodeType(value);
  const attrs = dingTalkNodeAttrs(value);
  if (type === "br") return "<br>";
  if (type === "img") {
    const image = registerDingTalkImage(attrs, context);
    return image ? `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name)}">` : "";
  }

  let content = dingTalkNodeChildren(value).map((child) => renderDingTalkHtmlInline(child, context)).join("");
  if (type === "a") {
    const href = safeHttpLink(attrs.href);
    return href ? `<a href="${escapeHtml(href)}">${content || escapeHtml(href)}</a>` : content;
  }
  if (type === "span") {
    if (attrs.bold === true) content = `<strong>${content}</strong>`;
    if (attrs.italic === true) content = `<em>${content}</em>`;
    if (attrs.strike === true || attrs.strikethrough === true) content = `<s>${content}</s>`;
  }
  return content;
}

function dingTalkListPrefix(attrs: JsonObject) {
  const list = asObject(attrs.list);
  if (!list) return "";
  const level = typeof list.level === "number" ? Math.max(0, Math.min(8, list.level)) : 0;
  const indent = "  ".repeat(level);
  if (list.isTaskList === true) return `${indent}- [${list.isChecked === true ? "x" : " "}] `;
  if (list.isOrdered === true) return `${indent}1. `;
  return `${indent}- `;
}

function renderDingTalkTableCell(node: DingTalkNode, context: DingTalkRenderContext) {
  const parts: string[] = [];
  for (const child of dingTalkNodeChildren(node)) {
    if (!isDingTalkNode(child)) {
      if (typeof child === "string") parts.push(escapeHtml(cleanDingTalkText(child)));
      continue;
    }
    const type = dingTalkNodeType(child);
    if (type === "table") parts.push(renderDingTalkTable(child, context));
    else if (type === "p" || /^h[1-6]$/.test(type)) {
      if (/^h[1-6]$/.test(type)) context.headingCount += 1;
      const attrs = dingTalkNodeAttrs(child);
      const content = dingTalkNodeChildren(child).map((item) => renderDingTalkHtmlInline(item, context)).join("");
      const prefix = dingTalkListPrefix(attrs);
      parts.push(`${prefix ? escapeHtml(prefix) : ""}${content}`);
    } else parts.push(renderDingTalkHtmlInline(child, context));
  }
  return parts.filter(Boolean).join("<br>");
}

function renderDingTalkTable(node: DingTalkNode, context: DingTalkRenderContext) {
  const rows: string[] = [];
  for (const row of dingTalkNodeChildren(node)) {
    if (!isDingTalkNode(row) || dingTalkNodeType(row) !== "tr") continue;
    const cells: string[] = [];
    for (const cell of dingTalkNodeChildren(row)) {
      if (!isDingTalkNode(cell) || dingTalkNodeType(cell) !== "tc") continue;
      const attrs = dingTalkNodeAttrs(cell);
      const rowSpan = typeof attrs.rowSpan === "number" && attrs.rowSpan > 1 ? ` rowspan="${attrs.rowSpan}"` : "";
      const colSpan = typeof attrs.colSpan === "number" && attrs.colSpan > 1 ? ` colspan="${attrs.colSpan}"` : "";
      cells.push(`<td${rowSpan}${colSpan}>${renderDingTalkTableCell(cell, context)}</td>`);
    }
    if (cells.length) rows.push(`<tr>${cells.join("")}</tr>`);
  }
  return rows.length ? `<table>\n<tbody>\n${rows.join("\n")}\n</tbody>\n</table>` : "";
}

function renderDingTalkBlock(value: unknown, context: DingTalkRenderContext): string {
  if (typeof value === "string") return cleanDingTalkText(value).trim();
  if (!isDingTalkNode(value)) return "";

  const type = dingTalkNodeType(value);
  const attrs = dingTalkNodeAttrs(value);
  const children = dingTalkNodeChildren(value);
  if (type === "root") return children.map((child) => renderDingTalkBlock(child, context)).filter(Boolean).join("\n\n");
  if (/^h[1-6]$/.test(type)) {
    const level = Math.min(Number(type.slice(1)) + 1, 6);
    const content = children.map((child) => renderDingTalkInline(child, context)).join("").trim();
    if (!content) return "";
    context.headingCount += 1;
    return `${"#".repeat(level)} ${content}`;
  }
  if (type === "p") {
    const content = children.map((child) => renderDingTalkInline(child, context)).join("").trimEnd();
    return content ? `${dingTalkListPrefix(attrs)}${content}` : "";
  }
  if (type === "table") return renderDingTalkTable(value, context);
  if (type === "img") return renderDingTalkInline(value, context);
  if (type === "hr" || type === "divider") return "---";
  if (type === "blockquote" || type === "quote") {
    const content = children.map((child) => renderDingTalkBlock(child, context)).filter(Boolean).join("\n");
    return content ? `> ${content.replace(/\n/g, "\n> ")}` : "";
  }
  if (type === "pre" || type === "code") {
    const content = dingTalkPlainText(value).trimEnd();
    return content ? `\`\`\`\n${content}\n\`\`\`` : "";
  }

  const blockContent = children.map((child) => renderDingTalkBlock(child, context)).filter(Boolean);
  if (blockContent.length) return blockContent.join("\n\n");
  return renderDingTalkInline(value, context);
}

function extractDingTalkMeta(html: string): DingTalkMeta {
  const match = html.match(/<script[^>]*id=["']mainsite_server_content["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) {
    const loginRequired = /扫码登录|登录钉钉|login|sign in/i.test(html);
    throw new ExtractionError(
      loginRequired ? "NOT_PUBLIC" : "PARSE_ERROR",
      loginRequired ? "钉钉仍然要求登录，当前链接还不能匿名读取。" : "文档已打开，但暂时不支持这种钉钉页面结构。",
      loginRequired ? 403 : 422,
      loginRequired ? "请将链接分享范围设为“获得链接的人可查看/编辑”，并允许组织外访问。" : undefined,
    );
  }

  let payload: JsonObject;
  try {
    payload = JSON.parse(match[1].trim()) as JsonObject;
  } catch {
    throw new ExtractionError("PARSE_ERROR", "钉钉文档的页面信息无法解析。", 422);
  }
  const dentryInfo = asObject(asObject(payload.dentryInfo)?.data);
  const docKey = typeof dentryInfo?.docKey === "string" ? dentryInfo.docKey : "";
  const dentryKey = typeof dentryInfo?.dentryKey === "string" ? dentryInfo.dentryKey : "";
  const rawName = typeof dentryInfo?.name === "string" ? dentryInfo.name : "钉钉文档";
  if (!TOKEN_PATTERN.test(docKey) || !TOKEN_PATTERN.test(dentryKey)) {
    throw new ExtractionError(
      "NOT_PUBLIC",
      "没有取得钉钉文档的公开读取凭证。",
      403,
      "请将链接分享范围设为“获得链接的人可查看/编辑”，并允许组织外访问。",
    );
  }
  return { docKey, dentryKey, title: rawName.replace(/\.adoc$/i, "").trim() || "钉钉文档" };
}

function dingTalkAccessCacheKey(meta: Pick<DingTalkMeta, "docKey" | "dentryKey">) {
  return `${meta.docKey}:${meta.dentryKey}`;
}

function rememberDingTalkAccess(
  meta: Pick<DingTalkMeta, "docKey" | "dentryKey">,
  token: string,
  cookieHeader: string,
) {
  if (!token || token.length > 4096) return;
  if (dingTalkAccessCache.size >= 100) {
    const firstKey = dingTalkAccessCache.keys().next().value;
    if (typeof firstKey === "string") dingTalkAccessCache.delete(firstKey);
  }
  dingTalkAccessCache.set(dingTalkAccessCacheKey(meta), {
    token,
    cookieHeader,
    expiresAt: Date.now() + 5 * 60_000,
  });
}

async function getDingTalkAccess(
  sourceUrl: string,
  expectedMeta: Pick<DingTalkMeta, "docKey" | "dentryKey">,
) {
  const cacheKey = dingTalkAccessCacheKey(expectedMeta);
  const cached = dingTalkAccessCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { token: cached.token, cookieHeader: cached.cookieHeader };
  if (cached) dingTalkAccessCache.delete(cacheKey);

  const pending = dingTalkAccessRequests.get(cacheKey);
  if (pending) return pending;
  const request = (async () => {
    const guest = await fetchDingTalkGuestSession(sourceUrl);
    if (!guest.response.ok) throw new ExtractionError("NOT_PUBLIC", "当前钉钉文档不允许匿名读取。", 403);
    const html = await guest.response.text();
    const actualMeta = extractDingTalkMeta(html);
    if (actualMeta.docKey !== expectedMeta.docKey || actualMeta.dentryKey !== expectedMeta.dentryKey) {
      throw new ExtractionError("INVALID_IMAGE_DOCUMENT", "图片与文档信息不匹配。", 400);
    }
    const cookieHeader = serializeCookies(guest.cookies);
    const source = new URL(guest.finalUrl);
    const response = await fetch(new URL("/api/document/data", source.origin), {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "A-DENTRY-KEY": expectedMeta.dentryKey,
        "A-DOC-KEY": expectedMeta.docKey,
        SOURCE_DOC_APP: "doc",
        Referer: sourceUrl,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      body: JSON.stringify({ fetchBody: false }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new ExtractionError("DINGTALK_IMAGE_AUTH", "没有取得钉钉图片读取凭证。", 502);
    const payload = asObject(await response.json());
    const data = asObject(payload?.data);
    const token = typeof data?.accessToken === "string" ? data.accessToken : "";
    if (payload?.status !== 200 || payload?.isSuccess !== true || !token) {
      throw new ExtractionError("DINGTALK_IMAGE_AUTH", "没有取得钉钉图片读取凭证。", 502);
    }
    rememberDingTalkAccess(expectedMeta, token, cookieHeader);
    return { token, cookieHeader };
  })();
  dingTalkAccessRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    dingTalkAccessRequests.delete(cacheKey);
  }
}

async function extractFeishuDocument(sourceUrl: string, requestOrigin: string) {
  const { response } = await fetchWithGuestSession(sourceUrl);
  if (response.status === 429) {
    throw new ExtractionError("FEISHU_RATE_LIMIT", "飞书暂时限制了访问频率，请过一会儿再试。", 429);
  }
  if (response.status === 401 || response.status === 403) {
    throw new ExtractionError(
      "NOT_PUBLIC",
      "飞书仍然要求登录，当前链接还不能匿名读取。",
      403,
      "请确认是“互联网上获得链接的任何人”，而不只是“组织内所有人”。",
    );
  }
  if (!response.ok) throw new ExtractionError("FEISHU_ERROR", `飞书返回了 ${response.status}，请稍后重试。`, 502);

  const html = await response.text();
  if (html.length > 12_000_000) throw new ExtractionError("DOCUMENT_TOO_LARGE", "文档内容过大，暂时无法在网页中完成转换。", 413);
  return renderDocument(extractClientVars(html), sourceUrl, requestOrigin);
}

async function extractDingTalkDocument(sourceUrl: string, requestOrigin: string) {
  const guest = await fetchDingTalkGuestSession(sourceUrl);
  if (guest.response.status === 429) {
    throw new ExtractionError("DINGTALK_RATE_LIMIT", "钉钉文档暂时限制了访问频率，请过一会儿再试。", 429);
  }
  if (guest.response.status === 401 || guest.response.status === 403) {
    throw new ExtractionError(
      "NOT_PUBLIC",
      "钉钉仍然要求登录，当前链接还不能匿名读取。",
      403,
      "请将链接分享范围设为“获得链接的人可查看/编辑”，并允许组织外访问。",
    );
  }
  if (!guest.response.ok) throw new ExtractionError("DINGTALK_ERROR", `钉钉文档返回了 ${guest.response.status}，请稍后重试。`, 502);

  const html = await guest.response.text();
  if (html.length > 4_000_000) throw new ExtractionError("DOCUMENT_TOO_LARGE", "文档页面过大，暂时无法完成转换。", 413);
  const meta = extractDingTalkMeta(html);
  const source = new URL(guest.finalUrl);
  const cookieHeader = serializeCookies(guest.cookies);
  const dataResponse = await fetch(new URL("/api/document/data", source.origin), {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
      "Content-Type": "application/json",
      "A-DENTRY-KEY": meta.dentryKey,
      "A-DOC-KEY": meta.docKey,
      SOURCE_DOC_APP: "doc",
      "color-theme": "light",
      Referer: sourceUrl,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: JSON.stringify({ fetchBody: true }),
    signal: AbortSignal.timeout(50_000),
  });
  updateCookies(guest.cookies, dataResponse.headers);
  if (dataResponse.status === 429) throw new ExtractionError("DINGTALK_RATE_LIMIT", "钉钉文档暂时限制了访问频率，请过一会儿再试。", 429);
  if (dataResponse.status === 401 || dataResponse.status === 403) {
    throw new ExtractionError("NOT_PUBLIC", "当前钉钉文档不允许匿名读取。", 403, "请确认链接允许组织外访客查看。 ");
  }
  if (!dataResponse.ok) throw new ExtractionError("DINGTALK_ERROR", `钉钉文档正文接口返回了 ${dataResponse.status}。`, 502);

  const payload = asObject(await dataResponse.json());
  const data = asObject(payload?.data);
  const documentContent = asObject(data?.documentContent);
  const checkpoint = asObject(documentContent?.checkpoint);
  const checkpointContent = typeof checkpoint?.content === "string" ? checkpoint.content : "";
  if (payload?.status !== 200 || payload?.isSuccess !== true || !checkpointContent) {
    throw new ExtractionError("EMPTY_DOCUMENT", "钉钉文档可以打开，但没有取得可导出的正文。", 422);
  }
  const accessToken = typeof data?.accessToken === "string" ? data.accessToken : "";
  rememberDingTalkAccess(meta, accessToken, serializeCookies(guest.cookies));
  if (checkpointContent.length > 12_000_000) {
    throw new ExtractionError("DOCUMENT_TOO_LARGE", "文档内容过大，暂时无法在网页中完成转换。", 413);
  }

  let packageData: JsonObject;
  try {
    packageData = JSON.parse(checkpointContent) as JsonObject;
  } catch {
    throw new ExtractionError("PARSE_ERROR", "钉钉文档正文无法解析。", 422);
  }
  const mainPart = typeof packageData.main === "string" ? packageData.main : "";
  const parts = asObject(packageData.parts);
  const part = asObject(parts?.[mainPart]);
  const partData = asObject(part?.data);
  const root = partData?.body;
  if (!isDingTalkNode(root) || dingTalkNodeType(root) !== "root") {
    throw new ExtractionError("EMPTY_DOCUMENT", "钉钉文档中没有识别到可导出的正文。", 422);
  }

  const context: DingTalkRenderContext = {
    ...meta,
    sourceUrl,
    requestOrigin,
    imageUrls: [],
    images: [],
    headingCount: 0,
  };
  const bodyMarkdown = renderDingTalkBlock(root, context).replace(/\n{3,}/g, "\n\n").trim();
  const markdown = `# ${meta.title}\n\n${bodyMarkdown}`.trim();
  if (!bodyMarkdown) throw new ExtractionError("EMPTY_DOCUMENT", "钉钉文档中没有识别到可导出的正文。", 422);
  return {
    title: meta.title,
    markdown,
    sourceUrl,
    imageUrls: context.imageUrls,
    images: context.images,
    stats: {
      characters: `${meta.title}${dingTalkPlainText(root)}`.replace(/\s/g, "").length,
      images: context.imageUrls.length,
      headings: context.headingCount,
    },
  };
}

async function extractWeChatDocument(sourceUrl: string, requestOrigin: string) {
  const guest = await fetchWeChatGuestSession(sourceUrl);
  if (guest.response.status === 429) {
    throw new ExtractionError(
      "WECHAT_RATE_LIMIT",
      "微信公众号暂时限制了网页读取，请过一会儿再试。",
      429,
      "请确认文章能在无痕窗口中直接打开。",
    );
  }
  if (guest.response.status === 401 || guest.response.status === 403) {
    throw new ExtractionError(
      "NOT_PUBLIC",
      "当前公众号文章不允许匿名读取。",
      403,
      "请使用已公开发布、能在浏览器中直接打开的公众号文章链接。",
    );
  }
  if (!guest.response.ok) {
    throw new ExtractionError("WECHAT_ERROR", `微信公众号返回了 ${guest.response.status}，请稍后重试。`, 502);
  }

  const html = await guest.response.text();
  if (html.length > 12_000_000) {
    throw new ExtractionError("DOCUMENT_TOO_LARGE", "公众号文章内容过大，暂时无法在网页中完成转换。", 413);
  }
  try {
    return renderWeChatArticle(html, sourceUrl, requestOrigin);
  } catch (error) {
    if (error instanceof WeChatContentError) {
      throw new ExtractionError(error.code, error.message, error.status, error.help);
    }
    throw error;
  }
}

async function extractDocument(request: Request) {
  if (request.method !== "POST") {
    return json({ error: "仅支持 POST 请求。" }, { status: 405, headers: { Allow: "POST" } });
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > 4096) return json({ error: "请求内容过大。" }, { status: 413 });

  let body: { url?: unknown };
  try {
    body = (await request.json()) as { url?: unknown };
  } catch {
    return json({ error: "链接格式不正确。" }, { status: 400 });
  }

  const submittedUrl = typeof body.url === "string" ? body.url.trim() : "";
  const isFeishu = isAllowedFeishuDocumentUrl(submittedUrl);
  const isDingTalk = isAllowedDingTalkDocumentUrl(submittedUrl);
  const isWeChat = isAllowedWeChatDocumentUrl(submittedUrl);
  if (!isFeishu && !isDingTalk && !isWeChat) {
    return json(
      { error: "请粘贴有效的飞书、钉钉，或微信公众号文章链接。" },
      { status: 400 },
    );
  }

  try {
    const requestOrigin = new URL(request.url).origin;
    const sourceUrl = isDingTalk ? sanitizeDingTalkSourceUrl(submittedUrl) : submittedUrl;
    const result = isFeishu
      ? await extractFeishuDocument(sourceUrl, requestOrigin)
      : isDingTalk
        ? await extractDingTalkDocument(sourceUrl, requestOrigin)
        : await extractWeChatDocument(sourceUrl, requestOrigin);
    return json(result);
  } catch (error) {
    if (error instanceof ExtractionError) {
      return json({ error: error.message, code: error.code, help: error.help }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "读取文档时发生未知错误。";
    const timedOut = /timeout|aborted/i.test(message);
    return json({ error: timedOut ? "读取超时。文档可能较长，请再试一次。" : message }, { status: 502 });
  }
}

async function proxyFeishuImage(request: Request, sourceUrl: string) {
  const requestUrl = new URL(request.url);
  const token = requestUrl.searchParams.get("token") || "";
  const documentToken = requestUrl.searchParams.get("docToken") || "";
  if (!isAllowedFeishuDocumentUrl(sourceUrl) || !TOKEN_PATTERN.test(token) || !TOKEN_PATTERN.test(documentToken)) {
    return new Response("Invalid image request", { status: 400 });
  }

  try {
    const guest = await fetchWithGuestSession(sourceUrl);
    if (!guest.response.ok) return new Response("Document is not publicly accessible", { status: 403 });

    const source = new URL(sourceUrl);
    const imageUrl = new URL(`/space/api/box/stream/download/all/${token}/`, source.origin);
    imageUrl.searchParams.set("mount_node_token", documentToken);
    imageUrl.searchParams.set("mount_point", "docx_image");
    const imageResponse = await fetch(imageUrl, {
      redirect: "follow",
      headers: {
        Accept: "image/*",
        Cookie: guest.cookieHeader,
        Referer: sourceUrl,
      },
      signal: AbortSignal.timeout(45_000),
    });
    const contentType = imageResponse.headers.get("content-type") || "";
    if (!imageResponse.ok || !contentType.startsWith("image/")) {
      return new Response("Image is unavailable", { status: 404 });
    }
    return new Response(imageResponse.body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return new Response("Image request failed", { status: 502 });
  }
}

async function proxyDingTalkImage(request: Request, sourceUrl: string) {
  const requestUrl = new URL(request.url);
  const src = requestUrl.searchParams.get("src") || "";
  const docKey = requestUrl.searchParams.get("docKey") || "";
  const dentryKey = requestUrl.searchParams.get("dentryKey") || "";
  if (
    !isAllowedDingTalkDocumentUrl(sourceUrl) ||
    !DINGTALK_IMAGE_PATH.test(src) ||
    !TOKEN_PATTERN.test(docKey) ||
    !TOKEN_PATTERN.test(dentryKey)
  ) {
    return new Response("Invalid image request", { status: 400 });
  }

  try {
    const access = await getDingTalkAccess(sourceUrl, { docKey, dentryKey });
    let imageResponse = await fetch(new URL(src, new URL(sourceUrl).origin), {
      redirect: "manual",
      headers: {
        Accept: "image/*",
        "A-DENTRY-KEY": dentryKey,
        "A-DOC-KEY": docKey,
        "A-TOKEN": access.token,
        SOURCE_DOC_APP: "doc",
        ...(access.cookieHeader ? { Cookie: access.cookieHeader } : {}),
        Referer: sourceUrl,
      },
      signal: AbortSignal.timeout(45_000),
    });
    const location = imageResponse.headers.get("location");
    if (location) {
      const cdnUrl = new URL(location, sourceUrl);
      if (
        cdnUrl.protocol !== "https:" ||
        cdnUrl.username !== "" ||
        cdnUrl.password !== "" ||
        cdnUrl.port !== "" ||
        !isAllowedDingTalkImageHost(cdnUrl.hostname)
      ) {
        console.warn("dingtalk-image-redirect-rejected", { hostname: cdnUrl.hostname });
        return new Response("Image redirect is not allowed", { status: 400 });
      }
      imageResponse.body?.cancel();
      imageResponse = await fetch(cdnUrl, {
        headers: { Accept: "image/*" },
        signal: AbortSignal.timeout(45_000),
      });
    }
    const contentType = imageResponse.headers.get("content-type") || "";
    if (!imageResponse.ok || !contentType.startsWith("image/")) {
      return new Response("Image is unavailable", { status: 404 });
    }
    return new Response(imageResponse.body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return new Response("Image request failed", { status: 502 });
  }
}

async function proxyWeChatImage(request: Request, sourceUrl: string) {
  const requestUrl = new URL(request.url);
  const src = requestUrl.searchParams.get("src") || "";
  if (!isAllowedWeChatDocumentUrl(sourceUrl) || !isAllowedWeChatImageUrl(src)) {
    return new Response("Invalid image request", { status: 400 });
  }

  try {
    let currentUrl = src;
    let imageResponse: Response | null = null;
    for (let step = 0; step < 4; step += 1) {
      imageResponse = await fetch(currentUrl, {
        redirect: "manual",
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          Referer: sourceUrl,
          "User-Agent": WECHAT_USER_AGENT,
        },
        signal: AbortSignal.timeout(45_000),
      });
      if (imageResponse.status < 300 || imageResponse.status >= 400) break;
      const location = imageResponse.headers.get("location");
      if (!location) break;
      const nextUrl = new URL(location, currentUrl);
      if (!isAllowedWeChatImageUrl(nextUrl.toString())) {
        imageResponse.body?.cancel();
        return new Response("Image redirect is not allowed", { status: 400 });
      }
      imageResponse.body?.cancel();
      currentUrl = nextUrl.toString();
    }
    const contentType = imageResponse?.headers.get("content-type") || "";
    if (!imageResponse?.ok || !contentType.startsWith("image/")) {
      return new Response("Image is unavailable", { status: 404 });
    }
    return new Response(imageResponse.body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return new Response("Image request failed", { status: 502 });
  }
}

async function proxyDocumentImage(request: Request) {
  const requestUrl = new URL(request.url);
  const sourceUrl = requestUrl.searchParams.get("url") || "";
  if (requestUrl.searchParams.get("provider") === "wechat" || isAllowedWeChatDocumentUrl(sourceUrl)) {
    return proxyWeChatImage(request, sourceUrl);
  }
  if (requestUrl.searchParams.get("provider") === "dingtalk" || isAllowedDingTalkDocumentUrl(sourceUrl)) {
    return proxyDingTalkImage(request, sourceUrl);
  }
  return proxyFeishuImage(request, sourceUrl);
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/extract") {
      return extractDocument(request);
    }

    if (url.pathname === "/api/image") {
      return proxyDocumentImage(request);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
