import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';

const SEP = ' – ';
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };
const OPTION_BATCH = 1000;                      // options per create/update request
const AQL_PAGE = 500;                           // assets per AQL page
const BUCKET_SIZE = 800;                        // cached options per storage entry
const FULL_SYNC_EVERY_MS = 24 * 60 * 60 * 1000; // full sync (against Jira options) once a day
const LOCK_KEY = 'sync-lock';
const STATUS_KEY = 'sync-status';
const REQUEST_KEY = 'sync-request';
const MANAGED_KEY = 'sync-managed-fields';      // fields currently maintained by the sync
const LOCK_TTL_MS = 14 * 60 * 1000;
const NOT_IN_CONFIG = 'Not in any configuration';

// Options created by the app always look like "ABC-123 – Name".
// Only these are ever disabled by the app; manually created options are never touched.
const APP_OPTION = /^[A-Z][A-Z0-9]*-\d+ – /;
const isAppOption = (value) => APP_OPTION.test(String(value));

const optionKey = (value) => String(value).split(' ')[0];
const safe = (s) => String(s).replace(/[^a-zA-Z0-9:.-]/g, '-');
const stateKey = (f) => `syncstate:${safe(f)}`;
const metaKey = (f) => `optmeta:${safe(f)}`;
const bucketKey = (f, ctx, i) => `optcache:${safe(f)}:${safe(ctx)}:${i}`;

const bucketOf = (key, n) => {
  let h = 0;
  for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % n;
};

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// ---------------------------------------------------------------------------
// Readable errors
// ---------------------------------------------------------------------------

// Error for a field that no longer exists in Jira (HTTP 404)
const notFoundError = (fieldId) => {
  const e = new Error(`Field ${fieldId} no longer exists in Jira`);
  e.notFound = true;
  return e;
};

// "Create 400: {json}" -> "Create 400: <messages>" (no raw JSON on the admin page)
const shortError = (msg) => {
  const s = String(msg || '');
  const m = s.match(/^([A-Za-z]+ \d{3})(?: \([^)]*\))?: ([\s\S]*)$/);
  if (m) {
    try {
      const j = JSON.parse(m[2]);
      const parts = [].concat(j.errorMessages || [], Object.values(j.errors || {}));
      if (parts.length) return `${m[1]}: ${parts.join('; ')}`;
    } catch (e) { /* not JSON */ }
    return `${m[1]}: ${m[2].slice(0, 300)}`;
  }
  return s.slice(0, 300);
};

// One entry for the admin page: severity, field, configuration, message
const issue = (severity, t, message, extra = {}) =>
  Object.assign(
    {
      severity,
      field: t.field,
      fieldName: t.fieldName || t.field,
      config: t.config || null,
      configLabel: t.configLabel || NOT_IN_CONFIG,
      type: t.type,
      message,
      error: severity === 'error' ? message : undefined
    },
    extra
  );

// Fingerprint of an asset list (keys + labels) -> detects any change without reading the cache
const fingerprint = (assets) => {
  const s = assets
    .map((a) => `${a.key}|${a.label}`)
    .sort()
    .join('\n');
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = (h2 * 31 + c) >>> 0;
  }
  return `${assets.length}:${h1.toString(16)}:${h2.toString(16)}`;
};

const getWorkspaceId = async () => {
  const res = await api.asApp().requestJira(route`/rest/servicedeskapi/assets/workspace`);
  if (!res.ok) throw new Error(`Workspace ${res.status}`);
  return (await res.json()).values[0].workspaceId;
};

// AQL: object type + optional filter from the configuration
const buildAql = (objectTypeId, filter) => {
  const base = `objectTypeId = ${objectTypeId}`;
  const extra = String(filter || '').trim();
  return extra ? `${base} AND (${extra})` : base;
};

// Keys and labels of all matching assets (no attributes -> fast, no KVS usage)
const loadAssets = async (workspaceId, aql) => {
  const result = [];
  let startAt = 0;
  while (true) {
    const res = await api.asApp().requestJira(
      route`/jsm/assets/workspace/${workspaceId}/v1/object/aql?startAt=${startAt}&maxResults=${AQL_PAGE}&includeAttributes=false`,
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ qlQuery: aql }) }
    );
    if (!res.ok) throw new Error(`AQL ${res.status} (${aql}): ${await res.text()}`);
    const data = await res.json();
    const values = data.values || [];
    for (const o of values) result.push({ key: o.objectKey, label: o.label });
    if (data.isLast || !values.length) break;
    startAt += values.length;
  }
  return result;
};

