/**
 * web_search — multi-provider internet search with automatic fallback.
 *
 * Tries providers in priority order and falls through to the next on
 * any failure (missing key, rate limit, HTTP error, timeout):
 *
 *   Tavily → Perplexity → Brave → SearXNG → DuckDuckGo
 *
 * DuckDuckGo needs no API key, so there's always *something* working
 * as long as the process has outbound internet. The earlier providers
 * are better quality when a key is present — Tavily/Perplexity even
 * return a synthesised AI answer alongside the raw hits.
 *
 * Results cached in-memory for 5 minutes (LRU, max 50 entries) so
 * back-to-back identical queries don't burn quota.
 */
import { z } from "zod";

import type { ConfigManager } from "../../config/ConfigManager.js";
import {
  ProviderError,
  ProviderUnavailableError,
  TimeoutError,
  ValidationError,
} from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 50;
const TIMEOUT_MS = 12_000;

const FRESHNESS_TO_BRAVE = { day: "pd", week: "pw", month: "pm", year: "py" } as const;
const FRESHNESS_TO_TAVILY_DAYS = { day: 1, week: 7, month: 30, year: 365 } as const;
const FRESHNESS_TO_SEARXNG = { day: "day", week: "week", month: "month", year: "year" } as const;
const FRESHNESS_TO_PERPLEXITY = { day: "day", week: "week", month: "month", year: "year" } as const;

type Freshness = keyof typeof FRESHNESS_TO_BRAVE;
type ProviderId = "firecrawl" | "tavily" | "perplexity" | "brave" | "searxng" | "ddg";

const inputSchema = z.object({
  query: z.string().min(1).max(400).describe("Search query. Natural language OK — don't escape."),
  count: z.number().int().min(1).max(20).default(5).describe("Number of results. Default 5, max 20."),
  freshness: z.enum(["day", "week", "month", "year"]).optional().describe("Time filter."),
  language: z.string().length(2).optional().describe("ISO language code, e.g. 'en'."),
  provider: z.enum(["firecrawl", "tavily", "perplexity", "brave", "searxng", "ddg"]).optional()
    .describe("Force a specific provider (falls back through remaining on failure)."),
});

export interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly description: string;
}

export interface WebSearchResult {
  readonly query: string;
  readonly provider: string;
  readonly aiAnswer: string | null;
  readonly totalReturned: number;
  readonly results: readonly WebSearchHit[];
}

interface CacheEntry {
  readonly result: WebSearchResult;
  readonly expiresAt: number;
}

const searchCache = new Map<string, CacheEntry>();

function cacheKey(query: string, count: number, freshness: Freshness | undefined, provider: ProviderId | undefined, language: string | undefined): string {
  return `${query}::${count}::${freshness ?? ""}::${provider ?? ""}::${language ?? ""}`;
}

function cacheGet(key: string): WebSearchResult | null {
  const e = searchCache.get(key);
  if (!e) return null;
  if (Date.now() >= e.expiresAt) { searchCache.delete(key); return null; }
  // LRU: move to end
  searchCache.delete(key);
  searchCache.set(key, e);
  return e.result;
}

function cachePut(key: string, result: WebSearchResult): void {
  if (searchCache.size >= CACHE_MAX) {
    const first = searchCache.keys().next().value;
    if (first) searchCache.delete(first);
  }
  searchCache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function clearWebSearchCache(): number {
  const n = searchCache.size;
  searchCache.clear();
  return n;
}

async function fetchWithTimeout(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const timer = AbortSignal.timeout(TIMEOUT_MS);
  const composite = composeSignals([signal, timer]);
  return fetch(url, { ...init, signal: composite });
}

// ── Provider: Firecrawl (key: FIRECRAWL_API_KEY) ───────────────
// Same key the user sets for `web_fetch`'s Firecrawl extractor —
// one credential covers both tools.
async function searchFirecrawl(cfg: ConfigManager, query: string, limit: number, freshness: Freshness | undefined, signal: AbortSignal): Promise<WebSearchResult> {
  const key = cfg.vault.get("FIRECRAWL_API_KEY");
  if (!key) throw new ProviderUnavailableError("Firecrawl", "FIRECRAWL_API_KEY");

  // Firecrawl's freshness window is `tbs=qdr:<unit>` Google-style.
  const tbs: Record<Freshness, string> = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };
  const body: Record<string, unknown> = { query, limit };
  if (freshness) body["tbs"] = tbs[freshness];

  const res = await fetchWithTimeout("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key.reveal()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }, signal);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(`Firecrawl ${res.status}: ${text.slice(0, 200)}`, "firecrawl");
  }
  const json = (await res.json()) as { data?: Array<{ url?: string; title?: string; description?: string; markdown?: string }> };
  const items = Array.isArray(json.data) ? json.data : [];
  const results: WebSearchHit[] = items
    .filter((d) => typeof d.url === "string" && d.url.length > 0)
    .slice(0, limit)
    .map((d) => ({
      title: d.title ?? "",
      url: d.url ?? "",
      description: d.description ?? "",
    }));
  return { query, provider: "Firecrawl", aiAnswer: null, totalReturned: results.length, results };
}

