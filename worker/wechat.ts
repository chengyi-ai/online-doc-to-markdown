import { parseDocument } from "htmlparser2";
import { hasChildren, isTag, isText, type AnyNode, type Element } from "domhandler";

const WECHAT_HOSTS = ["mp.weixin.qq.com"];
const WECHAT_IMAGE_CDN_ROOTS = ["qpic.cn", "qlogo.cn"];
const BLOCKED_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "canvas",
  "mp-common-profile",
  "mp-style-type",
]);

export class WeChatContentError extends Error {
  code: string;
  status: number;
  help?: string;

  constructor(code: string, message: string, status = 422, help?: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.help = help;
  }
}

export function isAllowedWeChatDocumentUrl(value: string) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      WECHAT_HOSTS.includes(parsed.hostname) &&
      (parsed.pathname === "/s" || parsed.pathname.startsWith("/s/"))
    );
  } catch {
    return false;
  }
}

export function isAllowedWeChatHost(hostname: string) {
  return WECHAT_HOSTS.includes(hostname);
}

export function isAllowedWeChatImageUrl(value: string) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      WECHAT_IMAGE_CDN_ROOTS.some((root) => parsed.hostname === root || parsed.hostname.endsWith(`.${root}`))
    );
  } catch {
    return false;
  }
}

function findElement(nodes: AnyNode[], predicate: (element: Element) => boolean): Element | null {
  for (const node of nodes) {
    if (isTag(node) && predicate(node)) return node;
    if (hasChildren(node)) {
      const match = findElement(node.children, predicate);
      if (match) return match;
    }
  }
  return null;
}

function findElements(nodes: AnyNode[], predicate: (element: Element) => boolean, matches: Element[] = []) {
  for (const node of nodes) {
    if (isTag(node) && predicate(node)) matches.push(node);
    if (hasChildren(node)) findElements(node.children, predicate, matches);
  }
  return matches;
}

function normalizeText(value: string) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[\t\r\n ]+/g, " ")
    .trim();
}

function plainText(node: AnyNode): string {
  if (isText(node)) return node.data;
  if (!hasChildren(node)) return "";
  if (isTag(node) && BLOCKED_TAGS.has(node.name.toLowerCase())) return "";
  return node.children.map(plainText).join("");
}

function escapeMarkdownText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/([\[\]])/g, "\\$1");
}

function safeHttpLink(value: string) {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function metaContent(root: AnyNode[], property: string) {
  return (
    findElement(root, (element) => {
      if (element.name.toLowerCase() !== "meta") return false;
      return element.attribs.property === property || element.attribs.name === property;
    })?.attribs.content || ""
  );
}

function normalizeWeChatImageUrl(value: string) {
  const normalized = value.startsWith("http://") ? `https://${value.slice("http://".length)}` : value;
  return isAllowedWeChatImageUrl(normalized) ? normalized : "";
}

function weChatImageMimeType(value: string) {
  try {
    const parsed = new URL(value);
    const format = (parsed.searchParams.get("wx_fmt") || "").toLowerCase();
    if (format === "jpg" || format === "jpeg") return "image/jpeg";
    if (format === "png") return "image/png";
    if (format === "gif") return "image/gif";
    if (format === "webp") return "image/webp";
    if (/mmbiz_jpe?g/i.test(parsed.pathname)) return "image/jpeg";
    if (/mmbiz_png/i.test(parsed.pathname)) return "image/png";
    if (/mmbiz_gif/i.test(parsed.pathname)) return "image/gif";
  } catch {
    // The URL is validated before this helper is called.
  }
  return "application/octet-stream";
}

type WeChatRenderContext = {
  sourceUrl: string;
  requestOrigin: string;
  imageUrls: string[];
  images: Array<{ url: string; name: string; mimeType: string }>;
  registeredImages: Map<string, string>;
  headingCount: number;
};

function registerImage(element: Element, context: WeChatRenderContext) {
  const width = Number(element.attribs["data-w"] || element.attribs.width || "0");
  if (width > 0 && width <= 2) return "";
  const source = normalizeWeChatImageUrl(
    element.attribs["data-src"] ||
      element.attribs["data-original"] ||
      element.attribs["data-backsrc"] ||
      element.attribs.src ||
      "",
  );
  if (!source) return "";

  const existing = context.registeredImages.get(source);
  if (existing) return existing;

  const imageUrl = new URL("/api/image", context.requestOrigin);
  imageUrl.searchParams.set("provider", "wechat");
  imageUrl.searchParams.set("url", context.sourceUrl);
  imageUrl.searchParams.set("src", source);
  const proxiedUrl = imageUrl.toString();
  const mimeType = weChatImageMimeType(source);
  const index = context.images.length + 1;
  context.imageUrls.push(proxiedUrl);
  context.images.push({
    url: proxiedUrl,
    name: `wechat-image-${String(index).padStart(3, "0")}`,
    mimeType,
  });
  context.registeredImages.set(source, proxiedUrl);
  return proxiedUrl;
}

function inlineContent(nodes: AnyNode[], context: WeChatRenderContext): string {
  return nodes.map((node) => renderInline(node, context)).join("");
}

function renderInline(node: AnyNode, context: WeChatRenderContext): string {
  if (isText(node)) return escapeMarkdownText(node.data.replace(/\u00a0/g, " "));
  if (!isTag(node)) return hasChildren(node) ? inlineContent(node.children, context) : "";

  const tag = node.name.toLowerCase();
  if (BLOCKED_TAGS.has(tag)) return "";
  if (tag === "br") return "\n";
  if (tag === "img") {
    const url = registerImage(node, context);
    if (!url) return "";
    const alt = normalizeText(node.attribs.alt || node.attribs.title || `公众号图片 ${context.images.length}`)
      .replace(/[\[\]\r\n]/g, " ");
    return `![${alt || "公众号图片"}](${url})`;
  }

  const content = inlineContent(node.children, context);
  if (!content.trim()) return "";
  if (tag === "strong" || tag === "b") return `**${content.trim()}**`;
  if (tag === "em" || tag === "i") return `*${content.trim()}*`;
  if (tag === "del" || tag === "s") return `~~${content.trim()}~~`;
  if (tag === "code") return `\`${content.trim().replace(/`/g, "\\`")}\``;
  if (tag === "a") {
    const href = safeHttpLink(node.attribs.href || "");
    const label = content.trim();
    return href && label ? `[${label}](${href})` : content;
  }
  return content;
}

