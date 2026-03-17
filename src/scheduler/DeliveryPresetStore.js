/**
 * DeliveryPresetStore — CRUD for delivery presets (named tenant/channel groups).
 *
 * Presets let admin reuse delivery configurations across cron jobs.
 * e.g. "interns" → [TenantA:telegram, TenantB:telegram]
 *      "engineers" → [TenantC:slack, TenantD:discord]
 */

import { v4 as uuidv4 } from "uuid";
import { run, queryAll, queryOne } from "../storage/Database.js";

export function savePreset(preset) {
  const id = preset.id || uuidv4().slice(0, 8);
  const targets = typeof preset.targets === "string"
    ? preset.targets
    : JSON.stringify(preset.targets || []);

  run(
    `INSERT INTO delivery_presets (id, name, description, targets, created_at, updated_at)
     VALUES ($id, $name, $desc, $targets, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name=$name, description=$desc, targets=$targets, updated_at=datetime('now')`,
    {
      $id: id,
      $name: preset.name,
      $desc: preset.description || null,
      $targets: targets,
    }
  );
  return { id, ...preset };
}

export function loadPreset(id) {
  const row = queryOne("SELECT * FROM delivery_presets WHERE id = ?", id);
  return row ? _rowToPreset(row) : null;
}

export function loadPresetByName(name) {
  const row = queryOne("SELECT * FROM delivery_presets WHERE name = ? COLLATE NOCASE", name);
  return row ? _rowToPreset(row) : null;
}

export function listPresets() {
  return queryAll("SELECT * FROM delivery_presets ORDER BY name").map(_rowToPreset);
}

export function deletePreset(id) {
  run("DELETE FROM delivery_presets WHERE id = ?", id);
}

function _rowToPreset(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    targets: row.targets ? JSON.parse(row.targets) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