// ── Provider: DuckDuckGo (keyless) ─────────────────────────────
async function searchDDG(query: string, limit: number, freshness: Freshness | undefined, signal: AbortSignal): Promise<WebSearchResult> {
  let q = query;
  if (freshness === "day") q += " date:d";
  else if (freshness === "week") q += " date:w";
  else if (freshness === "month") q += " date:m";
  else if (freshness === "year") q += " date:y";

  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  }, signal);
  if (!res.ok) throw new ProviderError(`DuckDuckGo ${res.status}`, "ddg");
  const html = await res.text();

  const results: WebSearchHit[] = [];

  // lite.duckduckgo.com layout
  const liteRe = /<a[^>]+class=['"]result-link['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>|<a[^>]+href=['"]([^'"]+)['"][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;
  const links: { url: string; title: string }[] = [];
  const snippets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = liteRe.exec(html)) !== null) {
    links.push({ url: m[1] ?? m[3] ?? "", title: m[2] ?? m[4] ?? "" });
  }
  while ((m = snippetRe.exec(html)) !== null) snippets.push(m[1] ?? "");

  // Fall back to html.duckduckgo.com layout if lite didn't match
  if (links.length === 0) {
    const altRe = /<a rel="nofollow"[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = altRe.exec(html)) !== null && results.length < limit) {
      let actualUrl = m[1] ?? "";
      const uddg = actualUrl.match(/uddg=([^&]+)/);
      if (uddg?.[1]) actualUrl = decodeURIComponent(uddg[1]);
      results.push({
        title: decodeEntities(stripTags(m[2] ?? "")),
        url: actualUrl,
        description: decodeEntities(stripTags(m[3] ?? "")),
      });
    }
    return { query, provider: "DuckDuckGo", aiAnswer: null, totalReturned: results.length, results };
  }

  for (let i = 0; i < links.length && results.length < limit; i++) {
    const link = links[i];
    if (!link) continue;
    let actualUrl = link.url;
    const uddg = actualUrl.match(/uddg=([^&]+)/);
    if (uddg?.[1]) actualUrl = decodeURIComponent(uddg[1]);
    results.push({
      title: decodeEntities(stripTags(link.title)),
      url: actualUrl,
      description: decodeEntities(stripTags(snippets[i] ?? "")),
    });
  }
  return { query, provider: "DuckDuckGo", aiAnswer: null, totalReturned: results.length, results };
}

// ── Provider: Brave ────────────────────────────────────────────
async function searchBrave(cfg: ConfigManager, query: string, limit: number, freshness: Freshness | undefined, language: string | undefined, signal: AbortSignal): Promise<WebSearchResult> {
  const key = cfg.vault.get("BRAVE_SEARCH_API_KEY") ?? cfg.vault.get("BRAVE_API_KEY");
  if (!key) throw new ProviderUnavailableError("Brave", "BRAVE_SEARCH_API_KEY");

  let url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
  if (freshness) url += `&freshness=${FRESHNESS_TO_BRAVE[freshness]}`;
  if (language) url += `&search_lang=${encodeURIComponent(language)}`;

  const res = await fetchWithTimeout(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": key.reveal(),
    },
  }, signal);
  if (!res.ok) throw new ProviderError(`Brave ${res.status}: ${await res.text().catch(() => "")}`, "brave");
  const data = (await res.json()) as { web?: { results?: { title?: string; url: string; description?: string }[] } };
  const results: WebSearchHit[] = (data.web?.results ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? "",
    url: r.url,
    description: stripTags(r.description ?? ""),
  }));
  return { query, provider: "Brave", aiAnswer: null, totalReturned: results.length, results };
}

