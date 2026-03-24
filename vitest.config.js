import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // Only run tests in our tests/ directory - not in agents/ subprojects
    include: ["tests/**/*.test.{js,ts}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.js"],
      exclude: [
        "src/cli.js",
        "src/index.js",
        "src/channels/**",
        "src/tools/tts.js",
      ],
    },
    // Run tests sequentially to avoid env-var cross-contamination
    pool: "forks",
    singleFork: true,
    // Timeout for async tests
    testTimeout: 10000,
  },
});
