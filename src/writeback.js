import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';

const KEY_PATTERN = /^([A-Z][A-Z0-9]*-\d+)/;
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

// ADF (Textarea) -> Klartext
const adfToText = (node) => {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  const parts = (node.content || []).map(adfToText);
  return node.type === 'doc' ? parts.join('\n') : parts.join('');
};

// Jira-Feldwert -> String für Assets
const toAssetValue = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && v.type === 'doc') return adfToText(v);
  if (typeof v === 'object' && 'value' in v) return String(v.value);
  if (typeof v === 'object') return null;
  return String(v);
};

const getWorkspaceId = async () => {
  const res = await api.asApp().requestJira(route`/rest/servicedeskapi/assets/workspace`);
  if (!res.ok) throw new Error(`Workspace ${res.status}`);
  return (await res.json()).values[0].workspaceId;
};

export async function run(event) {
  const issueKey = event && event.issue ? event.issue.key : null;
  if (!issueKey) return;

  try {
    const configs = (await kvs.get('configs')) || [];
    if (!configs.length) return;

    // 1. Request Type und Portal des Vorgangs ermitteln
    const reqRes = await api.asApp().requestJira(route`/rest/servicedeskapi/request/${issueKey}`);
    if (!reqRes.ok) {
      console.log(`[ADF] ${issueKey}: kein JSM-Request (${reqRes.status}), nichts zu tun`);
      return;
    }
    const req = await reqRes.json();

    // 2. Passende Konfiguration finden
    const cfg = configs.find(
      (c) =>
        String(c.serviceDeskId) === String(req.serviceDeskId) &&
        (c.requestTypeIds || []).map(String).includes(String(req.requestTypeId))
    );
    if (!cfg) return;

    const wbMappings = (cfg.mappings || []).filter((m) => m.writeback);
    if (!wbMappings.length) {
      console.log(`[ADF] ${issueKey}: keine Writeback-Felder in ${cfg.id}`);
      return;
    }

    // 3. Feldwerte laden
    const fieldList = [cfg.triggerField].concat(wbMappings.map((m) => m.field)).join(',');
    const issueRes = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=${fieldList}`);
    if (!issueRes.ok) throw new Error(`Issue ${issueRes.status}`);
    const fields = (await issueRes.json()).fields || {};

    const trig = fields[cfg.triggerField];
    const text = trig && typeof trig === 'object' ? trig.value : trig;
    const match = typeof text === 'string' ? text.match(KEY_PATTERN) : null;
    if (!match) {
      console.log(`[ADF] ${issueKey}: kein Asset ausgewählt`);
      return;
    }
    const objectKey = match[1];

    // 4. Asset und Attributdefinitionen laden
    const ws = await getWorkspaceId();
    const objRes = await api.asApp().requestJira(
      route`/jsm/assets/workspace/${ws}/v1/object/aql?includeAttributes=true`,
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ qlQuery: `objectTypeId = ${cfg.objectTypeId} AND Key = "${objectKey}"` })
      }
    );
    if (!objRes.ok) throw new Error(`AQL ${objRes.status}: ${await objRes.text()}`);
    const obj = ((await objRes.json()).values || [])[0];
    if (!obj) throw new Error(`Asset ${objectKey} nicht gefunden`);

    const defRes = await api.asApp().requestJira(
      route`/jsm/assets/workspace/${ws}/v1/objecttype/${cfg.objectTypeId}/attributes`
    );
    const defs = await defRes.json();

    const currentById = new Map(
      (obj.attributes || []).map((a) => [
        String(a.objectTypeAttributeId),
        a.objectAttributeValues && a.objectAttributeValues.length ? a.objectAttributeValues[0].value : null
      ])
    );

    // 5. Geänderte Werte sammeln
    const updates = [];
    for (const m of wbMappings) {
      const def = defs.find((d) => d.name === m.attribute);
      if (!def || def.editable === false || def.system) continue;

      const newValue = toAssetValue(fields[m.field]);
      if (newValue === null) continue;

      const oldRaw = currentById.get(String(def.id));
      const oldValue = oldRaw === null || oldRaw === undefined ? null : String(oldRaw);
      if (oldValue === newValue) continue;

      console.log(`[ADF] ${objectKey}.${def.name}: "${oldValue}" -> "${newValue}" (aus ${m.fieldName})`);
      updates.push({ objectTypeAttributeId: def.id, objectAttributeValues: [{ value: newValue }] });
    }

    if (!updates.length) {
      console.log(`[ADF] ${issueKey}: keine Änderungen für ${objectKey}`);
      return;
    }

    // 6. Asset aktualisieren
    const upd = await api.asApp().requestJira(route`/jsm/assets/workspace/${ws}/v1/object/${obj.id}`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ objectTypeId: cfg.objectTypeId, attributes: updates })
    });
    const body = await upd.text();
    if (!upd.ok) throw new Error(`Update ${upd.status}: ${body}`);
    console.log(`[ADF] ${issueKey}: ${updates.length} Attribut(e) in ${objectKey} aktualisiert`);
  } catch (e) {
    console.error(`[ADF] Writeback Fehler (${issueKey}):`, e.message);
  }
}