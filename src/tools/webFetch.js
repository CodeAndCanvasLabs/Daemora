/**
 * webFetch - production-grade web fetch + content extraction with prompt injection defense.
 */
import { convert } from "html-to-text";
import { URL } from "node:url";
import { mergeLegacyOptions as _mergeLegacyOpts } from "../utils/mergeToolParams.js";
import { resolveKey } from "./_env.js";
import egressGuard from "../safety/EgressGuard.js";

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------
const PRIVATE_RANGES = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./, /^169\.254\./, /^0\./, /^::1$/,
  /^fc00:/i, /^fe80:/i, /^localhost$/i,
];
function isPrivateIP(h) { return PRIVATE_RANGES.some(r => r.test(h)); }

// ---------------------------------------------------------------------------
// Cache - 15min TTL, 100 entries, LRU eviction
// ---------------------------------------------------------------------------
const cache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_SIZE = 100;

export function clearFetchCache() { cache.clear(); return cache.size; }

function checkCache(url) {
  const e = cache.get(url);
  if (e && Date.now() < e.expiresAt) return e.content;
  if (e) cache.delete(url);
  return null;
}

function setCache(url, content) {
  if (cache.size >= MAX_CACHE_SIZE) cache.delete(cache.keys().next().value);
  cache.set(url, { content, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// GitHub blob → raw URL
// ---------------------------------------------------------------------------
function convertGitHubUrl(url) {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : url;
}

// ---------------------------------------------------------------------------
// Invisible Unicode stripping
// ---------------------------------------------------------------------------
const INVISIBLE_UNICODE_RE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/gu;

function stripInvisibleUnicode(text) {
  return text.replace(INVISIBLE_UNICODE_RE, "");
}

// ---------------------------------------------------------------------------
// HTML sanitization - regex-based prompt injection defense
// ---------------------------------------------------------------------------
const STRIP_TAGS_RE = /<(script|style|meta|template|svg|canvas|iframe|object|embed|noscript)\b[\s\S]*?<\/\1\s*>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;

const HIDDEN_ATTR_RE = /<[^>]+(?:\s(?:aria-hidden\s*=\s*["']true["']|hidden(?:\s|=|>|\/)))[^>]*>[\s\S]*?<\/[^>]+>/gi;
const HIDDEN_INPUT_RE = /<input\s[^>]*type\s*=\s*["']hidden["'][^>]*\/?>/gi;

const HIDDEN_CLASS_NAMES = [
  "sr-only", "visually-hidden", "d-none", "hidden",
  "invisible", "offscreen", "screen-reader-only",
];
const HIDDEN_CLASS_RE = new RegExp(
  `<[^>]+\\sclass\\s*=\\s*["'][^"']*\\b(${HIDDEN_CLASS_NAMES.join("|")})\\b[^"']*["'][^>]*>[\\s\\S]*?<\\/[^>]+>`,
  "gi"
);

// Inline style patterns that hide content
const HIDDEN_STYLE_PATTERNS = [
  /display\s*:\s*none/i,
  /visibility\s*:\s*hidden/i,
  /opacity\s*:\s*0(?:\s*[;"])/i,
  /font-size\s*:\s*0(?:px|em|rem|pt|%)?\s*[;"/]/i,
  /text-indent\s*:\s*-\d{4,}px/i,
  /color\s*:\s*transparent/i,
  /color\s*:\s*rgba\s*\([^)]*,\s*0(?:\.0+)?\s*\)/i,
  /transform\s*:\s*scale\s*\(\s*0\s*\)/i,
  /transform\s*:\s*translateX\s*\(\s*-\d{4,}px\s*\)/i,
  /clip-path\s*:\s*inset\s*\(\s*(?:0*\.\d+|[1-9]\d*(?:\.\d+)?)%/i,
];

// Match elements with style="..." where style contains hidden patterns
const STYLE_ATTR_RE = /<([a-z][a-z0-9]*)\b[^>]*\sstyle\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1\s*>/gi;

function sanitizeHtml(html) {
  let s = html;
  // Strip comments
  s = s.replace(COMMENT_RE, "");
  // Strip dangerous/invisible tags entirely
  s = s.replace(STRIP_TAGS_RE, "");
  // Strip hidden inputs
  s = s.replace(HIDDEN_INPUT_RE, "");
  // Strip aria-hidden/hidden attribute elements
  s = s.replace(HIDDEN_ATTR_RE, "");
  // Strip hidden-class elements
  s = s.replace(HIDDEN_CLASS_RE, "");
  // Strip elements with hiding inline styles
  s = s.replace(STYLE_ATTR_RE, (match, tag, style, inner) => {
    for (const pat of HIDDEN_STYLE_PATTERNS) {
      if (pat.test(style)) return "";
    }
    // width:0+height:0+overflow:hidden combo
    if (/width\s*:\s*0(?:px)?\s*[;"]/.test(style) &&
        /height\s*:\s*0(?:px)?\s*[;"]/.test(style) &&
        /overflow\s*:\s*hidden/i.test(style)) return "";
    // Offscreen positioning
    if (/(?:left|top)\s*:\s*-\d{4,}px/i.test(style) &&
        /position\s*:\s*(absolute|fixed)/i.test(style)) return "";
    return match;
  });
  return s;
}

// ---------------------------------------------------------------------------
// Nesting depth check - skip DOM parsing on pathological HTML
// ---------------------------------------------------------------------------
const VOID_TAGS = new Set([
  "area","base","br","col","embed","hr","img","input",
  "link","meta","param","source","track","wbr",
]);

function exceedsNestingDepth(html, maxDepth = 500) {
  let depth = 0;
  const len = html.length;
  for (let i = 0; i < len; i++) {
    if (html.charCodeAt(i) !== 60) continue; // <
    const next = html.charCodeAt(i + 1);
    if (next === 33 || next === 63) continue; // <!...> <?...>
    let j = i + 1, closing = false;
    if (html.charCodeAt(j) === 47) { closing = true; j++; }
    while (j < len && html.charCodeAt(j) <= 32) j++;
    const ns = j;
    while (j < len) {
      const c = html.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 58) { j++; continue; }
      break;
    }
    const tag = html.slice(ns, j).toLowerCase();
    if (!tag) continue;
    if (closing) { depth = Math.max(0, depth - 1); continue; }
    if (VOID_TAGS.has(tag)) continue;
    // self-closing detection
    let sc = false;
    for (let k = j; k < len && k < j + 200; k++) {
      if (html.charCodeAt(k) === 62) { sc = html.charCodeAt(k - 1) === 47; break; }
    }
    if (sc) continue;
    depth++;
    if (depth > maxDepth) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// HTML entity decoding
// ---------------------------------------------------------------------------
function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/gi, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

function stripTags(s) { return decodeEntities(s.replace(/<[^>]+>/g, "")); }

function normalizeWs(s) {
  return s.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

// ---------------------------------------------------------------------------
// htmlToMarkdown - convert HTML to clean markdown
// ---------------------------------------------------------------------------
function htmlToMarkdown(html) {
  let t = html;
  // strip script/style/noscript (Readability output may still have some)
  t = t.replace(/<script[\s\S]*?<\/script>/gi, "");
  t = t.replace(/<style[\s\S]*?<\/style>/gi, "");
  t = t.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  // pre>code → fenced code blocks (before other transforms)
  t = t.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, body) =>
    "\n```\n" + stripTags(body).trim() + "\n```\n"
  );
  // inline code
  t = t.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, body) => "`" + stripTags(body) + "`");
  // links
  t = t.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
    const label = normalizeWs(stripTags(body));
    return label ? `[${label}](${href})` : href;
  });
  // headings
  t = t.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, body) =>
    "\n" + "#".repeat(Math.min(6, Math.max(1, +lvl))) + " " + normalizeWs(stripTags(body)) + "\n"
  );
  // blockquote
  t = t.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, body) =>
    "\n" + stripTags(body).trim().split("\n").map(l => "> " + l).join("\n") + "\n"
  );
  // bold/italic
  t = t.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, body) => "**" + stripTags(body) + "**");
  t = t.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, body) => "*" + stripTags(body) + "*");
  // list items
  t = t.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
    const label = normalizeWs(stripTags(body));
    return label ? "\n- " + label : "";
  });
  // br/hr → newlines
  t = t.replace(/<(br|hr)\s*\/?>/gi, "\n");
  // block-close → newlines
  t = t.replace(/<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi, "\n");
  // strip remaining tags
  t = stripTags(t);
  return normalizeWs(t);
}

