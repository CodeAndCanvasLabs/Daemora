/**
 * Web Search - DuckDuckGo (free) + Brave Search (if API key set).
 * Upgraded: result caching, freshness/date filters, optionsJson support.
 */
import { resolveKey } from "./_env.js";

// Search result cache: key → { results, expiresAt }
const searchCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Brave freshness parameter mapping
const FRESHNESS_MAP = {
  day: "pd", week: "pw", month: "pm", year: "py",
};

function getCacheKey(query, opts) {
  return `${query}::${JSON.stringify(opts)}`;
}

function getFromCache(key) {
  const entry = searchCache.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.results;
  if (entry) searchCache.delete(key);
  return null;
}

function setCache(key, results) {
  if (searchCache.size >= 50) {
    searchCache.delete(searchCache.keys().next().value);
  }
  searchCache.set(key, { results, expiresAt: Date.now() + CACHE_TTL_MS });
}

export async function webSearch(params) {
  const query = params?.query;
  const optionsJson = params?.options;
  // Support both old API (maxResults as string) and new API (optionsJson)
  let opts = {};
  if (optionsJson && !isNaN(parseInt(optionsJson))) {
    opts = { maxResults: parseInt(optionsJson) };
  } else if (optionsJson) {
    try { opts = JSON.parse(optionsJson); } catch {}
  }

  const limit = opts.maxResults ? parseInt(opts.maxResults) : 5;
  const freshness = opts.freshness; // day | week | month | year
  const provider = opts.provider;  // "brave" | "ddg" | undefined = auto

  console.log(`      [webSearch] Query: "${query}" (limit: ${limit}${freshness ? `, freshness: ${freshness}` : ""})`);

  const cacheKey = getCacheKey(query, opts);
  const cached = getFromCache(cacheKey);
  if (cached) {
    console.log(`      [webSearch] Cache hit`);
    return cached;
  }

  let result;
  if (provider === "ddg" || (!resolveKey("BRAVE_API_KEY") && provider !== "brave")) {
    result = await duckDuckGoSearch(query, limit, freshness);
  } else {
    result = await braveSearch(query, limit, freshness);
  }

  setCache(cacheKey, result);
  return result;
}

async function duckDuckGoSearch(query, limit, freshness) {
  try {
    let q = query;
    if (freshness === "day") q += " site:* after:yesterday";
    else if (freshness === "week") q += " site:* after:7days";

    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(10000),
    });

    const html = await response.text();
    const results = [];
    const resultRegex =
      /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>(.+?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < limit) {
      let actualUrl = match[1];
      const uddgMatch = match[1].match(/uddg=([^&]+)/);
      if (uddgMatch) actualUrl = decodeURIComponent(uddgMatch[1]);
      results.push({
        title: match[2].replace(/<[^>]+>/g, "").trim(),
        url: actualUrl,
        snippet: match[3].replace(/<[^>]+>/g, "").trim(),
      });
    }

    if (results.length === 0) return `No results found for: "${query}"`;
    console.log(`      [webSearch] Found ${results.length} results (DuckDuckGo)`);
    return `Search results for "${query}":\n\n` +
      results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
  } catch (error) {
    return `Search failed: ${error.message}`;
  }
}

async function braveSearch(query, limit, freshness) {
  try {
    let url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
    if (freshness && FRESHNESS_MAP[freshness]) {
      url += `&freshness=${FRESHNESS_MAP[freshness]}`;
    }

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": resolveKey("BRAVE_API_KEY"),
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return duckDuckGoSearch(query, limit, freshness);

    const data = await response.json();
    const results = (data.web?.results || []).slice(0, limit);
    if (results.length === 0) return `No results found for: "${query}"`;

    console.log(`      [webSearch] Found ${results.length} results (Brave)`);
    return `Search results for "${query}":\n\n` +
      results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description || ""}`).join("\n\n");
  } catch (error) {
    return duckDuckGoSearch(query, limit, freshness);
  }
}

export const webSearchDescription =
  'webSearch(query: string, optionsJson?: string) - Search the web. optionsJson: {"maxResults":5,"freshness":"day|week|month|year","provider":"brave|ddg"}. Uses DuckDuckGo (free) by default, Brave if BRAVE_API_KEY set. Results cached 5 minutes.';
