/**
 * Web Search - multi-provider with auto-detection and fallback chain.
 * When EXA_API_KEY is set: Exa → DuckDuckGo (Exa covers primary search; DDG is the free fallback).
 * Otherwise: Tavily → Perplexity → Brave → SearXNG → DuckDuckGo.
 * Any provider can still be forced explicitly via `provider` option.
 */
import { resolveKey } from "./_env.js";
import { mergeLegacyOptions as _mergeLegacyOpts } from "../utils/mergeToolParams.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 50;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const TIMEOUT_MS = 12000;

const FRESHNESS_TO_BRAVE = { day: "pd", week: "pw", month: "pm", year: "py" };
const FRESHNESS_TO_TAVILY_DAYS = { day: 1, week: 7, month: 30, year: 365 };
const FRESHNESS_TO_SEARXNG = { day: "day", week: "week", month: "month", year: "year" };
const FRESHNESS_TO_PERPLEXITY = { day: "day", week: "week", month: "month", year: "year" };
const FRESHNESS_TO_EXA_DAYS = { day: 1, week: 7, month: 30, year: 365 };

const HTML_ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
  "&#39;": "'", "&apos;": "'", "&#x27;": "'", "&#x2F;": "/",
  "&nbsp;": " ", "&#38;": "&", "&#60;": "<", "&#62;": ">",
};
const ENTITY_RE = /&(?:#x[0-9a-f]+|#\d+|[a-z]+);/gi;

function decodeEntities(str) {
  if (!str) return "";
  return str.replace(ENTITY_RE, (m) => {
    if (HTML_ENTITIES[m]) return HTML_ENTITIES[m];
    if (m.startsWith("&#x")) return String.fromCharCode(parseInt(m.slice(3, -1), 16));
    if (m.startsWith("&#")) return String.fromCharCode(parseInt(m.slice(2, -1), 10));
    return m;
  });
}

function stripTags(html) {
  return html ? html.replace(/<[^>]+>/g, "").trim() : "";
}

// --- LRU Cache ---
const searchCache = new Map();

function getCacheKey(query, opts) {
  return `${query}::${opts.maxResults}::${opts.freshness || ""}::${opts.provider || ""}::${opts.language || ""}`;
}

function getFromCache(key) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) { searchCache.delete(key); return null; }
  // LRU: move to end
  searchCache.delete(key);
  searchCache.set(key, entry);
  return entry.results;
}