// ---------------------------------------------------------------------------
// Streaming body truncation
// ---------------------------------------------------------------------------
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB

async function readBodyTruncated(response, maxBytes = MAX_BODY_BYTES) {
  try {
    const reader = response.body?.getReader?.();
    if (!reader) return (await response.text()).slice(0, maxBytes);
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) { reader.cancel(); break; }
    }
    const merged = new Uint8Array(Math.min(total, maxBytes));
    let off = 0;
    for (const c of chunks) {
      const take = Math.min(c.byteLength, maxBytes - off);
      merged.set(c.subarray(0, take), off);
      off += take;
      if (off >= maxBytes) break;
    }
    return new TextDecoder().decode(merged);
  } catch {
    return (await response.text()).slice(0, maxBytes);
  }
}

// ---------------------------------------------------------------------------
// CSS selector extraction
// ---------------------------------------------------------------------------
let _linkedom;
async function loadLinkedom() {
  if (_linkedom) return _linkedom;
  try {
    _linkedom = await import("linkedom");
    return _linkedom;
  } catch { return null; }
}

async function extractSelector(html, selector) {
  const linkedom = await loadLinkedom();
  if (!linkedom) return null;
  const { document } = linkedom.parseHTML(html);
  const el = document.querySelector(selector);
  return el ? el.innerHTML : null;
}

