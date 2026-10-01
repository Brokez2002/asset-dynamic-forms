import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
 
const SEP = ' – ';
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };
 
const optionKey = (value) => String(value).split(' ')[0];
 
const getWorkspaceId = async () => {
const res = await api.asApp().requestJira(route`/rest/servicedeskapi/assets/workspace`);
if (!res.ok) throw new Error(`Workspace ${res.status}`);
return (await res.json()).values[0].workspaceId;
};
 
// AQL aus Konfiguration: Objekttyp + optionaler Filter
const buildAql = (cfg) => {
const base = `objectTypeId = ${cfg.objectTypeId}`;
const extra = String(cfg.aqlFilter || '').trim();
return extra ? `${base} AND (${extra})` : base;
};
 
const loadAssets = async (workspaceId, aql) => {
const result = [];
let startAt = 0;
const maxResults = 100;
while (true) {
const res = await api.asApp().requestJira(
route`/jsm/assets/workspace/${workspaceId}/v1/object/aql?startAt=${startAt}&maxResults=${maxResults}&includeAttributes=false`,
{ method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ qlQuery: aql }) }
);
if (!res.ok) throw new Error(`AQL ${res.status}: ${await res.text()}`);
const data = await res.json();
for (const o of data.values || []) result.push({ key: o.objectKey, label: o.label });
if (data.isLast || !(data.values || []).length) break;
startAt += maxResults;
}
return result;
};
 
const getContextIds = async (fieldId) => {
const res = await api.asApp().requestJira(route`/rest/api/3/field/${fieldId}/context`);
if (!res.ok) throw new Error(`Context ${res.status}: ${await res.text()}`);
return ((await res.json()).values || []).map((c) => c.id);
};
 
const loadOptions = async (fieldId, contextId) => {
const result = [];
let startAt = 0;
while (true) {
const res = await api.asApp().requestJira(
route`/rest/api/3/field/${fieldId}/context/${contextId}/option?startAt=${startAt}&maxResults=100`
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
 
// Optionen eines Feldkontexts mit den Assets abgleichen
const syncContext = async (fieldId, contextId, assets) => {
const options = await loadOptions(fieldId, contextId);
const byKey = new Map(options.map((o) => [optionKey(o.value), o]));
const assetKeys = new Set(assets.map((a) => a.key));
 
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
if (!assetKeys.has(optionKey(o.value)) && !o.disabled)
toUpdate.push({ id: o.id, value: o.value, disabled: true });
}
 
const base = route`/rest/api/3/field/${fieldId}/context/${contextId}/option`;
 
if (toCreate.length) {
const res = await api.asApp().requestJira(base, {
method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ options: toCreate })
});
if (!res.ok) throw new Error(`Create ${res.status}: ${await res.text()}`);
}
if (toUpdate.length) {
const res = await api.asApp().requestJira(base, {
method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ options: toUpdate })
});
if (!res.ok) throw new Error(`Update ${res.status}: ${await res.text()}`);
}
return { created: toCreate.length, updated: toUpdate.length };
};
 
export const doSync = async () => {
const configs = ((await kvs.get('configs')) || []).filter((c) => c.triggerField && c.objectTypeId);
if (!configs.length) {
console.log('[ADF] Sync: keine Konfiguration vorhanden');
return [];
}
 
const workspaceId = await getWorkspaceId();
const seenFields = new Set();
const results = [];
 
for (const cfg of configs) {
if (seenFields.has(cfg.triggerField)) {
console.warn(`[ADF] Sync: ${cfg.triggerField} wird schon von einer anderen Konfiguration gepflegt, ${cfg.id} übersprungen`);
continue;
}
seenFields.add(cfg.triggerField);
 
try {
const aql = buildAql(cfg);
const assets = await loadAssets(workspaceId, aql);
const contextIds = await getContextIds(cfg.triggerField);
let created = 0;
let updated = 0;
for (const ctx of contextIds) {
const r = await syncContext(cfg.triggerField, ctx, assets);
created += r.created;
updated += r.updated;
}
results.push({ config: cfg.id, field: cfg.triggerField, aql, assets: assets.length, created, updated });
} catch (e) {
console.error(`[ADF] Sync Fehler (${cfg.id}):`, e.message);
results.push({ config: cfg.id, error: e.message });
}
}
 
console.log(`[ADF] Sync: ${JSON.stringify(results)}`);
return results;
};
 
export const runSync = async () => {
try { await doSync(); } catch (e) { console.error('[ADF] Sync Fehler:', e.message); }
};
 
export const runSyncWeb = async () => {
try {
const results = await doSync();
return { statusCode: 200, headers: { 'Content-Type': ['application/json'] }, body: JSON.stringify(results) };
} catch (e) {
return { statusCode: 500, headers: { 'Content-Type': ['application/json'] }, body: JSON.stringify({ error: e.message }) };
}
};