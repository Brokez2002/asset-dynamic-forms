import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { kindOf, norm } from './fieldKinds';

const KEY_PATTERN = /^([A-Z][A-Z0-9]*-\d+)/;
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };
const DONE_PROPERTY = 'adf-writeback-done';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const adfToText = (node) => {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  const parts = (node.content || []).map(adfToText);
  return node.type === 'doc' ? parts.join('\n') : parts.join('');
};

const kindOfMapping = (m) => m.kind || kindOf(m.field, m.fieldType);
const modeOf = (cfg) => (cfg.writebackMode === 'onStatus' ? 'onStatus' : 'onCreate');
const fillModeOfMapping = (m) => m.mode || 'live';

const isEmptyValue = (v) =>
  v === null || v === undefined || v === '' ||
  (Array.isArray(v) && !v.length) ||
  (v && v.type === 'doc' && !(v.content || []).length);

const findOption = (options, raw) => {
  if (raw === null || raw === undefined) return null;
  const n = norm(raw);
  return (options || []).find((o) => norm(o.label) === n || String(o.id) === String(raw)) || null;
};

const getWorkspaceId = async () => {
  const res = await api.asApp().requestJira(route`/rest/servicedeskapi/assets/workspace`);
  if (!res.ok) throw new Error(`Workspace ${res.status}`);
  return (await res.json()).values[0].workspaceId;
};

const findConfig = async (issueKey) => {
  const configs = (await kvs.get('configs')) || [];
  if (!configs.length) return null;
  const reqRes = await api.asApp().requestJira(route`/rest/servicedeskapi/request/${issueKey}`);
  if (!reqRes.ok) return null;
  const req = await reqRes.json();
  return (
    configs.find(
      (c) =>
        String(c.serviceDeskId) === String(req.serviceDeskId) &&
        (c.requestTypeIds || []).map(String).includes(String(req.requestTypeId))
    ) || null
  );
};

const isDone = async (issueKey) => {
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/properties/${DONE_PROPERTY}`);
  return res.ok;
};

const markDone = async (issueKey, objectKey) => {
  await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/properties/${DONE_PROPERTY}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ objectKey, at: new Date().toISOString() })
  });
};

// Jira field value -> list of strings for Assets (null = skip)
const toAssetValues = (kind, v) => {
  if (isEmptyValue(v)) return null;
  switch (kind) {
    case 'textarea':
    case 'description':
      return [typeof v === 'object' ? adfToText(v) : String(v)];
    case 'select':
    case 'radio':
      return v.value !== undefined ? [String(v.value)] : null;
    case 'priority':
      return v.name ? [v.name] : null;
    case 'multiselect':
    case 'checkbox':
      return Array.isArray(v) ? v.map((x) => String(x.value)) : null;
    case 'labels':
      return Array.isArray(v) ? v.map(String) : null;
    case 'user':
      return v.accountId ? [v.accountId] : null;
    case 'multiuser':
      return Array.isArray(v) ? v.map((x) => x.accountId).filter(Boolean) : null;
    case 'cascading':
      return v.value ? [v.child && v.child.value ? `${v.value} > ${v.child.value}` : v.value] : null;
    case 'assets':
      return null;
    default:
      if (typeof v === 'object') return v.type === 'doc' ? [adfToText(v)] : null;
      return [String(v)];
  }
};

// ---------------------------------------------------------------------------
// Load request fields + selected asset
// ---------------------------------------------------------------------------
const loadContext = async (issueKey, cfg) => {
  const fieldIds = [cfg.triggerField].concat((cfg.mappings || []).map((m) => m.field)).join(',');
  const issueRes = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=${fieldIds}`);
  if (!issueRes.ok) throw new Error(`Issue ${issueRes.status}`);
  const fields = (await issueRes.json()).fields || {};

  const trig = fields[cfg.triggerField];
  const text = trig && typeof trig === 'object' ? trig.value : trig;
  const match = typeof text === 'string' ? text.match(KEY_PATTERN) : null;
  if (!match) return null;
  const objectKey = match[1];

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
  if (!obj) throw new Error(`Asset ${objectKey} not found`);

  const defRes = await api.asApp().requestJira(
    route`/jsm/assets/workspace/${ws}/v1/objecttype/${cfg.objectTypeId}/attributes`
  );
  const defs = await defRes.json();
  const idToName = new Map(defs.map((d) => [String(d.id), d.name]));

  const valuesById = new Map();
  const valuesByName = {};
  for (const a of obj.attributes || []) {
    const list = (a.objectAttributeValues || []).map((v) => ({
      value: v.value !== undefined && v.value !== null ? v.value : null,
      display: v.displayValue !== undefined && v.displayValue !== null ? v.displayValue : null,
      refId: v.referencedObject ? String(v.referencedObject.id) : null
    }));
    valuesById.set(String(a.objectTypeAttributeId), list);
    valuesByName[idToName.get(String(a.objectTypeAttributeId)) || String(a.objectTypeAttributeId)] = list;
  }

  return { fields, objectKey, obj, defs, ws, valuesById, valuesByName };
};

