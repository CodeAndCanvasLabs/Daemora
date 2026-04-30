/**
 * Side-effect-only module that loads `.env` from the current working
 * directory before any other module is evaluated. Imported FIRST from
 * src/cli/index.ts so ESM's import-order guarantee makes process.env
 * fully populated by the time downstream modules read top-level env
 * constants (e.g. ModelRouter's VERTEX_SA_KEY_PATH).
 *
 * Uses Node's built-in process.loadEnvFile (Node ≥ 20.6) — no dotenv
 * dependency. Failure is non-fatal: if the file is missing or
 * unreadable, callers are expected to function without env (or fall
 * back to the UI Settings page for configuration).
 */

try {
  process.loadEnvFile(".env");
} catch { /* no .env or unreadable — fine */ }