function setCache(key, results) {
  if (searchCache.size >= CACHE_MAX) {
    searchCache.delete(searchCache.keys().next().value);
  }
  searchCache.set(key, { results, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function clearSearchCache() { searchCache.clear(); return searchCache.size; }

// --- Retry fetch ---
async function fetchWithRetry(url, opts, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (i < retries && (res.status === 408 || res.status === 429 || res.status >= 500)) continue;
      return res;
    } catch (err) {
      if (i === retries) throw err;
    }
  }
}

// --- Provider detection ---
const PROVIDERS = ["exa", "tavily", "perplexity", "brave", "searxng", "ddg"];

function detectProviders() {
  const available = [];
  // When Exa is configured, it handles primary search and DDG is the only fallback.
  // Other configured providers are still reachable via an explicit `provider` override.
  if (resolveKey("EXA_API_KEY")) {
    available.push("exa");
    available.push("ddg");
    return available;
  }
  if (resolveKey("TAVILY_API_KEY")) available.push("tavily");
  if (resolveKey("PERPLEXITY_API_KEY")) available.push("perplexity");
  if (resolveKey("BRAVE_API_KEY")) available.push("brave");
  if (resolveKey("SEARXNG_URL")) available.push("searxng");
  available.push("ddg");
  return available;
}

// --- Format output ---
function formatResults(query, provider, results, aiAnswer) {
  if (!results || results.length === 0) return `No results found for: "${query}"`;
  let out = "";
  if (aiAnswer) out += `**AI Answer:**\n${aiAnswer}\n\n---\n\n`;
  out += `Search results for "${query}" (via ${provider}):\n\n`;
  out += results
    .map((r, i) => `${i + 1}. **${r.title || "Untitled"}**\n   ${r.url}\n   ${r.snippet || ""}`)
    .join("\n\n");
  return out;
}

// --- DuckDuckGo (free fallback) ---
async function searchDDG(query, limit, freshness) {
  let q = query;
  if (freshness === "day") q += " date:d";
  else if (freshness === "week") q += " date:w";
  else if (freshness === "month") q += " date:m";
  else if (freshness === "year") q += " date:y";

  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`;
  const res = await fetchWithRetry(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
  });
  const html = await res.text();

  const results = [];
  // lite.duckduckgo.com uses single-quoted classes; href contains uddg= redirect
  const linkRe = /<a[^>]+class=['"]result-link['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>|<a[^>]+href=['"]([^'"]+)['"][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

  const links = [];
  let m;
  while ((m = linkRe.exec(html)) !== null) links.push({ url: m[1] || m[3], title: m[2] || m[4] });
  const snippets = [];
  while ((m = snippetRe.exec(html)) !== null) snippets.push(m[1]);

  // Fallback: try html.duckduckgo.com pattern
  if (links.length === 0) {
    const altRe = /<a rel="nofollow"[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = altRe.exec(html)) !== null && results.length < limit) {
      let actualUrl = m[1];
      const uddg = m[1].match(/uddg=([^&]+)/);
      if (uddg) actualUrl = decodeURIComponent(uddg[1]);
      results.push({
        title: decodeEntities(stripTags(m[2])),
        url: actualUrl,
        snippet: decodeEntities(stripTags(m[3])),
      });
    }
    return { results: results.slice(0, limit), provider: "DuckDuckGo" };
  }

  for (let i = 0; i < links.length && results.length < limit; i++) {
    let actualUrl = links[i].url;
    const uddg = actualUrl.match(/uddg=([^&]+)/);
    if (uddg) actualUrl = decodeURIComponent(uddg[1]);
    results.push({
      title: decodeEntities(stripTags(links[i].title)),
      url: actualUrl,
      snippet: decodeEntities(stripTags(snippets[i] || "")),
    });
  }
  return { results: results.slice(0, limit), provider: "DuckDuckGo" };
}

// --- Brave Search ---
async function searchBrave(query, limit, freshness, language) {
  const key = resolveKey("BRAVE_API_KEY");
  if (!key) throw new Error("BRAVE_API_KEY not configured");

  let url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
  if (freshness && FRESHNESS_TO_BRAVE[freshness]) url += `&freshness=${FRESHNESS_TO_BRAVE[freshness]}`;
  if (language) url += `&search_lang=${encodeURIComponent(language)}`;

  const res = await fetchWithRetry(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": key,
    },
  });
  if (!res.ok) throw new Error(`Brave API ${res.status}: ${await res.text().catch(() => "")}`);

  const data = await res.json();
  const results = (data.web?.results || []).slice(0, limit).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.description || "",
  }));
  return { results, provider: "Brave" };
}

// --- Tavily ---
async function searchTavily(query, limit, freshness, language) {
  const key = resolveKey("TAVILY_API_KEY");
  if (!key) throw new Error("TAVILY_API_KEY not configured");

  const body = {
    query,
    max_results: limit,
    search_depth: "advanced",
    include_answer: true,
    include_raw_content: false,
  };
  if (freshness && FRESHNESS_TO_TAVILY_DAYS[freshness]) body.days = FRESHNESS_TO_TAVILY_DAYS[freshness];

  const res = await fetchWithRetry("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Tavily API ${res.status}: ${await res.text().catch(() => "")}`);

  const data = await res.json();
  const results = (data.results || []).slice(0, limit).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.content || "",
  }));
  const aiAnswer = data.answer || null;
  return { results, provider: "Tavily", aiAnswer };
}

// --- Perplexity ---
async function searchPerplexity(query, limit, freshness) {
  const key = resolveKey("PERPLEXITY_API_KEY");
  if (!key) throw new Error("PERPLEXITY_API_KEY not configured");

  const isOpenRouter = key.startsWith("sk-or-");
  const baseUrl = isOpenRouter
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://api.perplexity.ai/chat/completions";
  const model = isOpenRouter ? "perplexity/sonar-pro" : "sonar";

  const body = {
    model,
    messages: [{ role: "user", content: query }],
  };
  if (!isOpenRouter && freshness && FRESHNESS_TO_PERPLEXITY[freshness]) {
    body.search_recency_filter = FRESHNESS_TO_PERPLEXITY[freshness];
  }

  const res = await fetchWithRetry(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Perplexity API ${res.status}: ${await res.text().catch(() => "")}`);

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";

  // Extract citations from annotations or top-level citations
  const citations = [];
  const seen = new Set();
  const topCitations = data.citations || [];
  for (const u of topCitations) {
    if (u && !seen.has(u)) { seen.add(u); citations.push(u); }
  }
  if (citations.length === 0) {
    for (const choice of data.choices || []) {
      for (const ann of choice.message?.annotations || []) {
        const u = ann.url_citation?.url || ann.url;
        if (u && !seen.has(u)) { seen.add(u); citations.push(u); }
      }
    }
  }

  const results = citations.slice(0, limit).map((u, i) => ({
    title: `Source ${i + 1}`,
    url: u,
    snippet: "",
  }));

  return { results, provider: "Perplexity", aiAnswer: content || null };
}

// --- Exa ---
// AI-powered semantic search. Returns full content, highlights, and summaries.
// Docs: https://exa.ai/docs/reference/search
async function searchExa(query, limit, freshness, language) {
  const key = resolveKey("EXA_API_KEY");
  if (!key) throw new Error("EXA_API_KEY not configured");

  const body = {
    query,
    type: "auto",
    numResults: limit,
    contents: {
      text: { maxCharacters: 500 },
      highlights: { maxCharacters: 300 },
      summary: {},
    },
  };
  if (freshness && FRESHNESS_TO_EXA_DAYS[freshness]) {
    const days = FRESHNESS_TO_EXA_DAYS[freshness];
    const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    body.startPublishedDate = start.toISOString();
  }
  if (language && typeof language === "string" && language.length === 2) {
    body.userLocation = language.toUpperCase();
  }

  const res = await fetchWithRetry("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "x-exa-integration": "daemora",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Exa API ${res.status}: ${await res.text().catch(() => "")}`);

  const data = await res.json();
  const results = (data.results || []).slice(0, limit).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: extractExaSnippet(r),
  }));
  return { results, provider: "Exa" };
}