// ---------------------------------------------------------------------------
// Fill fields that the portal cannot fill live (set right after submit)
// ---------------------------------------------------------------------------
const prefillAfterSubmit = async (issueKey, cfg, ctx) => {
  const list = (cfg.mappings || []).filter((m) => fillModeOfMapping(m) === 'afterSubmit' && m.attribute);
  if (!list.length) return;

  const update = {};
  for (const m of list) {
    if (!isEmptyValue(ctx.fields[m.field])) {
      console.log(`[ADF] ${issueKey}: ${m.fieldName} already filled by customer, not overwritten`);
      continue;
    }
    const kind = kindOfMapping(m);
    const vals = m.attribute === '__self__' ? [] : ctx.valuesByName[m.attribute] || [];
    const label = (x) => (x ? (x.display !== null ? x.display : x.value) : null);
    const raw = (x) => (x ? (x.value !== null ? x.value : x.display) : null);
    let val;

    switch (kind) {
      case 'assets': {
        const ids = m.attribute === '__self__' ? [String(ctx.obj.id)] : vals.map((v) => v.refId).filter(Boolean);
        if (ids.length) val = ids.map((id) => ({ workspaceId: ctx.ws, id: `${ctx.ws}:${id}`, objectId: id }));
        break;
      }
      case 'radio': {
        const o = findOption(m.options, label(vals[0])) || findOption(m.options, raw(vals[0]));
        if (o) val = { id: o.id };
        break;
      }
      case 'checkbox': {
        const ids = vals
          .map((v) => findOption(m.options, label(v)) || findOption(m.options, raw(v)))
          .filter(Boolean)
          .map((o) => ({ id: o.id }));
        if (ids.length) val = ids;
        break;
      }
      case 'cascading': {
        const text = label(vals[0]);
        if (!text) break;
        const [parent, child] = String(text).split(/\s*>\s*/);
        const po = findOption(m.options, parent);
        if (po) {
          val = { id: po.id };
          if (child) {
            const co = findOption(po.children, child);
            if (co) val.child = { id: co.id };
          }
        }
        break;
      }
      case 'url': {
        const u = raw(vals[0]);
        if (u) val = String(u);
        break;
      }
      case 'multiuser': {
        const ids = vals.map((v) => v.value).filter(Boolean);
        if (ids.length) val = ids.map((accountId) => ({ accountId: String(accountId) }));
        break;
      }
      default:
        break;
    }

    if (val === undefined) {
      console.log(`[ADF] ${issueKey}: no value for ${m.fieldName} from "${m.attribute}"`);
      continue;
    }
    update[m.field] = val;
    console.log(`[ADF] ${issueKey}: ${m.fieldName} <- ${JSON.stringify(val)} (after submit)`);
  }

  if (!Object.keys(update).length) return;
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ fields: update })
  });
  if (!res.ok) console.error(`[ADF] ${issueKey}: after-submit update failed ${res.status}: ${await res.text()}`);
  else console.log(`[ADF] ${issueKey}: ${Object.keys(update).length} field(s) set after submit`);
};

