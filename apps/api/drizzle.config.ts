import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./apps/api/src/db/schema.ts",
  out: "./apps/api/drizzle",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/daemora_dev",
  },
  verbose: true,
  strict: true,
});
