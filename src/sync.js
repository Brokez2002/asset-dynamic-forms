import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';

const SEP = ' – ';
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };
const OPTION_BATCH = 1000;                      // options per create/update request
const AQL_PAGE = 500;                           // assets per AQL page
const BUCKET_SIZE = 800;                        // cached options per storage entry
const FULL_SYNC_EVERY_MS = 24 * 60 * 60 * 1000; // full sync at least once a day
const DELTA_BUFFER_MIN = 10;                    // overlap for delta syncs
const LOCK_KEY = 'sync-lock';
const STATUS_KEY = 'sync-status';
const REQUEST_KEY = 'sync-request';
const LOCK_TTL_MS = 14 * 60 * 1000;

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
const writeCache = async (fieldId, ctx, options) => {
  const n = Math.max(1, Math.ceil(options.length / BUCKET_SIZE));
  const buckets = Array.from({ length: n }, () => ({}));
  for (const o of options) {
    const k = optionKey(o.value);
    buckets[bucketOf(k, n)][k] = [String(o.id), o.value, !!o.disabled];
  }
  for (let i = 0; i < n; i++) await kvs.set(bucketKey(fieldId, ctx, i), buckets[i]);
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

// ---------------------------------------------------------------------------
// Full sync: all assets, all options, disables options of deleted assets
// ---------------------------------------------------------------------------
const fullSync = async (t, ws) => {
  const assets = await loadAssets(ws, t.aql);
  const assetKeys = new Set(assets.map((a) => a.key));
  const counts = { assets: assets.length, created: 0, updated: 0, disabled: 0 };
  const contexts = [];

  for (const ctx of await getContextIds(t.field)) {
    const options = await loadOptions(t.field, ctx);
    const byKey = new Map(options.map((o) => [optionKey(o.value), o]));
    const toCreate = [];
    const toUpdate = [];

    for (const a of assets) {
      const wanted = `${a.key}${SEP}${a.label}`;
      const existing = byKey.get(a.key);
      if (!existing) toCreate.push({ value: wanted, disabled: false });
      else if (existing.value !== wanted || existing.disabled)
        toUpdate.push({ id: existing.id, value: wanted, disabled: false });
    }
    for (const o of options) {
      if (!assetKeys.has(optionKey(o.value)) && !o.disabled) {
        toUpdate.push({ id: o.id, value: o.value, disabled: true });
        counts.disabled++;
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
    counts.updated += toUpdate.length - toUpdate.filter((u) => u.disabled).length;

    const fresh = toCreate.length || toUpdate.length ? await loadOptions(t.field, ctx) : options;
    contexts.push({ ctx, n: await writeCache(t.field, ctx, fresh) });
  }

  await kvs.set(metaKey(t.field), { contexts, at: new Date().toISOString() });
  return counts;
};

// ---------------------------------------------------------------------------
// Delta sync: only assets changed since the last run, compared against the cache
// ---------------------------------------------------------------------------
const deltaSync = async (t, ws, state) => {
  const meta = await kvs.get(metaKey(t.field));
  if (!meta || !(meta.contexts || []).length) return null;

  const minutes = Math.ceil((Date.now() - state.lastRun) / 60000) + DELTA_BUFFER_MIN;
  const assets = await loadAssets(ws, `(${t.aql}) AND Updated >= now(-${minutes}m)`);
  const counts = { assets: assets.length, created: 0, updated: 0, disabled: 0 };
  if (!assets.length) return counts;

  let metaChanged = false;
  for (const c of meta.contexts) {
    const cache = await readCache(t.field, c.ctx, c.n);
    const toCreate = [];
    const toUpdate = [];

    for (const a of assets) {
      const wanted = `${a.key}${SEP}${a.label}`;
      const e = cache.get(a.key);
      if (!e) toCreate.push({ value: wanted, disabled: false });
      else if (e[1] !== wanted || e[2]) toUpdate.push({ id: e[0], value: wanted, disabled: false });
    }

    const base = route`/rest/api/3/field/${t.field}/context/${c.ctx}/option`;
    const patches = {};
    let needReload = false;

    for (const part of chunk(toCreate, OPTION_BATCH)) {
      const res = await api.asApp().requestJira(base, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ options: part }) });
      if (!res.ok) throw new Error(`Create ${res.status}: ${await res.text()}`);
      const createdOpts = ((await res.json()) || {}).options || [];
      if (createdOpts.length !== part.length) needReload = true;
      createdOpts.forEach((o) => { patches[optionKey(o.value)] = [String(o.id), o.value, false]; });
    }
    for (const part of chunk(toUpdate, OPTION_BATCH)) {
      const res = await api.asApp().requestJira(base, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ options: part }) });
      if (!res.ok) throw new Error(`Update ${res.status}: ${await res.text()}`);
      part.forEach((u) => { patches[optionKey(u.value)] = [String(u.id), u.value, false]; });
    }
    counts.created += toCreate.length;
    counts.updated += toUpdate.length;

    if (needReload) {
      c.n = await writeCache(t.field, c.ctx, await loadOptions(t.field, c.ctx));
      metaChanged = true;
    } else if (Object.keys(patches).length) {
      await patchCache(t.field, c.ctx, c.n, patches);
    }
  }

  if (metaChanged) await kvs.set(metaKey(t.field), Object.assign(meta, { at: new Date().toISOString() }));
  return counts;
};

