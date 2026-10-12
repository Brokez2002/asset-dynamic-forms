import api, { route } from '@forge/api';
import Resolver from '@forge/resolver';
import { kvs } from '@forge/kvs';
import { doSync } from './sync';
 
const UIM_NAME = 'asset-dynamic-forms';
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };
 
// ---------------------------------------------------------------------------
// UI Modifications mit der gespeicherten Konfiguration abgleichen
// ---------------------------------------------------------------------------
export const syncUimContexts = async () => {
const configs = ((await kvs.get('configs')) || []).filter(
(c) => c.objectTypeId && c.serviceDeskId && (c.requestTypeIds || []).length
);
 
// 1. Bestehende UIM-Einträge der App löschen
const listRes = await api.asApp().requestJira(route`/rest/api/3/uiModifications?maxResults=100`);
if (!listRes.ok) throw new Error(`UIM list ${listRes.status}: ${await listRes.text()}`);
const existing = (await listRes.json()).values || [];
for (const u of existing) {
const del = await api.asApp().requestJira(route`/rest/api/3/uiModifications/${u.id}`, {
method: 'DELETE'
});
console.log(`[ADF] UIM gelöscht ${u.id} (${u.name}): ${del.status}`);
}
 
// 2. Pro Konfiguration einen UIM-Eintrag anlegen
let created = 0;
for (const c of configs) {
const res = await api.asApp().requestJira(route`/rest/api/3/uiModifications`, {
method: 'POST',
headers: JSON_HEADERS,
body: JSON.stringify({
name: `${UIM_NAME} ${c.id}`,
data: JSON.stringify({ configId: c.id }),
contexts: c.requestTypeIds.map((rt) => ({
portalId: String(c.serviceDeskId),
requestTypeId: String(rt),
viewType: 'JSMRequestCreate'
}))
})
});
const body = await res.text();
console.log(`[ADF] UIM angelegt für ${c.id}: ${res.status} ${body}`);
if (res.ok) created++;
}
 
const summary = { deleted: existing.length, created, configs: configs.length };
console.log(`[ADF] UIM-Sync: ${JSON.stringify(summary)}`);
return summary;
};
 
// Install-Trigger: Kontexte aus Konfiguration wiederherstellen
export async function run() {
console.log('[ADF] Installation: UIM-Kontexte aus Konfiguration wiederherstellen');
try {
await syncUimContexts();
} catch (e) {
console.error('[ADF] UIM-Sync Fehler:', e.message);
}
}
 
// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------
const resolver = new Resolver();
 
const getWorkspaceId = async () => {
const res = await api.asApp().requestJira(route`/rest/servicedeskapi/assets/workspace`);
const text = await res.text();
if (!res.ok) throw new Error(`Workspace ${res.status}: ${text}`);
return JSON.parse(text).values[0].workspaceId;
};
 
resolver.define('getAssetByKey', async ({ payload }) => {
const { objectKey } = payload;
const workspaceId = await getWorkspaceId();
 
const res = await api.asApp().requestJira(
route`/jsm/assets/workspace/${workspaceId}/v1/object/aql?includeAttributes=true`,
{
method: 'POST',
headers: JSON_HEADERS,
body: JSON.stringify({ qlQuery: `Key = "${objectKey}"` })
}
);
if (!res.ok) return { error: res.status, body: await res.text() };
 
const data = await res.json();
const obj = data.values?.[0];
if (!obj) return { error: 'NOT_FOUND' };
 
// Attributdefinitionen des Objekttyps laden (ID -> Name)
const defRes = await api.asApp().requestJira(
route`/jsm/assets/workspace/${workspaceId}/v1/objecttype/${obj.objectType.id}/attributes`
);
const defs = await defRes.json();
const idToName = Object.fromEntries(defs.map((d) => [d.id, d.name]));
 
const attributes = {};
for (const a of obj.attributes || []) {
const name = idToName[a.objectTypeAttributeId] ?? a.objectTypeAttributeId;
const v = a.objectAttributeValues?.[0];
attributes[name] = v?.value ?? v?.displayValue ?? null;
}
 
console.log(`[ADF] Attribute für ${objectKey}: ${JSON.stringify(attributes)}`);
return { objectId: obj.id, objectKey: obj.objectKey, label: obj.label, attributes };
});
 
