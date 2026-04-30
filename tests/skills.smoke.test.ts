import { describe, expect, it } from "vitest";

import { SkillLoader } from "../src/skills/SkillLoader.js";
import { SkillRegistry } from "../src/skills/SkillRegistry.js";

const SKILLS_ROOT = new URL("../skills", import.meta.url).pathname;

describe("SkillLoader", () => {
  it("loads enabled skills, skips disabled and template", async () => {
    const loader = new SkillLoader(SKILLS_ROOT);
    const { loaded, skipped } = await loader.loadAll();

    // _template is hidden by leading underscore convention
    // example-pdf is the only real skill we shipped
    expect(loaded.map((s) => s.meta.id)).toContain("example-pdf");
    expect(loaded.map((s) => s.meta.id)).not.toContain("_template");

    // Skipped should be empty (no malformed skills shipped)
    expect(skipped).toEqual([]);
  });

  it("lazy-loads skill body only on demand", async () => {
    const loader = new SkillLoader(SKILLS_ROOT);
    const { loaded } = await loader.loadAll();
    const pdf = loaded.find((s) => s.meta.id === "example-pdf");
    expect(pdf).toBeDefined();

    const body = await pdf!.loadBody();
    expect(body).toContain("PDF Handling");
    expect(body).toContain("pdftotext");
  });
});

describe("SkillRegistry", () => {
  it("hides skills whose required tools are missing", async () => {
    const loader = new SkillLoader(SKILLS_ROOT);
    const { loaded } = await loader.loadAll();
    const reg = new SkillRegistry(loaded);

    const noTools = reg.visible({
      availableTools: new Set(),
      enabledIntegrations: new Set(),
    });
    expect(noTools.find((s) => s.meta.id === "example-pdf")).toBeUndefined();

    const withTools = reg.visible({
      availableTools: new Set(["read_file"]),
      enabledIntegrations: new Set(),
    });
    expect(withTools.find((s) => s.meta.id === "example-pdf")).toBeDefined();
  });

  it("matches skills by keyword + trigger", async () => {
    const loader = new SkillLoader(SKILLS_ROOT);
    const { loaded } = await loader.loadAll();
    const reg = new SkillRegistry(loaded);
    const filter = {
      availableTools: new Set(["read_file"]),
      enabledIntegrations: new Set<string>(),
    };

    const matches = reg.match("can you extract the pdf for me", filter);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.skill.meta.id).toBe("example-pdf");
    // Trigger hit ('pdf' is a trigger) should give it a higher score than 1.
    expect(matches[0]!.score).toBeGreaterThan(2);
  });

  it("returns no matches for unrelated queries", async () => {
    const loader = new SkillLoader(SKILLS_ROOT);
    const { loaded } = await loader.loadAll();
    const reg = new SkillRegistry(loaded);
    const filter = {
      availableTools: new Set(["read_file"]),
      enabledIntegrations: new Set<string>(),
    };

    const matches = reg.match("what's the weather in karachi", filter);
    expect(matches).toEqual([]);
  });
});