const getContextIds = async (fieldId) => {
  const res = await api.asApp().requestJira(route`/rest/api/3/field/${fieldId}/context`);
  if (res.status === 404) throw notFoundError(fieldId);
  if (!res.ok) throw new Error(`Context ${res.status}: ${await res.text()}`);
  return ((await res.json()).values || []).map((c) => String(c.id));
};

const loadOptions = async (fieldId, contextId) => {
  const result = [];
  let startAt = 0;
  while (true) {
    const res = await api.asApp().requestJira(
      route`/rest/api/3/field/${fieldId}/context/${contextId}/option?startAt=${startAt}&maxResults=1000`
    );
    if (res.status === 404) throw notFoundError(fieldId);
    if (!res.ok) throw new Error(`Options ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const values = data.values || [];
    values.forEach((v) => result.push(v));
    if (data.isLast || !values.length) break;
    startAt += values.length;
  }
  return result;
};

// ---------------------------------------------------------------------------
// Option cache (asset key -> [optionId, optionText, disabled])
// ---------------------------------------------------------------------------
const writeCache = async (fieldId, ctx, options, oldN = 0) => {
  const n = Math.max(1, Math.ceil(options.length / BUCKET_SIZE));
  const buckets = Array.from({ length: n }, () => ({}));
  for (const o of options) {
    const k = optionKey(o.value);
    buckets[bucketOf(k, n)][k] = [String(o.id), o.value, !!o.disabled];
  }
  for (let i = 0; i < n; i++) await kvs.set(bucketKey(fieldId, ctx, i), buckets[i]);
  // Remove buckets that are no longer used
  for (let i = n; i < oldN; i++) await kvs.delete(bucketKey(fieldId, ctx, i));
  return n;
};

const readCache = async (fieldId, ctx, n) => {
  const map = new Map();
  for (let i = 0; i < n; i++) {
    const b = (await kvs.get(bucketKey(fieldId, ctx, i))) || {};
    Object.keys(b).forEach((k) => map.set(k, b[k]));
  }
  return map;
};

const patchCache = async (fieldId, ctx, n, entries) => {
  const byBucket = {};
  Object.keys(entries).forEach((k) => {
    const b = bucketOf(k, n);
    (byBucket[b] = byBucket[b] || {})[k] = entries[k];
  });
  for (const b of Object.keys(byBucket)) {
    const cur = (await kvs.get(bucketKey(fieldId, ctx, b))) || {};
    await kvs.set(bucketKey(fieldId, ctx, b), Object.assign(cur, byBucket[b]));
  }
};

// Remove cache, meta and state of a field from storage
const forgetField = async (fieldId) => {
  const meta = await kvs.get(metaKey(fieldId));
  for (const c of (meta && meta.contexts) || []) {
    for (let i = 0; i < (c.n || 0); i++) await kvs.delete(bucketKey(fieldId, c.ctx, i));
  }
  await kvs.delete(metaKey(fieldId));
  await kvs.delete(stateKey(fieldId));
};

// ---------------------------------------------------------------------------
// Full sync: compares against the real Jira options and rebuilds the cache
// ---------------------------------------------------------------------------
const fullSync = async (t, assets) => {
  const assetKeys = new Set(assets.map((a) => a.key));
  const counts = { assets: assets.length, created: 0, updated: 0, disabled: 0 };
  const oldMeta = (await kvs.get(metaKey(t.field))) || {};
  const oldN = new Map((oldMeta.contexts || []).map((c) => [String(c.ctx), c.n]));
  const contexts = [];

  for (const ctx of await getContextIds(t.field)) {
    const options = await loadOptions(t.field, ctx);
    const byKey = new Map(options.map((o) => [optionKey(o.value), o]));
    const activeAppCount = options.filter((o) => !o.disabled && isAppOption(o.value)).length;
    const toCreate = [];
    const toUpdate = [];

    for (const a of assets) {
      const wanted = `${a.key}${SEP}${a.label}`;
      const existing = byKey.get(a.key);
      if (!existing) toCreate.push({ value: wanted, disabled: false });
      else if (existing.value !== wanted || existing.disabled)
        toUpdate.push({ id: existing.id, value: wanted, disabled: false });
    }

    // Safety: never disable everything because of an empty AQL result
    if (!assets.length && activeAppCount) {
      console.warn(`[ADF] Sync ${t.field}: AQL returned 0 assets, deletions skipped`);
    } else {
      for (const o of options) {
        // Only app-created options ("KEY – Name") are disabled, manual options stay untouched
        if (!o.disabled && isAppOption(o.value) && !assetKeys.has(optionKey(o.value))) {
          toUpdate.push({ id: o.id, value: o.value, disabled: true });
          counts.disabled++;
        }
      }
    }

    const base = route`/rest/api/3/field/${t.field}/context/${ctx}/option`;
    for (const part of chunk(toCreate, OPTION_BATCH)) {
      const res = await api.asApp().requestJira(base, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ options: part }) });
      if (!res.ok) throw new Error(`Create ${res.status}: ${await res.text()}`);
    }
    for (const part of chunk(toUpdate, OPTION_BATCH)) {
      const res = await api.asApp().requestJira(base, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ options: part }) });
      if (!res.ok) throw new Error(`Update ${res.status}: ${await res.text()}`);
    }
    counts.created += toCreate.length;
    counts.updated += toUpdate.filter((u) => !u.disabled).length;

    const fresh = toCreate.length || toUpdate.length ? await loadOptions(t.field, ctx) : options;
    contexts.push({ ctx, n: await writeCache(t.field, ctx, fresh, oldN.get(String(ctx)) || 0) });
  }

  await kvs.set(metaKey(t.field), { contexts, at: new Date().toISOString() });
  return counts;
};

// ---------------------------------------------------------------------------
// Quick sync: only called when the fingerprint changed -> diff against cache
// ---------------------------------------------------------------------------
const quickSync = async (t, assets) => {
  const meta = await kvs.get(metaKey(t.field));
  if (!meta || !(meta.contexts || []).length) return null; // no cache yet -> full sync

  const assetKeys = new Set(assets.map((a) => a.key));
  const counts = { assets: assets.length, created: 0, updated: 0, disabled: 0 };

  let metaChanged = false;
  for (const c of meta.contexts) {
    const cache = await readCache(t.field, c.ctx, c.n);
    const activeAppCount = Array.from(cache.values()).filter((e) => !e[2] && isAppOption(e[1])).length;
    const toCreate = [];
    const toUpdate = [];
    const toDisable = [];

    for (const a of assets) {
      const wanted = `${a.key}${SEP}${a.label}`;
      const e = cache.get(a.key);
      if (!e) toCreate.push({ value: wanted, disabled: false });
      else if (e[1] !== wanted || e[2]) toUpdate.push({ id: e[0], value: wanted, disabled: false });
    }

    if (!assets.length && activeAppCount) {
      console.warn(`[ADF] Sync ${t.field}: AQL returned 0 assets, deletions skipped`);
    } else {
      for (const [k, e] of cache.entries()) {
        // Only app-created options are disabled
        if (!e[2] && isAppOption(e[1]) && !assetKeys.has(k)) toDisable.push({ id: e[0], value: e[1], disabled: true });
      }
    }

    const base = route`/rest/api/3/field/${t.field}/context/${c.ctx}/option`;
    const patches = {};
    let needReload = false;

    for (const part of chunk(toCreate, OPTION_BATCH)) {
      const res = await api.asApp().requestJira(base, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ options: part }) });
      if (res.status === 404) throw notFoundError(t.field);
      if (!res.ok) throw new Error(`Create ${res.status}: ${await res.text()}`);
      const createdOpts = ((await res.json()) || {}).options || [];
      if (createdOpts.length !== part.length) needReload = true;
      createdOpts.forEach((o) => { patches[optionKey(o.value)] = [String(o.id), o.value, false]; });
    }
    for (const part of chunk(toUpdate.concat(toDisable), OPTION_BATCH)) {
      const res = await api.asApp().requestJira(base, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ options: part }) });
      if (res.status === 404) throw notFoundError(t.field);
      if (!res.ok) throw new Error(`Update ${res.status}: ${await res.text()}`);
      part.forEach((u) => { patches[optionKey(u.value)] = [String(u.id), u.value, !!u.disabled]; });
    }
    counts.created += toCreate.length;
    counts.updated += toUpdate.length;
    counts.disabled += toDisable.length;

    if (needReload) {
      c.n = await writeCache(t.field, c.ctx, await loadOptions(t.field, c.ctx), c.n);
      metaChanged = true;
    } else if (Object.keys(patches).length) {
      await patchCache(t.field, c.ctx, c.n, patches);
    }
  }

  if (metaChanged) await kvs.set(metaKey(t.field), Object.assign(meta, { at: new Date().toISOString() }));
  return counts;
};

// ---------------------------------------------------------------------------
// Cleanup of fields that are no longer synced (mapping removed, config deleted,
// changed to a non-reference attribute or field deleted in Jira)
// ---------------------------------------------------------------------------

// One-time discovery of fields synced before this version (from stored sync state)
const discoverManagedFields = async () => {
  const fields = new Set();
  try {
    let cursor;
    do {
      let q = kvs.query().where('key', WhereConditions.beginsWith('syncstate:')).limit(100);
      if (cursor) q = q.cursor(cursor);
      const page = await q.getMany();
      (page.results || []).forEach((r) => {
        const m = String(r.key).match(/^syncstate:customfield-(\d+)$/);
        if (m) fields.add(`customfield_${m[1]}`);
      });
      cursor = page.nextCursor;
    } while (cursor);
  } catch (e) {
    console.warn('[ADF] Cleanup: could not discover synced fields:', e.message);
  }
  return Array.from(fields);
};

const cleanupField = async (fieldId) => {
  let disabled = 0;
  let kept = 0;
  for (const ctx of await getContextIds(fieldId)) {
    const options = await loadOptions(fieldId, ctx);
    const toDisable = [];
    for (const o of options) {
      if (o.disabled) continue;
      if (isAppOption(o.value)) toDisable.push({ id: o.id, value: o.value, disabled: true });
      else kept++;
    }
    const base = route`/rest/api/3/field/${fieldId}/context/${ctx}/option`;
    for (const part of chunk(toDisable, OPTION_BATCH)) {
      const res = await api.asApp().requestJira(base, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ options: part }) });
      if (!res.ok) throw new Error(`Cleanup ${res.status}: ${await res.text()}`);
    }
    disabled += toDisable.length;
  }
  await forgetField(fieldId);
  return { disabled, kept };
};

const cleanupOrphans = async (currentFields) => {
  let managed = await kvs.get(MANAGED_KEY);
  if (!Array.isArray(managed)) managed = await discoverManagedFields();

  const current = new Set(currentFields);
  const orphans = managed.filter((f) => !current.has(f));
  const results = [];

  for (const f of orphans) {
    const t = { field: f, fieldName: f, config: null, configLabel: NOT_IN_CONFIG, type: 'cleanup' };
    try {
      const r = await cleanupField(f);
      const msg = `No longer synced: ${r.disabled} app option(s) disabled, ${r.kept} manual option(s) kept.`;
      console.log(`[ADF] Cleanup ${f}: ${msg}`);
      results.push(issue('info', t, msg, { mode: 'cleanup', disabled: r.disabled }));
    } catch (e) {
      if (e.notFound) {
        // Field was deleted in Jira -> stop tracking it, nothing left to clean up
        await forgetField(f);
        const msg = 'Field was deleted in Jira and is no longer used by any configuration. Removed from sync.';
        console.log(`[ADF] Cleanup ${f}: ${msg}`);
        results.push(issue('info', t, msg, { mode: 'cleanup' }));
        continue;
      }
      const msg = `Cleanup failed, retried with the next run: ${shortError(e.message)}`;
      console.error(`[ADF] Cleanup error (${f}):`, e.message);
      results.push(issue('error', t, msg));
      current.add(f); // keep it managed so the cleanup is retried on the next run
    }
  }

  const next = Array.from(current).sort();
  if (JSON.stringify(next) !== JSON.stringify([...managed].sort())) await kvs.set(MANAGED_KEY, next);
  return results;
};

// ---------------------------------------------------------------------------
// Targets: trigger fields + select lists mapped to reference attributes
// ---------------------------------------------------------------------------
const configLabelOf = (cfg) => {
  const desk = cfg.serviceDeskName || `Service desk ${cfg.serviceDeskId || '-'}`;
  const rts = (cfg.requestTypeNames || cfg.requestTypeIds || []).join(', ') || '-';
  return `${desk} – ${rts}`;
};

const collectTargets = (configs) => {
  const targets = [];
  for (const cfg of configs) {
    const configLabel = configLabelOf(cfg);
    if (cfg.triggerField && cfg.objectTypeId) {
      targets.push({
        config: cfg.id,
        configLabel,
        field: cfg.triggerField,
        fieldName: cfg.triggerFieldName || cfg.triggerField,
        type: 'trigger',
        aql: buildAql(cfg.objectTypeId, cfg.aqlFilter)
      });
    }
    for (const m of cfg.mappings || []) {
      if (m.refObjectTypeId && (m.kind === 'select' || m.kind === 'multiselect')) {
        targets.push({
          config: cfg.id,
          configLabel,
          field: m.field,
          fieldName: m.fieldName || m.field,
          type: 'reference',
          aql: buildAql(m.refObjectTypeId, m.refAqlFilter)
        });
      }
    }
  }
  return targets;
};

const syncTarget = async (t, ws, mode) => {
  const started = Date.now();
  const state = await kvs.get(stateKey(t.field));
  const needFull =
    mode === 'full' || !state || state.aql !== t.aql || !state.lastFull ||
    started - state.lastFull > FULL_SYNC_EVERY_MS;

  const assets = await loadAssets(ws, t.aql);
  const fp = fingerprint(assets);

  // Nothing changed in Assets -> no cache read at all
  if (!needFull && state.fingerprint === fp) {
    await kvs.set(stateKey(t.field), Object.assign({}, state, { lastRun: started }));
    return { mode: 'unchanged', seconds: Math.round((Date.now() - started) / 1000), assets: assets.length, created: 0, updated: 0, disabled: 0 };
  }

  let used = 'full';
  let r = null;
  if (!needFull) {
    r = await quickSync(t, assets);
    used = 'quick';
  }
  if (!r) {
    r = await fullSync(t, assets);
    used = 'full';
  }

  await kvs.set(stateKey(t.field), {
    aql: t.aql,
    fingerprint: fp,
    lastRun: started,
    lastFull: used === 'full' ? started : state.lastFull
  });
  return Object.assign({ mode: used, seconds: Math.round((Date.now() - started) / 1000) }, r);
};

export const doSync = async (mode = 'quick') => {
  const configs = (await kvs.get('configs')) || [];
  const targets = collectTargets(configs);

  // Clean up fields that dropped out of the sync (also when no targets are left)
  const results = await cleanupOrphans(Array.from(new Set(targets.map((t) => t.field))));

  if (!targets.length) {
    console.log('[ADF] Sync: nothing to sync');
    return results;
  }

  const ws = await getWorkspaceId();
  const seen = new Map(); // field -> first target that syncs it

  for (const t of targets) {
    const first = seen.get(t.field);
    if (first) {
      if (first.aql !== t.aql) {
        // Same field with a different source/filter: only the first one is synced
        const msg =
          `Also mapped in "${first.configLabel}" (${first.config}) with a different AQL filter. ` +
          `Only that filter is used: ${first.aql}. Ignored here: ${t.aql}. ` +
          'Use the same AQL filter in both configurations.';
        console.warn(`[ADF] Sync ${t.field} (${t.config}): ${msg}`);
        results.push(issue('warning', t, msg));
      }
      continue;
    }
    seen.set(t.field, t);
    try {
      const r = await syncTarget(t, ws, mode);
      results.push(Object.assign({ config: t.config, configLabel: t.configLabel, field: t.field, fieldName: t.fieldName, type: t.type }, r));
      if (r.mode !== 'unchanged') {
        console.log(`[ADF] Sync ${t.field} (${r.mode}, ${t.config}): ${r.assets} assets, ${r.created} created, ${r.updated} updated, ${r.disabled} disabled, ${r.seconds}s`);
      }
    } catch (e) {
      const msg = e.notFound
        ? 'Field no longer exists in Jira. Open this configuration with Edit and click Save changes to remove it from the mapping.'
        : shortError(e.message);
      console.error(`[ADF] Sync error (${t.config}, ${t.field}):`, e.message);
      results.push(issue('error', t, msg));
    }
  }
  return results;
};

// One sync at a time, result is stored for the admin page.
// A pending full-sync request is only removed once this run actually holds the lock.
const runLocked = async (reason, mode, request = null) => {
  const lock = await kvs.get(LOCK_KEY);
  if (lock && Date.now() - lock.at < LOCK_TTL_MS) {
    console.log(`[ADF] Sync already running since ${new Date(lock.at).toISOString()}, skipped (${reason})`);
    return null; // request stays stored and is picked up by the next run
  }
  await kvs.set(LOCK_KEY, { at: Date.now(), reason });
  try {
    if (request) {
      // Only delete exactly this request; a newer one (e.g. saved during the run) stays
      const current = await kvs.get(REQUEST_KEY);
      if (current && current.at === request.at) await kvs.delete(REQUEST_KEY);
    }
    const results = await doSync(mode);
    // Only store a new status when something happened (saves storage traffic)
    const changed = (results || []).some((r) => r.severity || r.error || r.mode !== 'unchanged');
    if (changed || mode === 'full') {
      await kvs.set(STATUS_KEY, { running: false, at: new Date().toISOString(), reason, mode, results });
    }
    return results;
  } catch (e) {
    await kvs.set(STATUS_KEY, { running: false, at: new Date().toISOString(), reason, mode, error: shortError(e.message) });
    throw e;
  } finally {
    await kvs.delete(LOCK_KEY);
  }
};

// Request a full sync; it is picked up by the next scheduled run (max. 5 minutes)
export const requestSync = async (reason = 'manual') => {
  await kvs.set(REQUEST_KEY, { reason, at: Date.now() });
  console.log(`[ADF] Full sync requested (${reason})`);
  return { requested: true };
};

export const getSyncStatus = async () => {
  const status = (await kvs.get(STATUS_KEY)) || null;
  const request = await kvs.get(REQUEST_KEY);
  if (!request) return status;
  return Object.assign({}, status || {}, { requested: true, requestedAt: new Date(request.at).toISOString() });
};

// Fast lookup for the portal: asset keys -> option ids (reads one bucket per key)
export const lookupRefOptions = async (fieldId, keys) => {
  const result = {};
  const wanted = Array.from(new Set((keys || []).map(String)));
  if (!fieldId || !wanted.length) return result;

  const meta = await kvs.get(metaKey(fieldId));
  if (meta && (meta.contexts || []).length) {
    for (const c of meta.contexts) {
      const byBucket = {};
      wanted.filter((k) => !result[k]).forEach((k) => {
        const b = bucketOf(k, c.n);
        (byBucket[b] = byBucket[b] || []).push(k);
      });
      for (const b of Object.keys(byBucket)) {
        const map = (await kvs.get(bucketKey(fieldId, c.ctx, b))) || {};
        byBucket[b].forEach((k) => {
          const e = map[k];
          if (e && !e[2]) result[k] = e[0];
        });
      }
    }
    return result;
  }

  // Fallback without cache (slow for large lists)
  for (const ctx of await getContextIds(fieldId)) {
    for (const o of await loadOptions(fieldId, ctx)) {
      const k = optionKey(o.value);
      if (!o.disabled && wanted.includes(k) && !result[k]) result[k] = String(o.id);
    }
  }
  return result;
};

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

// Scheduled trigger (every 5 minutes): full sync if requested, otherwise quick sync
export const runSync = async () => {
  try {
    const request = await kvs.get(REQUEST_KEY);
    const mode = request ? 'full' : 'quick';
    await runLocked(request ? request.reason : 'schedule', mode, request);
  } catch (e) {
    console.error('[ADF] Sync error:', e.message);
  }
};

// Web trigger: only requests a full sync
export const runSyncWeb = async () => {
  try {
    await requestSync('webtrigger');
    return { statusCode: 202, headers: { 'Content-Type': ['application/json'] }, body: JSON.stringify({ requested: true }) };
  } catch (e) {
    return { statusCode: 500, headers: { 'Content-Type': ['application/json'] }, body: JSON.stringify({ error: e.message }) };
  }
};