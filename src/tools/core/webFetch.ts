/**
 * web_fetch — fetch a URL and return *readable* text.
 *
 * Where `fetch_url` is a raw HTTP client (for calling APIs and getting
 * status codes back), `web_fetch` is the "read me this page" tool:
 *
 *   1. SSRF defense — block private / loopback hosts.
 *   2. GitHub `blob` links auto-convert to `raw.githubusercontent.com`.
 *   3. Primary: fetch the page, strip script/style/nav/footer, remove
 *      hidden elements and prompt-injection-y invisible unicode, convert
 *      to plain text.
 *   4. Fallback: Firecrawl (if FIRECRAWL_API_KEY is in the vault) — for
 *      JS-rendered pages or anything our regex pipeline can't crack.
 *   5. 15-minute LRU cache (100 URLs max) so repeated reads don't burn
 *      bandwidth / quota.
 */

import { z } from "zod";

import type { ConfigManager } from "../../config/ConfigManager.js";
import { ProviderError, TimeoutError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX = 100;

const inputSchema = z.object({
  url: z.string().url(),
  maxChars: z.number().int().positive().max(1_000_000).default(100_000)
    .describe("Hard cap on returned text. Truncates with an ellipsis marker."),
  timeoutMs: z.number().int().positive().max(60_000).default(20_000),
  forceFirecrawl: z.boolean().default(false)
    .describe("Skip the local extractor and go straight to Firecrawl (if configured)."),
});

interface WebFetchResult {
  readonly url: string;
  readonly status: number;
  readonly extractor: "local" | "firecrawl";
  readonly text: string;
  readonly truncated: boolean;
  readonly cached: boolean;
  readonly durationMs: number;
}

const cache = new Map<string, { result: WebFetchResult; expiresAt: number }>();

export function clearWebFetchCache(): number {
  const n = cache.size;
  cache.clear();
  return n;
}

export function makeWebFetchTool(cfg: ConfigManager): ToolDef<typeof inputSchema, WebFetchResult> {
  return {
    name: "web_fetch",
    description:
      "Fetch a web page and return clean readable text. Strips scripts/nav/hidden elements. Falls back to Firecrawl for JS-rendered pages when FIRECRAWL_API_KEY is set.",
    category: "network",
    source: { kind: "core" },
    alwaysOn: true,
    tags: ["fetch", "web", "content", "readability", "scrape"],
    inputSchema,
    async execute({ url, maxChars, timeoutMs, forceFirecrawl }, { abortSignal, logger }) {
      const started = Date.now();

      // SSRF check
      assertPublicUrl(url);

      // Normalise GitHub blob → raw
      const normalUrl = convertGitHubBlobUrl(url);

      // Cache hit
      const hit = cache.get(normalUrl);
      if (hit && Date.now() < hit.expiresAt) {
        logger.info("web_fetch cache hit", { url: normalUrl });
        return { ...hit.result, cached: true };
      }

      // Firecrawl first if explicitly requested.
      if (forceFirecrawl) {
        const firecrawlText = await firecrawlExtract(cfg, normalUrl, timeoutMs);
        if (firecrawlText === null) {
          throw new ProviderError("Firecrawl requested but FIRECRAWL_API_KEY not set or call failed", "firecrawl");
        }
        return cacheAndReturn(normalUrl, {
          url: normalUrl,
          status: 200,
          extractor: "firecrawl",
          ...finaliseText(firecrawlText, maxChars),
          cached: false,
          durationMs: Date.now() - started,
        });
      }

      // Local pipeline.
      const timer = AbortSignal.timeout(timeoutMs);
      const composite = composeSignals([abortSignal, timer]);
      let res: Response;
      try {
        res = await fetch(normalUrl, {
          method: "GET",
          signal: composite,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        });
      } catch (e) {
        if ((e as Error).name === "TimeoutError") throw new TimeoutError(`web_fetch ${normalUrl}`, timeoutMs);
        if (abortSignal.aborted) throw new ValidationError("Fetch cancelled");
        throw new ProviderError(`Fetch failed: ${(e as Error).message}`, "web_fetch");
      }

      // For non-HTML (JSON / text / PDF / image) we return as-is, respecting maxChars.
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("html") && !ct.includes("xml")) {
        const text = (await res.text()).slice(0, maxChars + 1);
        return cacheAndReturn(normalUrl, {
          url: normalUrl,
          status: res.status,
          extractor: "local",
          ...finaliseText(text, maxChars),
          cached: false,
          durationMs: Date.now() - started,
        });
      }

      let html: string;
      try {
        html = await res.text();
      } catch (e) {
        throw new ProviderError(`Failed reading body: ${(e as Error).message}`, "web_fetch");
      }

      const localText = extractReadableText(html);
      // Short result → try Firecrawl if available before giving up.
      if (localText.length < 200) {
        const firecrawlText = await firecrawlExtract(cfg, normalUrl, timeoutMs);
        if (firecrawlText && firecrawlText.length >= localText.length) {
          logger.info("web_fetch used firecrawl fallback", { url: normalUrl });
          return cacheAndReturn(normalUrl, {
            url: normalUrl,
            status: res.status,
            extractor: "firecrawl",
            ...finaliseText(firecrawlText, maxChars),
            cached: false,
            durationMs: Date.now() - started,
          });
        }
      }

      return cacheAndReturn(normalUrl, {
        url: normalUrl,
        status: res.status,
        extractor: "local",
        ...finaliseText(localText, maxChars),
        cached: false,
        durationMs: Date.now() - started,
      });
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function cacheAndReturn(url: string, result: WebFetchResult): WebFetchResult {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(url, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

function finaliseText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const stripped = stripInvisibleUnicode(text).replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (stripped.length <= maxChars) return { text: stripped, truncated: false };
  return { text: `${stripped.slice(0, maxChars)}\n\n…[truncated — exceeded ${maxChars} chars]`, truncated: true };
}

const INVISIBLE_UNICODE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/gu;
function stripInvisibleUnicode(s: string): string {
  return s.replace(INVISIBLE_UNICODE_RE, "");
}

const STRIP_BLOCK_RE = /<(script|style|template|svg|canvas|iframe|object|embed|noscript|nav|footer|aside|form)\b[\s\S]*?<\/\1\s*>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const HIDDEN_CLASS_RE = /<[^>]+\sclass\s*=\s*["'][^"']*\b(sr-only|visually-hidden|d-none|hidden|invisible|offscreen|screen-reader-only)\b[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi;
const HIDDEN_STYLE_RE = /<[^>]+\sstyle\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi;
const HIDDEN_ATTR_RE = /<[^>]+\s(?:aria-hidden\s*=\s*["']true["']|hidden(?:\s|=|>))[^>]*>[\s\S]*?<\/[^>]+>/gi;
const TAG_RE = /<[^>]+>/g;

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
  "&#39;": "'", "&apos;": "'", "&#x27;": "'", "&#x2F;": "/",
  "&nbsp;": " ",
};
const ENTITY_RE = /&(?:#x[0-9a-f]+|#\d+|[a-z]+);/gi;

function extractReadableText(html: string): string {
  let out = html;
  out = out.replace(COMMENT_RE, "");
  out = out.replace(STRIP_BLOCK_RE, "");
  out = out.replace(HIDDEN_CLASS_RE, "");
  out = out.replace(HIDDEN_STYLE_RE, "");
  out = out.replace(HIDDEN_ATTR_RE, "");
  // Prefer <article> / <main> if present.
  const main = out.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i);
  if (main?.[1]) out = main[1];
  // Linebreak-aware block tag close
  out = out.replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, "\n");
  out = out.replace(/<li[^>]*>/gi, "- ");
  out = out.replace(TAG_RE, "");
  out = out.replace(ENTITY_RE, (m) => {
    if (HTML_ENTITIES[m]) return HTML_ENTITIES[m];
    if (m.startsWith("&#x")) return String.fromCharCode(parseInt(m.slice(3, -1), 16));
    if (m.startsWith("&#")) return String.fromCharCode(parseInt(m.slice(2, -1), 10));
    return m;
  });
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function firecrawlExtract(cfg: ConfigManager, url: string, timeoutMs: number): Promise<string | null> {
  const key = cfg.vault.get("FIRECRAWL_API_KEY")?.reveal();
  if (!key) return null;
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, timeout: Math.min(timeoutMs, 15_000) }),
      signal: AbortSignal.timeout(Math.min(timeoutMs + 5_000, 30_000)),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { markdown?: string; content?: string } };
    return data.data?.markdown ?? data.data?.content ?? null;
  } catch {
    return null;
  }
}

const GITHUB_BLOB_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/;
function convertGitHubBlobUrl(url: string): string {
  const m = url.match(GITHUB_BLOB_RE);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : url;
}

// SSRF — block loopback, RFC1918, link-local, cloud metadata, localhost.
const PRIVATE_HOST_REGEX = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
  /^localhost$/i,
];

function assertPublicUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(`Invalid URL: ${url}`);
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new ValidationError(`Blocked protocol: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (PRIVATE_HOST_REGEX.some((r) => r.test(host))) {
    throw new ValidationError(`Blocked private / loopback host: ${host}`);
  }
}

function composeSignals(signals: readonly AbortSignal[]): AbortSignal {
  const native = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === "function") return native(Array.from(signals));
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(s.reason); break; }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}
