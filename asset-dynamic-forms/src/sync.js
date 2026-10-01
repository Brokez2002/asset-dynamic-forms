import api, { route } from '@forge/api';

const FIELD_ID = 'customfield_11966';
const AQL = 'objectType = "change"';
const SEP = ' – ';

const getWorkspaceId = async () => {
  const res = await api.asApp().requestJira(route`/rest/servicedeskapi/assets/workspace`);
  if (!res.ok) throw new Error(`Workspace ${res.status}`);
  return (await res.json()).values[0].workspaceId;
};

// Alle Assets per AQL laden (mit Paging)
const loadAssets = async (workspaceId) => {
  const result = [];
  let startAt = 0;
  const maxResults = 100;
  while (true) {
    const res = await api.asApp().requestJira(
      route`/jsm/assets/workspace/${workspaceId}/v1/object/aql?startAt=${startAt}&maxResults=${maxResults}&includeAttributes=false`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ qlQuery: AQL })
      }
    );
    if (!res.ok) throw new Error(`AQL ${res.status}: ${await res.text()}`);
    const data = await res.json();
    for (const o of data.values || []) result.push({ key: o.objectKey, label: o.label });
    if (data.isLast || !data.values?.length) break;
    startAt += maxResults;
  }
  return result;
};

const getContextId = async () => {
  const res = await api.asApp().requestJira(route`/rest/api/3/field/${FIELD_ID}/context`);
  if (!res.ok) throw new Error(`Context ${res.status}: ${await res.text()}`);
  return (await res.json()).values[0].id;
};

const loadOptions = async (contextId) => {
  const result = [];
  let startAt = 0;
  while (true) {
    const res = await api.asApp().requestJira(
      route`/rest/api/3/field/${FIELD_ID}/context/${contextId}/option?startAt=${startAt}&maxResults=100`
    );
    if (!res.ok) throw new Error(`Options ${res.status}: ${await res.text()}`);
    const data = await res.json();
    result.push(...(data.values || []));
    if (data.isLast || !data.values?.length) break;
    startAt += data.values.length;
  }
  return result;
};

const optionKey = (value) => String(value).split(' ')[0];

export const doSync = async () => {
  const workspaceId = await getWorkspaceId();
  const assets = await loadAssets(workspaceId);
  const contextId = await getContextId();
  const options = await loadOptions(contextId);

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

  const base = route`/rest/api/3/field/${FIELD_ID}/context/${contextId}/option`;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };

  if (toCreate.length) {
    const res = await api.asApp().requestJira(base, {
      method: 'POST', headers, body: JSON.stringify({ options: toCreate })
    });
    if (!res.ok) throw new Error(`Create ${res.status}: ${await res.text()}`);
  }
  if (toUpdate.length) {
    const res = await api.asApp().requestJira(base, {
      method: 'PUT', headers, body: JSON.stringify({ options: toUpdate })
    });
    if (!res.ok) throw new Error(`Update ${res.status}: ${await res.text()}`);
  }

  const summary = { assets: assets.length, created: toCreate.length, updated: toUpdate.length };
  console.log(`[ADF] Sync: ${JSON.stringify(summary)}`);
  return summary;
};

export const runSync = async () => {
  try { await doSync(); } catch (e) { console.error('[ADF] Sync Fehler:', e.message); }
};

export const runSyncWeb = async () => {
  try {
    const summary = await doSync();
    return { statusCode: 200, headers: { 'Content-Type': ['application/json'] }, body: JSON.stringify(summary) };
  } catch (e) {
    return { statusCode: 500, headers: { 'Content-Type': ['application/json'] }, body: JSON.stringify({ error: e.message }) };
  }
};