function styleText(element: Element) {
  const styles: string[] = [element.attribs.style || ""];
  for (const descendant of findElements(element.children, (child) => Boolean(child.attribs.style)).slice(0, 12)) {
    styles.push(descendant.attribs.style || "");
  }
  return styles.join(";");
}

function isStyledHeading(element: Element) {
  if (element.name.toLowerCase() !== "p" && element.name.toLowerCase() !== "section") return false;
  if (findElement(element.children, (child) => child.name.toLowerCase() === "img")) return false;
  const text = normalizeText(plainText(element));
  if (!text || text.length > 60) return false;
  const styles = styleText(element);
  const largeFont =
    /font-size\s*:\s*(?:2[0-9]|[3-9][0-9])px/i.test(styles) ||
    /font-size\s*:\s*(?:1[6-9]|[2-9][0-9])pt/i.test(styles);
  const emphasized = /font-weight\s*:\s*(?:bold|[6-9]00)/i.test(styles);
  return largeFont && emphasized;
}

function directChildren(element: Element, tag: string) {
  return element.children.filter((child): child is Element => isTag(child) && child.name.toLowerCase() === tag);
}

function renderList(element: Element, context: WeChatRenderContext) {
  const ordered = element.name.toLowerCase() === "ol";
  const items = directChildren(element, "li");
  const lines: string[] = [];

  for (const item of items) {
    const inlineNodes = item.children.filter(
      (child) => !isTag(child) || (child.name.toLowerCase() !== "ul" && child.name.toLowerCase() !== "ol"),
    );
    const content = normalizeText(inlineContent(inlineNodes, context).replace(/\n+/g, " "));
    if (content) lines.push(`${ordered ? "1." : "-"} ${content}`);
    for (const nested of item.children.filter(
      (child): child is Element =>
        isTag(child) && (child.name.toLowerCase() === "ul" || child.name.toLowerCase() === "ol"),
    )) {
      const nestedList = renderList(nested, context)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      if (nestedList.trim()) lines.push(nestedList);
    }
  }
  return lines.join("\n");
}

function renderTable(element: Element, context: WeChatRenderContext) {
  const rows = findElements(element.children, (child) => child.name.toLowerCase() === "tr");
  const renderedRows = rows
    .map((row) =>
      row.children
        .filter(
          (child): child is Element =>
            isTag(child) && (child.name.toLowerCase() === "td" || child.name.toLowerCase() === "th"),
        )
        .map((cell) =>
          renderBlocks(cell.children, context)
            .replace(/\n{2,}/g, "<br>")
            .replace(/\n/g, "<br>")
            .replace(/^(?:<br>)+|(?:<br>)+$/g, "")
            .replace(/\|/g, "\\|")
            .trim(),
        ),
    )
    .filter((row) => row.length > 0);
  if (!renderedRows.length) return "";

  const width = Math.max(...renderedRows.map((row) => row.length));
  const hasHeader = rows[0]?.children.some((child) => isTag(child) && child.name.toLowerCase() === "th") || false;
  const header = hasHeader ? renderedRows.shift() || [] : Array.from({ length: width }, () => "");
  const normalizeRow = (row: string[]) => [...row, ...Array.from({ length: width - row.length }, () => "")];
  const lines = [
    `| ${normalizeRow(header).join(" | ")} |`,
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...renderedRows.map((row) => `| ${normalizeRow(row).join(" | ")} |`),
  ];
  return lines.join("\n");
}