// ── Provider: Tavily ───────────────────────────────────────────
async function searchTavily(cfg: ConfigManager, query: string, limit: number, freshness: Freshness | undefined, signal: AbortSignal): Promise<WebSearchResult> {
  const key = cfg.vault.get("TAVILY_API_KEY");
  if (!key) throw new ProviderUnavailableError("Tavily", "TAVILY_API_KEY");

  const body: Record<string, unknown> = {
    query,
    max_results: limit,
    search_depth: "advanced",
    include_answer: true,
    include_raw_content: false,
  };
  if (freshness) body["days"] = FRESHNESS_TO_TAVILY_DAYS[freshness];

  const res = await fetchWithTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.reveal()}` },
    body: JSON.stringify(body),
  }, signal);
  if (!res.ok) throw new ProviderError(`Tavily ${res.status}: ${await res.text().catch(() => "")}`, "tavily");
  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[]; answer?: string };
  const results: WebSearchHit[] = (data.results ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    description: r.content ?? "",
  }));
  return { query, provider: "Tavily", aiAnswer: data.answer ?? null, totalReturned: results.length, results };
}

// ── Provider: Perplexity (also accepts OpenRouter keys) ────────
async function searchPerplexity(cfg: ConfigManager, query: string, limit: number, freshness: Freshness | undefined, signal: AbortSignal): Promise<WebSearchResult> {
  const key = cfg.vault.get("PERPLEXITY_API_KEY");
  if (!key) throw new ProviderUnavailableError("Perplexity", "PERPLEXITY_API_KEY");

  const raw = key.reveal();
  const isOpenRouter = raw.startsWith("sk-or-");
  const url = isOpenRouter
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://api.perplexity.ai/chat/completions";
  const model = isOpenRouter ? "perplexity/sonar-pro" : "sonar";

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: query }],
  };
  if (!isOpenRouter && freshness) {
    body["search_recency_filter"] = FRESHNESS_TO_PERPLEXITY[freshness];
  }

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${raw}` },
    body: JSON.stringify(body),
  }, signal);
  if (!res.ok) throw new ProviderError(`Perplexity ${res.status}: ${await res.text().catch(() => "")}`, "perplexity");
  const data = (await res.json()) as {
    choices?: { message?: { content?: string; annotations?: { url_citation?: { url?: string }; url?: string }[] } }[];
    citations?: string[];
  };

  const content = data.choices?.[0]?.message?.content ?? "";
  const citations: string[] = [];
  const seen = new Set<string>();
  for (const u of data.citations ?? []) {
    if (u && !seen.has(u)) { seen.add(u); citations.push(u); }
  }
  if (citations.length === 0) {
    for (const choice of data.choices ?? []) {
      for (const ann of choice.message?.annotations ?? []) {
        const u = ann.url_citation?.url ?? ann.url;
        if (u && !seen.has(u)) { seen.add(u); citations.push(u); }
      }
    }
  }
  const results: WebSearchHit[] = citations.slice(0, limit).map((u, i) => ({
    title: `Source ${i + 1}`,
    url: u,
    description: "",
  }));
  return { query, provider: "Perplexity", aiAnswer: content || null, totalReturned: results.length, results };
}

