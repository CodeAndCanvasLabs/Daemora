/**
 * Smoke tests for the embedding stack.
 *
 *  - TF-IDF vocab fits + embeds + produces L2-normalized vectors
 *  - cosine similarity: same text → 1.0; unrelated → ~0
 *  - Embeddings.provider() falls back to tfidf with no keys + no ollama
 *  - generate() returns a usable result via tfidf without network
 */

import { describe, expect, it } from "vitest";

import Database from "better-sqlite3";

import { ConfigManager } from "../src/config/ConfigManager.js";
import { Embeddings, cosineSim } from "../src/embeddings/Embeddings.js";
import { TfIdfEmbedder } from "../src/embeddings/TfIdf.js";

describe("TfIdfEmbedder", () => {
  it("fits vocab + embeds text to L2-normed vectors", () => {
    const e = new TfIdfEmbedder();
    e.fit(["the cat sat on the mat", "dogs love to run fast", "cats and dogs are friends"]);
    expect(e.isFitted).toBe(true);
    expect(e.dim).toBeGreaterThan(0);
    const v = e.embed("my cat ran fast");
    expect(v).not.toBeNull();
    const norm = Math.sqrt(v!.reduce((acc, x) => acc + x * x, 0));
    expect(norm).toBeGreaterThan(0.9);
    expect(norm).toBeLessThan(1.01);
  });

  it("identical text scores ~1; unrelated scores lower", () => {
    const e = new TfIdfEmbedder();
    e.fit([
      "refactor database migrations to use drizzle",
      "fix voice stream buffering on slow networks",
      "implement per-watcher webhook token rotation",
      "build morning pulse daily briefing cron job",
    ]);
    const sameA = e.embed("refactor database migrations to use drizzle")!;
    const sameB = e.embed("refactor database migrations to use drizzle")!;
    const unrelated = e.embed("build morning pulse daily briefing cron job")!;
    expect(cosineSim(sameA, sameB)).toBeGreaterThan(0.99);
    expect(cosineSim(sameA, unrelated)).toBeLessThan(0.5);
  });
});

describe("Embeddings facade", () => {
  function build() {
    const cfg = ConfigManager.open({ dataDir: `/tmp/daemora-emb-${Date.now()}` });
    return { cfg, emb: new Embeddings(cfg) };
  }

  it("returns null when no neural provider is available (no keys + no ollama)", async () => {
    const { emb } = build();
    emb.tfidf.fit(["hello world", "goodbye moon"]);
    const p = await emb.provider();
    // accept "ollama" only if the test machine happens to have it; otherwise null
    expect(p === null || p === "ollama").toBe(true);
  });

  it("generate() via explicit tfidf returns a vector (no network)", async () => {
    const { emb } = build();
    emb.tfidf.fit(["morning pulse cron", "webhook token rotation"]);
    const r = await emb.generate("cron morning briefing", "tfidf");
    expect(r).not.toBeNull();
    expect(r!.provider).toBe("tfidf");
    expect(r!.vector.length).toBeGreaterThan(0);
  });

  it("generate() returns null when no provider and no forceProvider", async () => {
    // Skip on machines that happen to have ollama running locally.
    const { emb } = build();
    emb.tfidf.fit(["anything"]);
    const p = await emb.provider();
    if (p !== null) return;
    const r = await emb.generate("cron morning briefing");
    expect(r).toBeNull();
  });
});
