import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We test the Exa provider path end-to-end by stubbing the global fetch.
// resolveKey() reads from process.env, so we control that via env overrides.

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_EXA_KEY = process.env.EXA_API_KEY;
const ORIGINAL_TAVILY_KEY = process.env.TAVILY_API_KEY;
const ORIGINAL_PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
const ORIGINAL_BRAVE_KEY = process.env.BRAVE_API_KEY;
const ORIGINAL_SEARXNG_URL = process.env.SEARXNG_URL;

function makeExaResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function fixture() {
  return {
    requestId: "req-123",
    results: [
      {
        id: "https://exa.ai/article-1",
        title: "Article One",
        url: "https://exa.ai/article-1",
        publishedDate: "2026-03-01T00:00:00.000Z",
        author: "Jane",
        text: "Full text of article one.",
        highlights: ["First highlight", "Second highlight"],
        highlightScores: [0.9, 0.8],
        summary: "A short summary of article one.",
      },
      {
        id: "https://exa.ai/article-2",
        title: "Article Two",
        url: "https://exa.ai/article-2",
        text: "Full text of article two.",
        highlights: ["Only highlight for two"],
        // no summary
      },
      {
        id: "https://exa.ai/article-3",
        title: "Article Three",
        url: "https://exa.ai/article-3",
        text: "Only text is present for article three.",
        // no summary, no highlights
      },
    ],
  };
}

describe("webSearch - Exa provider", () => {
  beforeEach(() => {
    // Isolate the module cache so clearSearchCache is effective across tests.
    vi.resetModules();
    // Keep only EXA key set so the provider chain starts with Exa.
    process.env.EXA_API_KEY = "test-exa-key";
    delete process.env.TAVILY_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.BRAVE_API_KEY;
    delete process.env.SEARXNG_URL;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_EXA_KEY === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = ORIGINAL_EXA_KEY;
    if (ORIGINAL_TAVILY_KEY !== undefined) process.env.TAVILY_API_KEY = ORIGINAL_TAVILY_KEY;
    if (ORIGINAL_PERPLEXITY_KEY !== undefined) process.env.PERPLEXITY_API_KEY = ORIGINAL_PERPLEXITY_KEY;
    if (ORIGINAL_BRAVE_KEY !== undefined) process.env.BRAVE_API_KEY = ORIGINAL_BRAVE_KEY;
    if (ORIGINAL_SEARXNG_URL !== undefined) process.env.SEARXNG_URL = ORIGINAL_SEARXNG_URL;
  });

  it("calls the Exa API with x-api-key + x-exa-integration and parses results", async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      return makeExaResponse(fixture());
    });

    const { webSearch } = await import("../../../src/tools/webSearch.js");
    const output = await webSearch({ query: "llm research", maxResults: 3 });

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://api.exa.ai/search");
    expect(calls[0].opts.method).toBe("POST");
    expect(calls[0].opts.headers["x-api-key"]).toBe("test-exa-key");
    expect(calls[0].opts.headers["x-exa-integration"]).toBe("daemora");

    const reqBody = JSON.parse(calls[0].opts.body);
    expect(reqBody.query).toBe("llm research");
    expect(reqBody.numResults).toBe(3);
    expect(reqBody.contents).toBeDefined();
    // Confirm multiple content types can coexist
    expect(reqBody.contents.text).toBeDefined();
    expect(reqBody.contents.highlights).toBeDefined();
    expect(reqBody.contents.summary).toBeDefined();

    expect(output).toContain("Exa");
    expect(output).toContain("Article One");
    expect(output).toContain("https://exa.ai/article-1");
    expect(output).toContain("A short summary of article one.");
  });

  it("adds a startPublishedDate when freshness is set", async () => {
    let captured;
    globalThis.fetch = vi.fn(async (url, opts) => {
      captured = JSON.parse(opts.body);
      return makeExaResponse({ results: [] });
    });

    const { webSearch } = await import("../../../src/tools/webSearch.js");
    await webSearch({ query: "news today", freshness: "day" });

    expect(captured.startPublishedDate).toBeDefined();
    // Must be an ISO string within the last ~2 days
    const t = Date.parse(captured.startPublishedDate);
    expect(Number.isNaN(t)).toBe(false);
    expect(Date.now() - t).toBeLessThan(2 * 24 * 60 * 60 * 1000);
  });

  it("cascades summary > highlights > text for the snippet (extractExaSnippet)", async () => {
    const { extractExaSnippet } = await import("../../../src/tools/webSearch.js");

    expect(
      extractExaSnippet({ summary: "sum", highlights: ["hi"], text: "txt" })
    ).toBe("sum");

    expect(
      extractExaSnippet({ highlights: ["hi-a", "hi-b"], text: "txt" })
    ).toBe("hi-a ... hi-b");

    expect(extractExaSnippet({ text: "just text" })).toBe("just text");

    expect(extractExaSnippet({})).toBe("");
    expect(extractExaSnippet(null)).toBe("");

    // Empty summary falls through to highlights
    expect(
      extractExaSnippet({ summary: "   ", highlights: ["hi"] })
    ).toBe("hi");
  });

  it("falls back directly to DuckDuckGo when Exa fails, skipping other providers", async () => {
    // Set Tavily + Brave keys too - they should be SKIPPED in the auto chain
    // because Exa is the configured primary. Only DDG is the fallback.
    process.env.TAVILY_API_KEY = "tavily-should-not-be-used";
    process.env.BRAVE_API_KEY = "brave-should-not-be-used";

    let exaHit = false;
    let ddgHit = false;
    let tavilyHit = false;
    let braveHit = false;
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.startsWith("https://api.exa.ai")) {
        exaHit = true;
        return { ok: false, status: 429, json: async () => ({}), text: async () => "rate limited" };
      }
      if (u.includes("duckduckgo.com")) {
        ddgHit = true;
        return { ok: true, status: 200, text: async () => "<html></html>" };
      }
      if (u.includes("api.tavily.com")) {
        tavilyHit = true;
        return { ok: true, status: 200, json: async () => ({ results: [] }), text: async () => "" };
      }
      if (u.includes("api.search.brave.com")) {
        braveHit = true;
        return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { webSearch } = await import("../../../src/tools/webSearch.js");
    const output = await webSearch({ query: "will fallback" });

    expect(exaHit).toBe(true);
    expect(ddgHit).toBe(true);
    // Critical: competitors must NOT be called when Exa is the primary
    expect(tavilyHit).toBe(false);
    expect(braveHit).toBe(false);
    expect(typeof output).toBe("string");
  });

  it("is not offered when EXA_API_KEY is unset", async () => {
    delete process.env.EXA_API_KEY;
    // No search-provider keys at all → only DDG should run, Exa URL never touched.
    let exaHit = false;
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).startsWith("https://api.exa.ai")) exaHit = true;
      return {
        ok: true,
        status: 200,
        text: async () => "<html></html>",
      };
    });

    const { webSearch } = await import("../../../src/tools/webSearch.js");
    await webSearch({ query: "no exa key" });
    expect(exaHit).toBe(false);
  });

  it("can be forced via provider=exa", async () => {
    let called;
    globalThis.fetch = vi.fn(async (url, opts) => {
      called = url;
      return makeExaResponse(fixture());
    });

    const { webSearch } = await import("../../../src/tools/webSearch.js");
    const output = await webSearch({ query: "force exa", provider: "exa" });

    expect(called).toBe("https://api.exa.ai/search");
    expect(output).toContain("Exa");
  });
});