// ---------------------------------------------------------------------------
// Targets: trigger fields + select lists mapped to reference attributes
// ---------------------------------------------------------------------------
const collectTargets = (configs) => {
  const targets = [];
  for (const cfg of configs) {
    if (cfg.triggerField && cfg.objectTypeId) {
      targets.push({ config: cfg.id, field: cfg.triggerField, type: 'trigger', aql: buildAql(cfg.objectTypeId, cfg.aqlFilter) });
    }
    for (const m of cfg.mappings || []) {
      if (m.refObjectTypeId && (m.kind === 'select' || m.kind === 'multiselect')) {
        targets.push({ config: cfg.id, field: m.field, type: 'reference', aql: buildAql(m.refObjectTypeId, m.refAqlFilter) });
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

  let used = 'full';
  let r = null;
  if (!needFull) {
    r = await deltaSync(t, ws, state);
    used = 'delta';
  }
  if (!r) {
    r = await fullSync(t, ws);
    used = 'full';
  }

  await kvs.set(stateKey(t.field), {
    aql: t.aql,
    lastRun: started,
    lastFull: used === 'full' ? started : state.lastFull
  });
  return Object.assign({ mode: used, seconds: Math.round((Date.now() - started) / 1000) }, r);
};

export const doSync = async (mode = 'delta') => {
  const configs = (await kvs.get('configs')) || [];
  const targets = collectTargets(configs);
  if (!targets.length) {
    console.log('[ADF] Sync: nothing to sync');
    return [];
  }

  const ws = await getWorkspaceId();
  const seen = new Set();
  const results = [];

  for (const t of targets) {
    if (seen.has(t.field)) {
      console.warn(`[ADF] Sync: ${t.field} already synced by another mapping, skipped (${t.config})`);
      continue;
    }
    seen.add(t.field);
    try {
      const r = await syncTarget(t, ws, mode);
      results.push(Object.assign({ config: t.config, field: t.field, type: t.type }, r));
      console.log(`[ADF] Sync ${t.field} (${r.mode}): ${r.assets} assets, ${r.created} created, ${r.updated} updated, ${r.disabled} disabled, ${r.seconds}s`);
    } catch (e) {
      console.error(`[ADF] Sync error (${t.config}, ${t.field}):`, e.message);
      results.push({ config: t.config, field: t.field, error: e.message });
    }
  }
  return results;
};

// One sync at a time, result is stored for the admin page
const runLocked = async (reason, mode) => {
  const lock = await kvs.get(LOCK_KEY);
  if (lock && Date.now() - lock.at < LOCK_TTL_MS) {
    console.log(`[ADF] Sync already running since ${new Date(lock.at).toISOString()}, skipped (${reason})`);
    return null;
  }
  await kvs.set(LOCK_KEY, { at: Date.now(), reason });
  await kvs.set(STATUS_KEY, { running: true, startedAt: new Date().toISOString(), reason, mode });
  try {
    const results = await doSync(mode);
    await kvs.set(STATUS_KEY, { running: false, at: new Date().toISOString(), reason, mode, results });
    return results;
  } catch (e) {
    await kvs.set(STATUS_KEY, { running: false, at: new Date().toISOString(), reason, mode, error: e.message });
    throw e;
  } finally {
    await kvs.delete(LOCK_KEY);
  }
};

// Request a full sync; it is picked up by the next scheduled run (max. 5 minutes)
export const requestSync = async (reason = 'manual') => {
  await kvs.set(REQUEST_KEY, { reason, at: Date.now() });
  const status = (await kvs.get(STATUS_KEY)) || {};
  await kvs.set(STATUS_KEY, Object.assign({}, status, { requested: true, requestedAt: new Date().toISOString() }));
  console.log(`[ADF] Full sync requested (${reason})`);
  return { requested: true };
};

export const getSyncStatus = async () => (await kvs.get(STATUS_KEY)) || null;

// Fast lookup for the portal: asset keys -> option ids
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

// Scheduled trigger (every 5 minutes, up to 900 s): full sync if requested, otherwise delta
export const runSync = async () => {
  try {
    const request = await kvs.get(REQUEST_KEY);
    const mode = request ? 'full' : 'delta';
    if (request) await kvs.delete(REQUEST_KEY);
    await runLocked(request ? request.reason : 'schedule', mode);
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