// ── Provider: SearXNG (self-hosted) ────────────────────────────
async function searchSearXNG(cfg: ConfigManager, query: string, limit: number, freshness: Freshness | undefined, language: string | undefined, signal: AbortSignal): Promise<WebSearchResult> {
  const baseUrl = cfg.settings.getGeneric("SEARXNG_URL") as string | undefined;
  if (!baseUrl) throw new ProviderUnavailableError("SearXNG", "SEARXNG_URL");

  let url = `${baseUrl.replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;
  if (freshness) url += `&time_range=${FRESHNESS_TO_SEARXNG[freshness]}`;
  if (language) url += `&language=${encodeURIComponent(language)}`;

  const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, signal);
  if (!res.ok) throw new ProviderError(`SearXNG ${res.status}: ${await res.text().catch(() => "")}`, "searxng");
  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  const results: WebSearchHit[] = (data.results ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    description: r.content ?? "",
  }));
  return { query, provider: "SearXNG", aiAnswer: null, totalReturned: results.length, results };
}

// ── Dispatch ───────────────────────────────────────────────────

/** Detects configured providers in priority order, always appends DDG as the keyless fallback. */
function detectProviders(cfg: ConfigManager): ProviderId[] {
  const out: ProviderId[] = [];
  if (cfg.vault.has("FIRECRAWL_API_KEY")) out.push("firecrawl");
  if (cfg.vault.has("TAVILY_API_KEY")) out.push("tavily");
  if (cfg.vault.has("PERPLEXITY_API_KEY")) out.push("perplexity");
  if (cfg.vault.has("BRAVE_SEARCH_API_KEY") || cfg.vault.has("BRAVE_API_KEY")) out.push("brave");
  if (cfg.settings.getGeneric("SEARXNG_URL")) out.push("searxng");
  out.push("ddg");
  return out;
}

async function runProvider(id: ProviderId, cfg: ConfigManager, query: string, limit: number, freshness: Freshness | undefined, language: string | undefined, signal: AbortSignal): Promise<WebSearchResult> {
  switch (id) {
    case "firecrawl": return searchFirecrawl(cfg, query, limit, freshness, signal);
    case "tavily": return searchTavily(cfg, query, limit, freshness, signal);
    case "perplexity": return searchPerplexity(cfg, query, limit, freshness, signal);
    case "brave": return searchBrave(cfg, query, limit, freshness, language, signal);
    case "searxng": return searchSearXNG(cfg, query, limit, freshness, language, signal);
    case "ddg": return searchDDG(query, limit, freshness, signal);
  }
}

export function makeWebSearchTool(cfg: ConfigManager): ToolDef<typeof inputSchema, WebSearchResult> {
  return {
    name: "web_search",
    description:
      "Search the web. Auto-detects best available provider (Firecrawl > Tavily > Perplexity > Brave > SearXNG > DuckDuckGo) and falls through on failure or empty results. DuckDuckGo needs no key. Use fetch_url or web_fetch afterwards to read a specific page.",
    category: "search",
    source: { kind: "core" },
    alwaysOn: true,
    tags: ["search", "web"],
    inputSchema,
    async execute({ query, count, freshness, language, provider }, { abortSignal, logger }) {
      const key = cacheKey(query, count, freshness, provider, language);
      const cached = cacheGet(key);
      if (cached) {
        logger.info("web_search cache hit", { query, provider: cached.provider });
        return cached;
      }

      const available = detectProviders(cfg);
      const chain: ProviderId[] = provider
        ? [provider, ...available.filter((p) => p !== provider)]
        : available;

      let lastError: Error | null = null;
      let lastEmpty: WebSearchResult | null = null;
      for (let i = 0; i < chain.length; i++) {
        const id = chain[i]!;
        const isLast = i === chain.length - 1;
        try {
          const result = await runProvider(id, cfg, query, count, freshness, language, abortSignal);
          // Treat empty result sets as a SOFT failure when other
          // providers remain — DDG in particular returns 200 with zero
          // results when it serves a captcha/anti-scrape page, which
          // previously caused the chain to stop with a useless empty
          // response. Only return empty if this is genuinely the last
          // provider in the chain.
          if (result.results.length === 0 && !isLast) {
            logger.warn("web_search empty result — trying next provider", { provider: result.provider });
            lastEmpty = result;
            continue;
          }
          logger.info("web_search ok", { query, provider: result.provider, count: result.results.length });
          cachePut(key, result);
          return result;
        } catch (e) {
          const err = e as Error;
          logger.warn("web_search provider failed", { provider: id, error: err.message });
          lastError = err;
          if (abortSignal.aborted) throw new ValidationError("Search cancelled");
          continue;
        }
      }

      // All providers either errored or returned empty. Prefer the
      // empty-set return over an error so the agent can see "search
      // ran but found nothing" — but only when no provider hard-failed.
      if (lastEmpty && !lastError) {
        cachePut(key, lastEmpty);
        return lastEmpty;
      }

      throw lastError instanceof ProviderError
        ? lastError
        : new ProviderError(`All search providers failed${lastError ? `: ${lastError.message}` : ""}`, "web_search");
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
  "&#39;": "'", "&apos;": "'", "&#x27;": "'", "&#x2F;": "/",
  "&nbsp;": " ", "&#38;": "&", "&#60;": "<", "&#62;": ">",
};
const ENTITY_RE = /&(?:#x[0-9a-f]+|#\d+|[a-z]+);/gi;

function decodeEntities(str: string): string {
  if (!str) return "";
  return str.replace(ENTITY_RE, (m) => {
    if (HTML_ENTITIES[m]) return HTML_ENTITIES[m];
    if (m.startsWith("&#x")) return String.fromCharCode(parseInt(m.slice(3, -1), 16));
    if (m.startsWith("&#")) return String.fromCharCode(parseInt(m.slice(2, -1), 10));
    return m;
  });
}

function stripTags(html: string): string {
  return html ? html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
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

// Unused import placeholder to keep RateLimitError importable for future use.
export { TimeoutError };