resolver.define('getServiceDesks', async () => {
const res = await api.asApp().requestJira(route`/rest/servicedeskapi/servicedesk?limit=100`);
const data = await res.json();
return (data.values || []).map((s) => ({
id: s.id,
projectId: s.projectId,
name: `${s.projectName} (${s.projectKey})`
}));
});
 
resolver.define('getRequestTypes', async ({ payload }) => {
const res = await api.asApp().requestJira(
route`/rest/servicedeskapi/servicedesk/${payload.serviceDeskId}/requesttype?limit=100`
);
const data = await res.json();
return (data.values || []).map((r) => ({ id: r.id, name: r.name }));
});
 
resolver.define('getRequestTypeFields', async ({ payload }) => {
const { serviceDeskId, requestTypeIds } = payload;
const byId = new Map();
for (const rt of requestTypeIds) {
const res = await api.asApp().requestJira(
route`/rest/servicedeskapi/servicedesk/${serviceDeskId}/requesttype/${rt}/field`
);
if (!res.ok) {
console.error(`[ADF] Felder RT ${rt}: ${res.status}`);
continue;
}
const data = await res.json();
for (const f of data.requestTypeFields || []) {
if (!byId.has(f.fieldId)) {
byId.set(f.fieldId, {
id: f.fieldId,
name: f.name,
type: f.jiraSchema?.custom || f.jiraSchema?.system || f.jiraSchema?.type || ''
});
}
}
}
return Array.from(byId.values());
});
 
resolver.define('getObjectSchemas', async () => {
const ws = await getWorkspaceId();
const res = await api.asApp().requestJira(
route`/jsm/assets/workspace/${ws}/v1/objectschema/list?maxResults=100`
);
if (!res.ok) {
console.error(`[ADF] Schemas: ${res.status}`);
return [];
}
const data = await res.json();
return (data.values || []).map((s) => ({ id: s.id, name: `${s.name} (${s.objectSchemaKey})` }));
});
 
resolver.define('getObjectTypes', async ({ payload }) => {
const ws = await getWorkspaceId();
const res = await api.asApp().requestJira(
route`/jsm/assets/workspace/${ws}/v1/objectschema/${payload.schemaId}/objecttypes/flat`
);
if (!res.ok) {
console.error(`[ADF] Objekttypen: ${res.status}`);
return [];
}
const data = await res.json();
return (data || []).map((t) => ({ id: t.id, name: t.name }));
});
 
resolver.define('getAttributes', async ({ payload }) => {
const ws = await getWorkspaceId();
const res = await api.asApp().requestJira(
route`/jsm/assets/workspace/${ws}/v1/objecttype/${payload.objectTypeId}/attributes`
);
if (!res.ok) {
console.error(`[ADF] Attribute: ${res.status}`);
return [];
}
const defs = await res.json();
return defs
.filter((d) => !['Key', 'Created', 'Updated'].includes(d.name))
.map((d) => ({ id: d.id, name: d.name, editable: d.editable !== false && !d.system }));
});
 
// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------
resolver.define('getConfigs', async () => (await kvs.get('configs')) || []);
 
resolver.define('saveConfig', async ({ payload }) => {
const configs = (await kvs.get('configs')) || [];
const cfg = Object.assign({}, payload, { id: payload.id || `cfg-${Date.now()}` });
const idx = configs.findIndex((c) => c.id === cfg.id);
if (idx >= 0) configs.splice(idx, 1, cfg);
else configs.push(cfg);
await kvs.set('configs', configs);
try {
await syncUimContexts();
} catch (e) {
console.error('[ADF] UIM-Sync Fehler:', e.message);
}
return configs;
});
 
resolver.define('deleteConfig', async ({ payload }) => {
const configs = ((await kvs.get('configs')) || []).filter((c) => c.id !== payload.id);
await kvs.set('configs', configs);
try {
await syncUimContexts();
} catch (e) {
console.error('[ADF] UIM-Sync Fehler:', e.message);
}
return configs;
});
 
resolver.define('getConfigById', async ({ payload }) => {
const configs = (await kvs.get('configs')) || [];
return configs.find((c) => c.id === payload.configId) || null;
});
resolver.define('runSyncNow', async () => doSync());
export const handler = resolver.getDefinitions();