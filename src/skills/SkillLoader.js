import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync, accessSync, constants } from "fs";
import { join, basename, delimiter } from "path";
import { createHash } from "node:crypto";
import { config } from "../config/default.js";
import { generateEmbedding, getEmbeddingProvider, buildTfidfVocab } from "../utils/Embeddings.js";

/**
 * Skill Loader - auto-discovers .md skill files from the skills/ directory.
 *
 * Each skill file has YAML frontmatter (name, description, triggers)
 * followed by the skill prompt content.
 *
 * Skills are matched to tasks via:
 *  1. Semantic (embeddings) - cosine similarity on OpenAI text-embedding-3-small vectors.
 *     Vectors are cached in data/skill-embeddings.json, recomputed only when skill content changes.
 *  2. Keyword fallback - simple trigger/description word matching when no API key is set.
 *
 * Format:
 * ```markdown
 * ---
 * name: coding
 * description: Use when writing, debugging, or reviewing code
 * triggers: code, function, bug, error, refactor, implement
 * ---
 * You are an expert programmer...
 * ```
 */

const SKILL_EMBEDDINGS_PATH = join(config.dataDir, "skill-embeddings.json");
const EMBED_THRESHOLD = 0.32;  // Lower than memory (0.40) - skill descriptions are shorter

class SkillLoader {
  constructor() {
    this.skills = new Map();
    this.loaded = false;
    this._skillVectors = {};  // { skillName: { hash, vector } }
  }

  /**
   * Load all skill files from the skills directory.
   */
  load() {
    const skillsDir = config.skillsDir;
    if (!existsSync(skillsDir)) {
      console.log(`[SkillLoader] No skills directory: ${skillsDir}`);
      this.loaded = true;
      return;
    }

    this.skills.clear();
    this._loadFromDir(skillsDir);

    this.loaded = true;
    this._loadSkillVectors();
    this._buildTfidfIndex();
    console.log(
      `[SkillLoader] Loaded ${this.skills.size} skills: ${[...this.skills.keys()].join(", ") || "(none)"}`
    );
  }

  /**
   * Parse a skill file with YAML frontmatter.
   */
  parseSkill(content, filename) {
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!fmMatch) {
      return {
        name: filename.replace(".md", ""),
        description: "",
        triggers: [],
        content: content.trim(),
      };
    }

    const frontmatter = fmMatch[1];
    const body = fmMatch[2].trim();

