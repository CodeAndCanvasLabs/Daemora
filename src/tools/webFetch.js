/**
 * webFetch(url, optionsJson?) - Fetch URL content with proper HTML conversion, caching, and SSRF protection.
 * Upgraded: html-to-text library, 15-min cache, SSRF guard, 50K char limit, GitHub URL conversion.
 */
import { convert } from "html-to-text";
import { URL } from "node:url";

// Private IP ranges - SSRF protection
const PRIVATE_RANGES = [
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

// Response cache: url → { content, expiresAt }
const cache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_CACHE_SIZE = 100;

export function clearFetchCache() { cache.clear(); return cache.size; }

function isPrivateIP(hostname) {
  return PRIVATE_RANGES.some((r) => r.test(hostname));
}

function convertGitHubUrl(url) {
  // Convert GitHub blob URLs to raw content URLs
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (match) {
    return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`;
  }
  return url;
}

function checkCache(url) {
  const entry = cache.get(url);
  if (entry && Date.now() < entry.expiresAt) {
    return entry.content;
  }
  if (entry) cache.delete(url); // expired
  return null;
}

function setCache(url, content) {
  if (cache.size >= MAX_CACHE_SIZE) {
    // Evict oldest entry
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(url, { content, expiresAt: Date.now() + CACHE_TTL_MS });
}

export async function webFetch(params) {
  let url = params?.url;
  const optionsJson = params?.options;
  const opts = optionsJson ? JSON.parse(optionsJson) : {};
  const maxChars = opts.maxChars ? parseInt(opts.maxChars) : 50000;

  console.log(`      [webFetch] Fetching: ${url}`);

  try {
    // Validate URL
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return `Error: Invalid URL: ${url}`;
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return `Error: Only http and https URLs are supported (got ${parsed.protocol})`;
    }

    // SSRF protection
    if (isPrivateIP(parsed.hostname)) {
      return `Error: Access to private/internal addresses is not allowed: ${parsed.hostname}`;
    }

    // GitHub blob → raw URL
    url = convertGitHubUrl(url);

    // Check cache
    const cached = checkCache(url);
    if (cached) {
      console.log(`      [webFetch] Cache hit for ${url}`);
      return cached;
    }

    const startTime = Date.now();
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });
    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      return `HTTP Error ${response.status}: ${response.statusText}`;
    }

    const contentType = response.headers.get("content-type") || "";
    console.log(`      [webFetch] ${response.status} | ${contentType} | ${elapsed}ms`);

    let result;

    if (contentType.includes("application/json")) {
      const json = await response.json();
      result = JSON.stringify(json, null, 2).slice(0, maxChars);
    } else if (contentType.includes("text/html")) {
      const html = await response.text();
      // Use html-to-text for proper conversion
      result = convert(html, {
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
      });
      result = result.replace(/\n{3,}/g, "\n\n").trim().slice(0, maxChars);
    } else {
      result = (await response.text()).slice(0, maxChars);
    }

    if (result.length === maxChars) {
      result += `\n\n[Content truncated at ${maxChars} chars. Use optionsJson '{"maxChars":100000}' for more.]`;
    }

    console.log(`      [webFetch] Got ${result.length} chars`);
    setCache(url, result);
    return result;
  } catch (error) {
    console.log(`      [webFetch] Failed: ${error.message}`);
    return `Error fetching URL: ${error.message}`;
  }
}

export const webFetchDescription =
  'webFetch(url: string, optionsJson?: string) - Fetch content from a URL. HTML is properly converted to readable text. optionsJson: {"maxChars":50000}. Responses are cached for 15 minutes. Private/internal URLs are blocked for security.';