// ---------------------------------------------------------------------------
// Write changed values back to the asset
// ---------------------------------------------------------------------------
const performWriteback = async (issueKey, cfg, ctx) => {
  const wbMappings = (cfg.mappings || []).filter(
    (m) => m.writeback && m.attribute && m.attribute !== '__self__' && kindOfMapping(m) !== 'assets'
  );
  if (!wbMappings.length) {
    console.log(`[ADF] ${issueKey}: no write-back fields in ${cfg.id}`);
    return null;
  }

  const updates = [];
  for (const m of wbMappings) {
    const def = ctx.defs.find((d) => d.name === m.attribute);
    if (!def || def.editable === false || def.system) continue;

    const newVals = toAssetValues(kindOfMapping(m), ctx.fields[m.field]);
    if (!newVals) continue;

    const oldVals = (ctx.valuesById.get(String(def.id)) || []).map((v) => (v.value === null ? '' : String(v.value)));
    if ([...oldVals].sort().join('|') === [...newVals].sort().join('|')) continue;

    console.log(`[ADF] ${ctx.objectKey}.${def.name}: ${JSON.stringify(oldVals)} -> ${JSON.stringify(newVals)} (from ${m.fieldName})`);
    updates.push({ objectTypeAttributeId: def.id, objectAttributeValues: newVals.map((value) => ({ value })) });
  }

  if (!updates.length) {
    console.log(`[ADF] ${issueKey}: no changes for ${ctx.objectKey}`);
    return { objectKey: ctx.objectKey, updated: 0 };
  }

  const upd = await api.asApp().requestJira(route`/jsm/assets/workspace/${ctx.ws}/v1/object/${ctx.obj.id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ objectTypeId: cfg.objectTypeId, attributes: updates })
  });
  const body = await upd.text();
  if (!upd.ok) throw new Error(`Update ${upd.status}: ${body}`);
  console.log(`[ADF] ${issueKey}: ${updates.length} attribute(s) updated in ${ctx.objectKey}`);
  return { objectKey: ctx.objectKey, updated: updates.length };
};

// ---------------------------------------------------------------------------
// Trigger: request created
// ---------------------------------------------------------------------------
export async function onCreate(event) {
  const issueKey = event && event.issue ? event.issue.key : null;
  if (!issueKey) return;
  try {
    const cfg = await findConfig(issueKey);
    if (!cfg) return;

    const maps = cfg.mappings || [];
    const hasAfterSubmit = maps.some((m) => fillModeOfMapping(m) === 'afterSubmit' && m.attribute);
    const doWriteback = modeOf(cfg) === 'onCreate' && maps.some((m) => m.writeback);
    if (!hasAfterSubmit && !doWriteback) return;

    const ctx = await loadContext(issueKey, cfg);
    if (!ctx) {
      console.log(`[ADF] ${issueKey}: no asset selected`);
      return;
    }
    if (hasAfterSubmit) await prefillAfterSubmit(issueKey, cfg, ctx);
    if (doWriteback) await performWriteback(issueKey, cfg, ctx);
  } catch (e) {
    console.error(`[ADF] Error on create (${issueKey}):`, e.message);
  }
}

// ---------------------------------------------------------------------------
// Trigger: request updated -> write-back on status change to a target status
// ---------------------------------------------------------------------------
export async function onUpdate(event) {
  const issueKey = event && event.issue ? event.issue.key : null;
  if (!issueKey) return;

  const items = (event.changelog && event.changelog.items) || [];
  const statusChange = items.find((i) => i.fieldId === 'status' || i.field === 'status');
  if (!statusChange) return;

  try {
    const cfg = await findConfig(issueKey);
    if (!cfg || modeOf(cfg) !== 'onStatus') return;

    const targets = (cfg.writebackStatusIds || []).map(String);
    if (!targets.includes(String(statusChange.to))) return;

    console.log(`[ADF] ${issueKey}: status -> ${statusChange.toString} (${statusChange.to}), write-back triggered`);
    if (await isDone(issueKey)) {
      console.log(`[ADF] ${issueKey}: write-back already done, skipped`);
      return;
    }

    const ctx = await loadContext(issueKey, cfg);
    if (!ctx) {
      console.log(`[ADF] ${issueKey}: no asset selected`);
      return;
    }
    const result = await performWriteback(issueKey, cfg, ctx);
    if (result) await markDone(issueKey, result.objectKey);
  } catch (e) {
    console.error(`[ADF] Write-back error on status change (${issueKey}):`, e.message);
  }
}
