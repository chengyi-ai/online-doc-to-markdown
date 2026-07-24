"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type ExtractResult = {
  title: string;
  markdown: string;
  sourceUrl: string;
  stats: {
    characters: number;
    images: number;
    headings: number;
  };
  imageUrls: string[];
  images?: Array<{
    url: string;
    name: string;
    mimeType: string;
  }>;
};

type ErrorResult = {
  error: string;
  code?: string;
  help?: string;
};

const progressCopy = [
  "正在打开公开文档…",
  "正在整理正文结构…",
  "正在识别图片与标题…",
];

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function getDosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

function createZip(files: Array<{ path: string; data: Uint8Array }>) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const { date, time } = getDosDateTime();
  let localOffset = 0;
  let centralSize = 0;

  for (const file of files) {
    const name = encoder.encode(file.path);
    const checksum = crc32(file.data);
    const localHeader = new Uint8Array(30 + name.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, file.data.length, true);
    localView.setUint32(22, file.data.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(name, 30);
    localParts.push(localHeader, file.data);

    const centralHeader = new Uint8Array(46 + name.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, file.data.length, true);
    centralView.setUint32(24, file.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true);
    centralHeader.set(name, 46);
    centralParts.push(centralHeader);

    localOffset += localHeader.length + file.data.length;
    centralSize += centralHeader.length;
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  endView.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
}

const mimeExtensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tiff",
};

function getImageExtension(mimeType: string, originalName: string) {
  const normalizedMime = mimeType.split(";", 1)[0].trim().toLowerCase();
  if (mimeExtensions[normalizedMime]) return mimeExtensions[normalizedMime];
  const extension = originalName.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1].toLowerCase();
  return extension || "img";
}