function renderBlock(node: AnyNode, context: WeChatRenderContext): string {
  if (isText(node)) return escapeMarkdownText(node.data.replace(/\u00a0/g, " "));
  if (!isTag(node)) return hasChildren(node) ? renderBlocks(node.children, context) : "";

  const tag = node.name.toLowerCase();
  if (BLOCKED_TAGS.has(tag)) return "";
  if (tag === "img") return renderInline(node, context);
  if (tag === "br") return "\n";
  if (tag === "hr") return "\n\n---\n\n";
  if (/^h[1-6]$/.test(tag)) {
    const content = normalizeText(inlineContent(node.children, context));
    if (!content) return "";
    context.headingCount += 1;
    return `\n\n${"#".repeat(Math.min(Number(tag.slice(1)) + 1, 6))} ${content}\n\n`;
  }
  if (isStyledHeading(node)) {
    const content = normalizeText(plainText(node));
    context.headingCount += 1;
    return `\n\n## ${escapeMarkdownText(content)}\n\n`;
  }
  if (tag === "ul" || tag === "ol") return `\n\n${renderList(node, context)}\n\n`;
  if (tag === "table") return `\n\n${renderTable(node, context)}\n\n`;
  if (tag === "blockquote") {
    const content = renderBlocks(node.children, context).trim();
    return content ? `\n\n${content.split("\n").map((line) => `> ${line}`).join("\n")}\n\n` : "";
  }
  if (tag === "pre") {
    const content = plainText(node).trim();
    return content ? `\n\n\`\`\`\n${content}\n\`\`\`\n\n` : "";
  }
  if (tag === "p") {
    const content = inlineContent(node.children, context).trim();
    return content ? `\n\n${content}\n\n` : "";
  }
  if (tag === "a" || tag === "strong" || tag === "b" || tag === "em" || tag === "i" || tag === "code") {
    return renderInline(node, context);
  }
  return renderBlocks(node.children, context);
}

function renderBlocks(nodes: AnyNode[], context: WeChatRenderContext) {
  return nodes.map((node) => renderBlock(node, context)).join("");
}

export function renderWeChatArticle(html: string, sourceUrl: string, requestOrigin: string) {
  const document = parseDocument(html, { decodeEntities: true });
  const titleElement = findElement(document.children, (element) => element.attribs.id === "activity-name");
  const contentElement = findElement(document.children, (element) => element.attribs.id === "js_content");
  const authorElement = findElement(document.children, (element) => element.attribs.id === "js_name");
  const title = titleElement
    ? normalizeText(plainText(titleElement))
    : normalizeText(metaContent(document.children, "og:title"));
  const author = authorElement ? normalizeText(plainText(authorElement)) : "";

  if (!contentElement) {
    const blocked = /环境异常|访问过于频繁|请在微信客户端打开|验证|captcha/i.test(html);
    throw new WeChatContentError(
      blocked ? "WECHAT_BLOCKED" : "PARSE_ERROR",
      blocked ? "微信公众号暂时拒绝了网页读取，请稍后再试。" : "文章页面已打开，但没有识别到公众号正文。",
      blocked ? 429 : 422,
      "请使用以 mp.weixin.qq.com/s/ 开头、能在无痕窗口直接打开的文章链接。",
    );
  }
  if (!title) throw new WeChatContentError("PARSE_ERROR", "没有识别到公众号文章标题。");

  const context: WeChatRenderContext = {
    sourceUrl,
    requestOrigin,
    imageUrls: [],
    images: [],
    registeredImages: new Map(),
    headingCount: 0,
  };
  const bodyMarkdown = renderBlocks(contentElement.children, context)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const characterCount = normalizeText(plainText(contentElement)).replace(/\s/g, "").length;
  if (!bodyMarkdown || characterCount < 10) {
    throw new WeChatContentError("EMPTY_DOCUMENT", "公众号文章中没有识别到可导出的正文。");
  }

  const sourceLine = author
    ? `> 来源：微信公众号 · ${escapeMarkdownText(author)} · [查看原文](${sourceUrl})`
    : `> 来源：微信公众号 · [查看原文](${sourceUrl})`;
  return {
    title,
    markdown: `# ${escapeMarkdownText(title)}\n\n${sourceLine}\n\n${bodyMarkdown}`.trim(),
    sourceUrl,
    imageUrls: context.imageUrls,
    images: context.images,
    stats: {
      characters: characterCount + title.replace(/\s/g, "").length,
      images: context.imageUrls.length,
      headings: context.headingCount,
    },
  };
}
