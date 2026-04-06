/**
 * WatcherStore - SQLite persistence for named webhook watchers.
 *
 * Table: watchers (created in Database.js migration).
 * Follows GoalStore.js pattern: pure functions, import DB helpers.
 */
import { queryAll, queryOne, run } from "../storage/Database.js";

// ── Watchers ─────────────────────────────────────────────────────────────────

export function saveWatcher(watcher) {
  run(
    `INSERT INTO watchers (
      id, tenant_id, name, description, trigger_type,
      pattern, action, channel, channel_meta, destinations, context,
      enabled, last_triggered_at, trigger_count,
      cooldown_seconds, created_at, updated_at
    ) VALUES (
      $id, $tenantId, $name, $desc, $triggerType,
      $pattern, $action, $channel, $channelMeta, $destinations, $context,
      $enabled, $lastTriggeredAt, $triggerCount,
      $cooldownSeconds, $createdAt, $updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      tenant_id=$tenantId, name=$name, description=$desc, trigger_type=$triggerType,
      pattern=$pattern, action=$action, channel=$channel, channel_meta=$channelMeta,
      destinations=$destinations, context=$context,
      enabled=$enabled, last_triggered_at=$lastTriggeredAt, trigger_count=$triggerCount,
      cooldown_seconds=$cooldownSeconds, updated_at=$updatedAt`,
    {
      $id: watcher.id,
      $tenantId: watcher.tenantId || null,
      $name: watcher.name,
      $desc: watcher.description || null,
      $triggerType: watcher.triggerType || "webhook",
      $pattern: watcher.pattern ? JSON.stringify(watcher.pattern) : null,
      $action: watcher.action,
      $channel: watcher.channel || null,
      $channelMeta: watcher.channelMeta ? JSON.stringify(watcher.channelMeta) : null,
      $destinations: watcher.destinations?.length ? JSON.stringify(watcher.destinations) : null,
      $context: watcher.context || null,
      $enabled: watcher.enabled === false || watcher.enabled === 0 ? 0 : 1,
      $lastTriggeredAt: watcher.lastTriggeredAt || null,
      $triggerCount: watcher.triggerCount ?? 0,
      $cooldownSeconds: watcher.cooldownSeconds ?? 0,
      $createdAt: watcher.createdAt || new Date().toISOString(),
      $updatedAt: watcher.updatedAt || new Date().toISOString(),
    }
  );
}

export function loadWatcher(id) {
  const row = queryOne("SELECT * FROM watchers WHERE id = $id", { $id: id });
  return row ? _rowToWatcher(row) : null;
}

export function loadWatcherByName(name) {
  const row = queryOne(
    "SELECT * FROM watchers WHERE LOWER(name) = LOWER($name)",
    { $name: name }
  );
  return row ? _rowToWatcher(row) : null;
}

export function loadEnabledWatchers() {
  return queryAll(
    "SELECT * FROM watchers WHERE enabled = 1 ORDER BY name ASC"
  ).map(_rowToWatcher);
}

export function loadAllWatchers() {
  return queryAll(
    "SELECT * FROM watchers ORDER BY created_at DESC"
  ).map(_rowToWatcher);
}

export function deleteWatcher(id) {
  run("DELETE FROM watchers WHERE id = $id", { $id: id });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _rowToWatcher(row) {
  // Parse destinations; backwards-compat: build from legacy channel/channel_meta
  let destinations = null;
  if (row.destinations) {
    try { destinations = JSON.parse(row.destinations); } catch {}
  }
  if (!destinations && row.channel && row.channel !== "http" && row.channel !== "webhook") {
    const meta = row.channel_meta ? JSON.parse(row.channel_meta) : null;
    destinations = [{ channel: row.channel, channelMeta: meta }];
  }

  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    triggerType: row.trigger_type || "webhook",
    pattern: row.pattern ? JSON.parse(row.pattern) : null,
    action: row.action,
    channel: row.channel,
    channelMeta: row.channel_meta ? JSON.parse(row.channel_meta) : null,
    destinations: destinations || [],
    context: row.context || null,
    enabled: row.enabled ?? 1,
    lastTriggeredAt: row.last_triggered_at,
    triggerCount: row.trigger_count ?? 0,
    cooldownSeconds: row.cooldown_seconds ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