function safeFileName(value: string) {
  const cleaned = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "公开文档";
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [progressIndex, setProgressIndex] = useState(0);
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [error, setError] = useState("");
  const [errorHelp, setErrorHelp] = useState("");
  const [copied, setCopied] = useState(false);
  const [zipState, setZipState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [zipProgress, setZipProgress] = useState({ complete: 0, total: 0 });
  const [zipError, setZipError] = useState("");

  useEffect(() => {
    if (status !== "loading") return;
    const timer = window.setInterval(() => {
      setProgressIndex((current) => Math.min(current + 1, progressCopy.length - 1));
    }, 2400);
    return () => window.clearInterval(timer);
  }, [status]);

  const hostLabel = useMemo(() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }, [url]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("loading");
    setProgressIndex(0);
    setResult(null);
    setError("");
    setErrorHelp("");
    setCopied(false);
    setZipState("idle");
    setZipProgress({ complete: 0, total: 0 });
    setZipError("");

    try {
      const response = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const payload = (await response.json()) as ExtractResult | ErrorResult;
      if (!response.ok) {
        const failure = payload as ErrorResult;
        setError(failure.error || "转换失败，请稍后重试。");
        setErrorHelp(failure.help || "");
        setStatus("error");
        return;
      }
      setResult(payload as ExtractResult);
      setStatus("success");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "转换失败，请稍后重试。");
      setStatus("error");
    }
  }

  function downloadMarkdown() {
    if (!result) return;
    const blob = new Blob(["\uFEFF", result.markdown], {
      type: "text/markdown;charset=utf-8",
    });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${safeFileName(result.title)}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
  }

  async function copyMarkdown() {
    if (!result) return;
    await navigator.clipboard.writeText(result.markdown);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function downloadZip() {
    if (!result || zipState === "loading") return;
    const assets = result.images?.length
      ? result.images
      : result.imageUrls.map((imageUrl, index) => ({
          url: imageUrl,
          name: `image-${String(index + 1).padStart(3, "0")}`,
          mimeType: "application/octet-stream",
        }));
    setZipState("loading");
    setZipError("");
    setZipProgress({ complete: 0, total: assets.length });

    try {
      const downloaded: Array<{ index: number; url: string; path: string; data: Uint8Array }> = [];
      let cursor = 0;
      let completed = 0;

      async function worker() {
        while (cursor < assets.length) {
          const index = cursor;
          cursor += 1;
          const asset = assets[index];
          let response = await fetch(asset.url);
          if (!response.ok) response = await fetch(asset.url, { cache: "reload" });
          if (!response.ok) throw new Error(`第 ${index + 1} 张图片下载失败，请重试。`);
          const contentType = response.headers.get("content-type") || asset.mimeType;
          const extension = getImageExtension(contentType, asset.name);
          const path = `images/image-${String(index + 1).padStart(3, "0")}.${extension}`;
          downloaded.push({
            index,
            url: asset.url,
            path,
            data: new Uint8Array(await response.arrayBuffer()),
          });
          completed += 1;
          setZipProgress({ complete: completed, total: assets.length });
        }
      }

      await Promise.all(Array.from({ length: Math.min(3, Math.max(assets.length, 1)) }, () => worker()));
      downloaded.sort((left, right) => left.index - right.index);
      let localMarkdown = result.markdown;
      for (const image of downloaded) {
        const htmlEscapedUrl = image.url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        localMarkdown = localMarkdown
          .split(image.url).join(image.path)
          .split(htmlEscapedUrl).join(image.path);
      }

      const root = safeFileName(result.title);
      const encoder = new TextEncoder();
      const files = [
        { path: `${root}/${root}.md`, data: encoder.encode(`\uFEFF${localMarkdown}`) },
        ...downloaded.map((image) => ({ path: `${root}/${image.path}`, data: image.data })),
      ];
      const blob = createZip(files);
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `${root}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
      setZipState("done");
      window.setTimeout(() => setZipState("idle"), 2400);
    } catch (caught) {
      setZipError(caught instanceof Error ? caught.message : "图片打包失败，请重试。");
      setZipState("error");
    }
  }

  function reset() {
    setUrl("");
    setStatus("idle");
    setResult(null);
    setError("");
    setErrorHelp("");
    setZipState("idle");
    setZipProgress({ complete: 0, total: 0 });
    setZipError("");
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="文档转 MD 首页">
          <span className="brand-mark" aria-hidden="true">M</span>
          <span>文档转 MD</span>
        </a>
        <span className="privacy-pill"><i />不保存文档内容</span>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow"><span>PUBLIC DOC</span><b>一键整理</b></div>
        <h1>把在线文档与公众号文章，<br /><em>干净地变成 Markdown。</em></h1>
        <p className="hero-copy">
          粘贴公开可访问的飞书、钉钉或微信公众号文章链接。自动提取文字、标题层级和图片，可下载 MD 或包含全部原图的 ZIP。
        </p>

        <form className="converter-card" onSubmit={handleSubmit}>
          <label htmlFor="document-url">飞书 / 钉钉 / 公众号文章链接</label>
          <div className="input-row">
            <span className="link-icon" aria-hidden="true">↗</span>
            <input
              id="document-url"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="粘贴飞书、钉钉或 mp.weixin.qq.com 文章链接"
              required
              disabled={status === "loading"}
              autoComplete="off"
              spellCheck={false}
            />
            {url && status !== "loading" ? (
              <button className="clear-button" type="button" onClick={() => setUrl("")} aria-label="清空链接">×</button>
            ) : null}
          </div>

          <button className="primary-button" type="submit" disabled={!url.trim() || status === "loading"}>
            {status === "loading" ? (
              <><span className="spinner" />{progressCopy[progressIndex]}</>
            ) : (
              <>开始转换 <span aria-hidden="true">→</span></>
            )}
          </button>

          <div className="form-footnote">
            <span>支持飞书、钉钉 alidocs、微信公众号网页文章</span>
            {hostLabel ? <span className="host-label">正在读取 {hostLabel}</span> : <span>无需开放平台配置</span>}
          </div>
        </form>

        {status === "error" ? (
          <section className="message-card error-card" role="alert">
            <span className="message-symbol">!</span>
            <div>
              <h2>这次没有读到文档</h2>
              <p>{error}</p>
              {errorHelp ? <p className="message-help">{errorHelp}</p> : null}
            </div>
          </section>
        ) : null}

        {status === "success" && result ? (
          <section className="result-card" aria-live="polite">
            <div className="result-head">
              <div>
                <span className="success-label"><i />转换完成</span>
                <h2>{result.title}</h2>
              </div>
              <button className="new-button" type="button" onClick={reset}>转换新文档</button>
            </div>

            <div className="stats-grid">
              <div><strong>{result.stats.characters.toLocaleString("zh-CN")}</strong><span>文字字符</span></div>
              <div><strong>{result.stats.headings}</strong><span>标题层级</span></div>
              <div><strong>{result.stats.images}</strong><span>识别图片</span></div>
            </div>

            <div className="action-row">
              <button className="zip-button" type="button" onClick={downloadZip} disabled={zipState === "loading"}>
                {zipState === "loading"
                  ? `正在下载图片 ${zipProgress.complete}/${zipProgress.total}`
                  : zipState === "done"
                    ? "ZIP 已下载"
                    : "下载 MD + 全部图片 ZIP"}
                <span>↓</span>
              </button>
              <button className="download-button" type="button" onClick={downloadMarkdown}>只下载 MD</button>
              <button className="copy-button" type="button" onClick={copyMarkdown}>{copied ? "已复制" : "复制全部文字"}</button>
            </div>
            {zipError ? <p className="zip-message error" role="alert">{zipError}</p> : null}
            {zipState === "done" ? <p className="zip-message" aria-live="polite">已打包完成，解压后直接打开 MD 即可显示本地图片。</p> : null}

            <div className="preview-grid">
              <article className="markdown-preview">
                <div className="preview-title"><span>MD 预览</span><small>UTF-8</small></div>
                <pre>{result.markdown.slice(0, 5200)}{result.markdown.length > 5200 ? "\n\n…其余内容已省略，请下载完整文件" : ""}</pre>
              </article>

              <aside className="image-preview">
                <div className="preview-title"><span>图片识别</span><small>{result.imageUrls.length} 张</small></div>
                {result.imageUrls.length ? (
                  <div className="image-stack">
                    {result.imageUrls.slice(0, 6).map((imageUrl, index) => (
                      // External image URLs are intentionally kept as-is so the MD stays portable.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={`${imageUrl}-${index}`} src={imageUrl} alt={`文档图片 ${index + 1}`} loading="lazy" />
                    ))}
                  </div>
                ) : (
                  <div className="empty-images"><span>□</span><p>这篇文档里没有识别到图片</p></div>
                )}
                <p className="image-note">选择“MD + 全部图片 ZIP”后，图片会保存到本地 images 文件夹，MD 也会自动改为本地引用。</p>
              </aside>
            </div>
          </section>
        ) : null}
      </section>

      <section className="how-it-works" aria-labelledby="how-title">
        <div className="section-kicker">HOW IT WORKS</div>
        <h2 id="how-title">只做三件事，<br />不把简单的事做复杂。</h2>
        <div className="steps">
          <article><span>01</span><h3>粘贴链接</h3><p>支持飞书、钉钉在线文档和微信公众号网页文章。</p></article>
          <article><span>02</span><h3>自动整理</h3><p>识别正文、标题、列表、引用和图片 Markdown。</p></article>
          <article><span>03</span><h3>下载 ZIP</h3><p>Markdown 与全部原图一起保存，本地打开也能完整显示。</p></article>
        </div>
      </section>

      <footer>
        <p>请只转换你有权访问和使用的文档。</p>
        <p>文档转 MD · 飞书 / 钉钉 / 公众号公开内容整理工具</p>
      </footer>
    </main>
  );
}