// Cascade through summary > highlights > text for the snippet field.
// The API may return any combination - pick whichever is populated.
export function extractExaSnippet(result) {
  if (!result) return "";
  if (typeof result.summary === "string" && result.summary.trim()) return result.summary.trim();
  if (Array.isArray(result.highlights) && result.highlights.length > 0) {
    return result.highlights.filter(Boolean).join(" ... ").trim();
  }
  if (typeof result.text === "string" && result.text.trim()) return result.text.trim();
  return "";
}

// --- SearXNG ---
async function searchSearXNG(query, limit, freshness, language) {
  const baseUrl = resolveKey("SEARXNG_URL");
  if (!baseUrl) throw new Error("SEARXNG_URL not configured");

  let url = `${baseUrl.replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;
  if (freshness && FRESHNESS_TO_SEARXNG[freshness]) url += `&time_range=${FRESHNESS_TO_SEARXNG[freshness]}`;
  if (language) url += `&language=${encodeURIComponent(language)}`;

  const res = await fetchWithRetry(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`SearXNG ${res.status}: ${await res.text().catch(() => "")}`);

  const data = await res.json();
  const results = (data.results || []).slice(0, limit).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.content || "",
  }));
  return { results, provider: "SearXNG" };
}

// --- Provider dispatch ---
const PROVIDER_FN = {
  exa: searchExa,
  tavily: searchTavily,
  perplexity: searchPerplexity,
  brave: searchBrave,
  searxng: searchSearXNG,
  ddg: searchDDG,
};

// --- Main export ---
export async function webSearch(params) {
  const query = params?.query;
  if (!query) return "Error: query is required";

  const opts = _mergeLegacyOpts(params, ["query"]);
  const limit = Math.min(Math.max(parseInt(opts.maxResults) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const freshness = opts.freshness;
  const language = opts.language;
  const forcedProvider = opts.provider;

  console.log(`      [webSearch] Query: "${query}" (limit: ${limit}${freshness ? `, freshness: ${freshness}` : ""}${forcedProvider ? `, provider: ${forcedProvider}` : ""})`);

  const cacheKey = getCacheKey(query, { maxResults: limit, freshness, provider: forcedProvider, language });
  const cached = getFromCache(cacheKey);
  if (cached) {
    console.log(`      [webSearch] Cache hit`);
    return cached;
  }

  const available = detectProviders();
  let chain;
  if (forcedProvider && PROVIDER_FN[forcedProvider]) {
    // Forced provider first, then fallback through remaining
    chain = [forcedProvider, ...available.filter((p) => p !== forcedProvider)];
  } else {
    chain = available;
  }

  let lastError;
  for (const provider of chain) {
    try {
      const fn = PROVIDER_FN[provider];
      if (!fn) continue;
      const { results, provider: name, aiAnswer } = await fn(query, limit, freshness, language);
      const output = formatResults(query, name, results, aiAnswer);
      console.log(`      [webSearch] ${results.length} results via ${name}`);
      setCache(cacheKey, output);
      return output;
    } catch (err) {
      console.log(`      [webSearch] ${provider} failed: ${err.message}`);
      lastError = err;
    }
  }

  return `Search failed: ${lastError?.message || "all providers unavailable"}`;
}

export const webSearchDescription =
  'webSearch(query: string, optionsJson?: string) - Search the web. optionsJson: {"maxResults":5,"freshness":"day|week|month|year","provider":"exa|tavily|perplexity|brave|searxng|ddg","language":"en"}. Auto-detects best available provider: Exa → DuckDuckGo when EXA_API_KEY is set, otherwise Tavily → Perplexity → Brave → SearXNG → DuckDuckGo. Any provider can be forced via the `provider` option. Results cached 5 minutes.';
