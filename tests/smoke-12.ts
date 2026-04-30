/* eslint-disable no-console */
import Database from "better-sqlite3";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeEditFileTool } from "../src/tools/core/editFile.js";
import { MemoryStore } from "../src/memory/MemoryStore.js";
import { FilesystemGuard } from "../src/safety/FilesystemGuard.js";
import { BlockedActionError } from "../src/util/errors.js";
import type { ToolContext } from "../src/tools/types.js";

const ctx: ToolContext = {
  abortSignal: new AbortController().signal,
  taskId: "t",
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

async function main(): Promise<void> {
  // --- FilesystemGuard ---
  const guard = new FilesystemGuard({ mode: "moderate", dataDir: "/tmp/daemora-test-data" });

  const allowed = guard.ensureAllowed("/tmp/x.txt", "write");
  console.log("ok: /tmp allowed →", allowed);

  try {
    guard.ensureAllowed(`${process.env["HOME"]}/.ssh/id_rsa`, "read");
    console.log("FAIL: ~/.ssh read should be denied");
  } catch (e) {
    if (e instanceof BlockedActionError) console.log("ok: ~/.ssh blocked for read:", e.context["reason"]);
    else throw e;
  }

  try {
    guard.ensureAllowed("/tmp/daemora-test-data/daemora.db", "write");
    console.log("FAIL: dataDir write should be denied");
  } catch (e) {
    if (e instanceof BlockedActionError) console.log("ok: dataDir blocked for write:", e.context["reason"]);
    else throw e;
  }

  const r = guard.ensureAllowed("/tmp/daemora-test-data/daemora.db", "read");
  console.log("ok: dataDir read allowed →", r);

  try {
    guard.ensureCommandAllowed("cat /etc/shadow | head");
    console.log("FAIL: /etc write scan should be denied");
  } catch (e) {
    if (e instanceof BlockedActionError) console.log("ok: /etc blocked via command scan:", e.context["reason"]);
    else throw e;
  }

  // Strict mode
  const strict = new FilesystemGuard({ mode: "strict" });
  try {
    strict.ensureAllowed("/opt/code/x.ts", "read");
    console.log("FAIL: strict mode should deny /opt");
  } catch (e) {
    if (e instanceof BlockedActionError) console.log("ok: strict denies /opt:", e.context["reason"]);
    else throw e;
  }

  // --- MemoryStore ---
  const db = new Database(":memory:");
  const mem = new MemoryStore(db);
  const a = mem.save({ content: "Zain prefers pnpm over npm", tags: ["preference", "tooling"] });
  mem.save({ content: "We use Postgres 16 in prod", tags: ["infra", "database"] });
  mem.save({ content: "API v2 requires x-session header", tags: ["api"] });
  console.log("ok: saved 3 memories");

  const hits = mem.search("pnpm tooling preference");
  console.log("ok: recall for 'pnpm...' →", hits.length, "hits");
  if (hits[0]?.id !== a.id) console.log("FAIL: top hit should be 'pnpm' memory");
  else console.log("ok: top hit is the pnpm memory");

  const tagged = mem.search("use", { tagsAll: ["infra"] });
  console.log("ok: tag filter infra →", tagged.length, "hits, top content:", tagged[0]?.content);

  // --- edit_file ---
  const tool = makeEditFileTool(guard);
  const path = join(tmpdir(), `daemora-edit-test-${Date.now()}.txt`);
  await writeFile(path, "hello world\nfoo bar\nhello world\n", "utf-8");

  try {
    await tool.execute({ path, old_string: "hello world", new_string: "HI", replace_all: false }, ctx);
    console.log("FAIL: ambiguous edit should throw");
  } catch (e) {
    console.log("ok: ambiguous edit rejected:", (e as Error).message.slice(0, 60));
  }

  const res = await tool.execute({ path, old_string: "hello world", new_string: "HI", replace_all: true }, ctx);
  console.log("ok: replace_all made", res.replacements, "replacements");
  const after = await readFile(path, "utf-8");
  console.log("ok: file after replace_all →", JSON.stringify(after));

  try {
    await tool.execute({ path, old_string: "HI", new_string: "HI", replace_all: false }, ctx);
    console.log("FAIL: identical old/new should reject");
  } catch (e) {
    console.log("ok: identical old/new rejected:", (e as Error).message.slice(0, 60));
  }

  // edit under denied path
  try {
    await tool.execute({ path: "/etc/passwd", old_string: "root", new_string: "r", replace_all: false }, ctx);
    console.log("FAIL: edit /etc/passwd should be blocked");
  } catch (e) {
    if (e instanceof BlockedActionError) console.log("ok: edit /etc/passwd blocked:", e.context["reason"]);
    else throw e;
  }

  await unlink(path);
  console.log("\nALL #12 SMOKE TESTS PASSED");
}

main().catch((e) => { console.error(e); process.exit(1); });