// ---------------------------------------------------------------------------
// Readability extraction (lazy-loaded)
// ---------------------------------------------------------------------------
let _readabilityDeps;
async function loadReadability() {
  if (_readabilityDeps) return _readabilityDeps;
  try {
    const [r, l] = await Promise.all([import("@mozilla/readability"), import("linkedom")]);
    _readabilityDeps = { Readability: r.Readability, parseHTML: l.parseHTML };
    return _readabilityDeps;
  } catch {
    _readabilityDeps = null;
    return null;
  }
}

async function readabilityExtract(sanitized, url) {
  const deps = await loadReadability();
  if (!deps) return null;
  try {
    const { document } = deps.parseHTML(sanitized);
    try { document.baseURI = url; } catch {}
    const parsed = new deps.Readability(document, { charThreshold: 0 }).parse();
    if (!parsed?.content) return null;
    const md = htmlToMarkdown(parsed.content);
    return { text: md, title: parsed.title || undefined };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// html-to-text fallback
// ---------------------------------------------------------------------------
function htmlToTextFallback(html) {
  return convert(html, {
    wordwrap: 120,
    selectors: [
      { selector: "a", options: { ignoreHref: false } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "nav", format: "skip" },
      { selector: "footer", format: "skip" },
      { selector: "header", options: { uppercase: false } },
    ],
  }).replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// Firecrawl fallback
// ---------------------------------------------------------------------------
async function firecrawlExtract(url) {
  const key = resolveKey("FIRECRAWL_API_KEY");
  if (!key) return null;
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        timeout: 15000,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.markdown || data?.data?.content || null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Content extraction pipeline
// ---------------------------------------------------------------------------
async function extractHtml(rawHtml, url, selector) {
  const sanitized = sanitizeHtml(rawHtml);

  // Optional CSS selector extraction
  let html = sanitized;
  if (selector) {
    const fragment = await extractSelector(sanitized, selector);
    if (fragment) html = fragment;
  }

  const deepNesting = exceedsNestingDepth(html);

  // Primary: Readability (skip if deep nesting)
  if (!deepNesting) {
    const result = await readabilityExtract(html, url);
    if (result && result.text.length >= 200) {
      return stripInvisibleUnicode(result.text);
    }
  }

  // Fallback: html-to-text
  const plainText = htmlToTextFallback(html);
  if (plainText.length >= 200) return stripInvisibleUnicode(plainText);

  // Fallback: Firecrawl (if available and primary extraction was short)
  const fc = await firecrawlExtract(url);
  if (fc && fc.length >= 200) return stripInvisibleUnicode(fc);

  // Return whatever we got
  return stripInvisibleUnicode(plainText || htmlToMarkdown(html));
}

// ---------------------------------------------------------------------------
// Retry-capable fetch
// ---------------------------------------------------------------------------
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchWithRetry(url, attempt = 0) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });
    // Retry once on 5xx
    if (res.status >= 500 && attempt === 0) return fetchWithRetry(url, 1);
    return res;
  } catch (err) {
    // Retry once on timeout/connection errors
    if (attempt === 0 && (err.name === "TimeoutError" || err.code === "ECONNRESET" || err.code === "ECONNREFUSED")) {
      return fetchWithRetry(url, 1);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export async function webFetch(params) {
  let url = params?.url;
  const opts = _mergeLegacyOpts(params, ["url"]);
  const maxChars = opts.maxChars ? parseInt(opts.maxChars) : 50000;
  const selector = opts.selector || undefined;

  console.log(`      [webFetch] Fetching: ${url}`);

  try {
    let parsed;
    try { parsed = new URL(url); } catch {
      return `Error: Invalid URL: ${url}`;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return `Error: Only http and https URLs are supported (got ${parsed.protocol})`;
    }
    if (isPrivateIP(parsed.hostname)) {
      return `Error: Access to private/internal addresses is not allowed: ${parsed.hostname}`;
    }

    url = convertGitHubUrl(url);

    // Cache check (include selector in key)
    const cacheKey = selector ? `${url}::${selector}` : url;
    const cached = checkCache(cacheKey);
    if (cached) {
      console.log(`      [webFetch] Cache hit for ${url}`);
      return cached;
    }

    // Egress guard - block if URL contains a known secret value
    const egressCheck = egressGuard.check(url);
    if (!egressCheck.safe) {
      return `Error: URL contains a leaked secret (${egressCheck.leaked}). Request blocked.`;
    }

    const startTime = Date.now();
    const response = await fetchWithRetry(url);
    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      return `HTTP Error ${response.status}: ${response.statusText}`;
    }

    const contentType = response.headers.get("content-type") || "";
    console.log(`      [webFetch] ${response.status} | ${contentType} | ${elapsed}ms`);

    let result;

    if (contentType.includes("text/markdown")) {
      // Markdown as-is
      const body = await readBodyTruncated(response);
      result = stripInvisibleUnicode(body).slice(0, maxChars);
    } else if (contentType.includes("text/html")) {
      const body = await readBodyTruncated(response);
      result = await extractHtml(body, url, selector);
      result = result.slice(0, maxChars);
    } else if (contentType.includes("application/json")) {
      const body = await readBodyTruncated(response);
      try {
        result = JSON.stringify(JSON.parse(body), null, 2).slice(0, maxChars);
      } catch {
        result = body.slice(0, maxChars);
      }
    } else {
      const body = await readBodyTruncated(response);
      result = stripInvisibleUnicode(body).slice(0, maxChars);
    }

    if (result.length === maxChars) {
      result += `\n\n[Content truncated at ${maxChars} chars. Use {"maxChars":100000} for more.]`;
    }

    console.log(`      [webFetch] Got ${result.length} chars`);
    setCache(cacheKey, result);
    return result;
  } catch (error) {
    console.log(`      [webFetch] Failed: ${error.message}`);
    return `Error fetching URL: ${error.message}`;
  }
}

export const webFetchDescription =
  'webFetch(url: string, maxChars?: number, selector?: string) - Fetch and extract readable content from a URL. HTML is sanitized against prompt injection, converted via Readability→markdown with html-to-text and Firecrawl fallbacks. Supports CSS selector extraction. Responses cached 15min. Private URLs blocked.';