    // Simple YAML parsing (no dependency needed)
    const meta = {};
    for (const line of frontmatter.split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        meta[key] = value;
      }
    }

    return {
      name: meta.name || filename.replace(".md", ""),
      description: meta.description || "",
      triggers: meta.triggers
        ? meta.triggers.split(",").map((t) => t.trim().toLowerCase())
        : [],
      // Eligibility fields (OpenClaw-style filtering)
      os: meta.os ? meta.os.split(",").map((s) => s.trim().toLowerCase()) : [],
      requires: meta.requires ? meta.requires.split(",").map((s) => s.trim()) : [],
      env: meta.env ? meta.env.split(",").map((s) => s.trim()) : [],
      content: body,
    };
  }

  /**
   * Load skills from a directory — supports flat .md files and subdirectories with SKILL.md.
   * Scans one level deep: skills/foo.md and skills/bar/SKILL.md both work.
   */
  _loadFromDir(dir) {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      try {
        const entryPath = join(dir, entry);
        const stat = statSync(entryPath);

        if (stat.isFile() && entry.endsWith(".md")) {
          // Flat file: skills/coding.md
          const content = readFileSync(entryPath, "utf-8");
          const skill = this.parseSkill(content, entry);
          if (skill) {
            skill.filePath = entryPath;
            this.skills.set(skill.name, skill);
          }
        } else if (stat.isDirectory()) {
          // Subdirectory: skills/webapp-testing/SKILL.md
          const skillMd = join(entryPath, "SKILL.md");
          if (existsSync(skillMd)) {
            const content = readFileSync(skillMd, "utf-8");
            const skill = this.parseSkill(content, `${entry}/SKILL.md`);
            if (skill) {
              skill.filePath = skillMd;
              this.skills.set(skill.name, skill);
            }
          }
        }
      } catch (error) {
        console.log(`[SkillLoader] Error loading ${entry}: ${error.message}`);
      }
    }
  }

  /**
   * Build TF-IDF vocabulary from all loaded skills (zero-cost local embeddings fallback).
   */
  _buildTfidfIndex() {
    const docs = [];
    for (const [, skill] of this.skills) {
      docs.push(`${skill.name} ${skill.description} ${skill.triggers.join(" ")} ${skill.content.slice(0, 500)}`);
    }
    buildTfidfVocab(docs);
  }

  // ── Embedding helpers ────────────────────────────────────────────────────────

  _contentHash(skill) {
    // Include provider so cache auto-invalidates when user switches embedding provider
    const provider = getEmbeddingProvider() || "none";
    return createHash("sha1")
      .update(`${provider}|${skill.name}|${skill.description}|${skill.triggers.join(",")}|${skill.content}`)
      .digest("hex")
      .slice(0, 16);
  }

  _loadSkillVectors() {
    if (!existsSync(SKILL_EMBEDDINGS_PATH)) return;
    try {
      this._skillVectors = JSON.parse(readFileSync(SKILL_EMBEDDINGS_PATH, "utf-8"));
    } catch {
      this._skillVectors = {};
    }
  }

  _saveSkillVectors() {
    try {
      mkdirSync(config.dataDir, { recursive: true });
      writeFileSync(SKILL_EMBEDDINGS_PATH, JSON.stringify(this._skillVectors));
    } catch {}
  }

  _generateEmbedding(text) {
    return generateEmbedding(text);
  }

  _cosineSim(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na  += a[i] * a[i];
      nb  += b[i] * b[i];
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  // ── Public async API ─────────────────────────────────────────────────────────

  /**
   * Pre-compute and cache embeddings for all loaded skills.
   * Called once at startup as fire-and-forget. Only re-embeds skills whose content changed.
   */
  async embedSkills() {
    if (!getEmbeddingProvider()) return;
    if (!this.loaded) this.load();

    let changed = false;

    for (const [name, skill] of this.skills) {
      const hash = this._contentHash(skill);
      if (this._skillVectors[name]?.hash === hash) continue;  // Cache hit - skip

      // Text to embed: name + description + triggers + first 500 chars of body
      const text = [
        `Skill: ${skill.name}`,
        `Description: ${skill.description}`,
        `Triggers: ${skill.triggers.join(", ")}`,
        skill.content.slice(0, 500),
      ].join("\n");

      const vector = await this._generateEmbedding(text);
      if (vector) {
        this._skillVectors[name] = { hash, vector };
        changed = true;
        console.log(`[SkillLoader] Embedded skill: ${name}`);
      }
    }

    // Remove cached vectors for skills that no longer exist
    for (const name of Object.keys(this._skillVectors)) {
      if (!this.skills.has(name)) {
        delete this._skillVectors[name];
        changed = true;
      }
    }

    if (changed) this._saveSkillVectors();
  }

  /**
   * Semantic skill matching - embeds the task input and returns skills above cosine threshold.
   * Falls back to keyword matching if OPENAI_API_KEY is absent or embeddings aren't ready.
   *
   * Returns top-5 matched skills, sorted by relevance score (highest first).
   */
  async getSkillPromptsAsync(taskInput, { exclude = [] } = {}) {
    if (!taskInput) return "";
    if (!this.loaded) this.load();

    const vectorsAvailable = Object.keys(this._skillVectors).length > 0;

    if (getEmbeddingProvider() && vectorsAvailable) {
      const queryVector = await this._generateEmbedding(taskInput);
      if (queryVector) {
        const scored = [];

        for (const [name, skill] of this.skills) {
          if (exclude.includes(name)) continue;
          const cached = this._skillVectors[name];
          if (!cached?.vector) continue;
          const score = this._cosineSim(queryVector, cached.vector);
          if (score >= EMBED_THRESHOLD) {
            scored.push({ skill, score });
          }
        }

        scored.sort((a, b) => b.score - a.score);
        const matched = scored.slice(0, 5).map((s) => s.skill);

        if (matched.length > 0) {
          console.log(
            `[SkillLoader] Semantic match (${matched.length}): ${matched.map((s) => s.name).join(", ")}`
          );
          return matched
            .map((s) => `\n--- Skill: ${s.name} ---\n${s.content}\n--- End Skill ---`)
            .join("\n");
        }
      }
    }

    // Fallback: keyword matching
    return this.getSkillPrompts(taskInput, { exclude });
  }

  /**
   * Get matched skill summaries (name + description + path) for lazy loading.
   * Uses hybrid ranking: embeddings (API or local) → keyword fallback → list all.
   * Returns up to `limit` skills, sorted by relevance.
   */
  /**
   * @param {string} taskInput
   * @param {number} limit
   * @param {object|null} skillScope - { include: string[], exclude: string[] } from profile YAML
   */
  async getMatchedSkillSummaries(taskInput, limit = 10, skillScope = null) {
    if (!this.loaded) this.load();
    if (this.skills.size === 0) return [];

    // Skip skills for trivial/greeting inputs — no point wasting tokens
    const TRIVIAL = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|yep|nope|bye|good morning|good evening|gm|gn|sup|yo)\s*[!.?]*$/i;
    if (!taskInput || taskInput.trim().length < 8 || TRIVIAL.test(taskInput.trim())) return [];

    const home = process.env.HOME || process.env.USERPROFILE || "";
    const toSummary = (skill) => {
      const fullPath = skill.filePath || join(config.skillsDir, `${skill.name}.md`);
      const location = home && fullPath.startsWith(home) ? "~" + fullPath.slice(home.length) : fullPath;
      return { name: skill.name, description: skill.description, location };
    };

    // ── Skill scoping filter — profile-based tag matching ────────────────────
    // Match skill name + description + triggers against include/exclude tags
    const isInScope = (skill) => {
      if (!skillScope) return true; // no scoping = all skills
      const haystack = `${skill.name} ${skill.description} ${(skill.triggers || []).join(" ")}`.toLowerCase();
      // Exclude check first
      if (skillScope.exclude?.length > 0) {
        if (skillScope.exclude.some(tag => haystack.includes(tag.toLowerCase()))) return false;
      }
      // Include check — at least one include tag must match
      if (skillScope.include?.length > 0) {
        return skillScope.include.some(tag => haystack.includes(tag.toLowerCase()));
      }
      return true;
    };

    // 1. Embedding match — only return skills above similarity threshold
    const SKILL_MATCH_THRESHOLD = 0.25;
    const vectorsAvailable = Object.keys(this._skillVectors).length > 0;
    if (getEmbeddingProvider() && vectorsAvailable) {
      const queryVector = await this._generateEmbedding(taskInput);
      if (queryVector) {
        const scored = [];
        for (const [name, skill] of this.skills) {
          if (!isInScope(skill)) continue; // skip out-of-scope skills
          const cached = this._skillVectors[name];
          if (!cached?.vector) continue;
          const score = this._cosineSim(queryVector, cached.vector);
          if (score >= SKILL_MATCH_THRESHOLD) {
            scored.push({ skill, score });
          }
        }
        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, limit);
        if (top.length > 0) {
          console.log(`[SkillLoader] Matched ${top.length}/${this.skills.size} skills above threshold${skillScope ? ` (scoped: ${skillScope.include?.join(",") || "all"})` : ""}`);
          return top.map((s) => toSummary(s.skill));
        }
        console.log(`[SkillLoader] No skills above similarity threshold (${SKILL_MATCH_THRESHOLD})`);
        return [];
      }
    }

    // 2. Keyword fallback — only return actual matches, don't pad with unrelated skills
    const keywordMatched = this.matchSkills(taskInput).filter(isInScope);
    if (keywordMatched.length > 0) {
      const top = keywordMatched.slice(0, limit);
      console.log(`[SkillLoader] Keyword matched ${top.length} skills: [${top.map(s => s.name).join(", ")}]`);
      return top.map(toSummary);
    }

    // 3. No matches — return empty instead of dumping random skills
    return [];
  }

  // ── Sync keyword API (fallback) ───────────────────────────────────────────────

  /**
   * Match skills relevant to a given task/message.
   * Returns skill contents to inject into the system prompt.
   */
  matchSkills(taskInput) {
    if (!this.loaded) this.load();

    const input = taskInput.toLowerCase();
    const matched = [];

    for (const [name, skill] of this.skills) {
      const triggerMatch = skill.triggers.some((t) => input.includes(t));

      const descWords = skill.description.toLowerCase().split(/\s+/);
      const descMatch = descWords.some(
        (w) => w.length > 3 && input.includes(w)
      );

      if (triggerMatch || descMatch) {
        matched.push(skill);
      }
    }

    return matched;
  }

  /**
   * Get skill prompt text for matched skills (sync keyword version).
   */
  getSkillPrompts(taskInput, { exclude = [] } = {}) {
    const matched = this.matchSkills(taskInput).filter(s => !exclude.includes(s.name));
    if (matched.length === 0) return "";

    const sections = matched.map(
      (s) =>
        `\n--- Skill: ${s.name} ---\n${s.content}\n--- End Skill ---`
    );

    return `\n\n## Active Skills\n${sections.join("\n")}`;
  }

  /**
   * Get a skill by name or path. Supports:
   *   - Exact name: "coding"
   *   - Path: "skills/coding.md", "skills/webapp-testing/SKILL.md"
   *   - Partial path: "coding.md"
   * Returns full skill object or null.
   */
  getSkill(nameOrPath) {
    if (!this.loaded) this.load();
    // Direct name lookup
    if (this.skills.has(nameOrPath)) return this.skills.get(nameOrPath);

    // Strip path prefixes and .md extension for matching
    // Handles full absolute paths on any OS: /Users/.../skills/coding.md or C:\...\skills\coding.md → "coding"
    let normalized = basename(nameOrPath).replace(/\.md$/i, "");

    if (this.skills.has(normalized)) return this.skills.get(normalized);

    // Case-insensitive fallback
    const lower = normalized.toLowerCase();
    for (const [key, skill] of this.skills) {
      if (key.toLowerCase() === lower) return skill;
    }
    return null;
  }

  /**
   * List all loaded skills.
   */
  list() {
    if (!this.loaded) this.load();
    return [...this.skills.values()].map((s) => ({
      name: s.name,
      description: s.description,
      triggers: s.triggers,
    }));
  }

  /**
   * Reload skills from disk.
   */
  reload() {
    this.loaded = false;
    this.load();
  }
}

const skillLoader = new SkillLoader();
export default skillLoader;
