import { defineConfig, configDefaults } from "vitest/config";

// Daemora's own test suite only. Without an explicit include, `vitest run`
// (and any positional filter containing the substring "tests") would scan the
// vendored competitor codebases under agents/** (n8n, openclaw, hermes), which
// are not ours to run and massively slow/pollute the run.
export default defineConfig({
  test: {
    include: [
      "tests/**/*.{test,spec}.ts",
      "apps/api/tests/**/*.{test,spec}.ts",
    ],
    exclude: [
      ...configDefaults.exclude,
      "agents/**",
      "ui/**",
      "**/dist/**",
    ],
  },
});
