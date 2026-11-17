import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { kindOf, norm } from './fieldKinds';

const KEY_PATTERN = /^([A-Z][A-Z0-9]*-\d+)/;
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };
const DONE_PROPERTY = 'adf-writeback-done';
const ATTR_ERROR_KEY = /attribute-(\d+)$/;
const MAX_RETRIES = 5;

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

const escapeHtml = (s) =>
  String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

// Reference list value ("KEY – Name" options) -> object keys
const toReferenceKeys = (v) => {
  const opts = Array.isArray(v) ? v : v ? [v] : [];
  return opts
    .map((o) => {
      const mt = String(o && o.value !== undefined ? o.value : '').match(KEY_PATTERN);
      return mt ? mt[1] : null;
    })
    .filter(Boolean);
};

// ---------------------------------------------------------------------------
// Error notification to the users stored in the configuration (Jira "notify")
// ---------------------------------------------------------------------------
const notifyAccountIds = (cfg) =>
  (cfg.notifyUsers || [])
    .map((u) => (typeof u === 'string' ? u : u && u.accountId))
    .filter(Boolean);

const notifyErrors = async (issueKey, cfg, subject, lines) => {
  const ids = notifyAccountIds(cfg);
  if (!ids.length) return;

  const textBody = `${subject}\n\n${lines.map((l) => `- ${l}`).join('\n')}\n\nRequest: ${issueKey}`;
  const htmlBody =
    `<p><b>${escapeHtml(subject)}</b></p><ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` +
    `<p>Request: ${escapeHtml(issueKey)}</p>`;

  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/notify`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      subject: `[Asset Dynamic Forms] ${subject}`,
      textBody,
      htmlBody,
      to: {
        users: ids.map((accountId) => ({ accountId })),
        reporter: false,
        assignee: false,
        watchers: false,
        voters: false
      }
    })
  });
  if (!res.ok) console.error(`[ADF] ${issueKey}: notify failed ${res.status}: ${await res.text()}`);
  else console.log(`[ADF] ${issueKey}: error notification sent to ${ids.length} user(s)`);
};

// A failing notification must never break the trigger
const safeNotify = async (issueKey, cfg, subject, lines) => {
  try {
    await notifyErrors(issueKey, cfg, subject, lines);
  } catch (e) {
    console.error(`[ADF] ${issueKey}: notify error:`, e.message);
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
      refId: v.referencedObject ? String(v.referencedObject.id) : null,
      refKey: v.referencedObject ? v.referencedObject.objectKey : null
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
// Assets update with per-attribute fallback
// Invalid attributes (HTTP 400 with "...attribute-<id>" errors) are removed
// and the remaining attributes are sent again.
// ---------------------------------------------------------------------------
const updateAssetPartial = async (ws, objectId, objectTypeId, attributes, info) => {
  let remaining = attributes.slice();
  const failed = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (!remaining.length) return { updated: [], failed };

    const res = await api.asApp().requestJira(route`/jsm/assets/workspace/${ws}/v1/object/${objectId}`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ objectTypeId, attributes: remaining })
    });
    if (res.ok) return { updated: remaining, failed };

    const text = await res.text();
    if (res.status !== 400) throw new Error(`Update ${res.status}: ${text}`);

    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
    const errors = (body && body.errors) || {};

    const badIds = new Set();
    for (const key of Object.keys(errors)) {
      const mt = key.match(ATTR_ERROR_KEY);
      if (!mt) continue;
      const id = mt[1];
      if (badIds.has(id)) continue;
      badIds.add(id);
      const attr = remaining.find((a) => String(a.objectTypeAttributeId) === id);
      const i = info[id] || {};
      failed.push({
        attributeId: id,
        attribute: i.attribute || `Attribute ${id}`,
        field: i.fieldName || '-',
        value: attr ? (attr.objectAttributeValues || []).map((v) => v.value).join(', ') : '',
        reason: String(errors[key])
      });
    }

    // 400 without attribute-specific errors -> real error
    if (!badIds.size) throw new Error(`Update 400: ${text}`);

    console.warn(`[ADF] Skipping invalid attribute(s) ${Array.from(badIds).join(', ')}, retrying`);
    remaining = remaining.filter((a) => !badIds.has(String(a.objectTypeAttributeId)));
  }

  throw new Error(`Update failed after ${MAX_RETRIES} retries`);
};

// Internal comment (not visible to customers) listing the fields that were not written
const commentFailures = async (issueKey, objectKey, failed) => {
  if (!failed.length) return;

  const adf = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{
          type: 'text',
          text: `Write-back to ${objectKey}: the following field(s) could not be updated in Assets. All other fields were updated.`
        }]
      },
      {
        type: 'bulletList',
        content: failed.map((f) => ({
          type: 'listItem',
          content: [{
            type: 'paragraph',
            content: [
              { type: 'text', text: f.field, marks: [{ type: 'strong' }] },
              { type: 'text', text: ` → ${f.attribute}: value "${f.value}" – ${f.reason}` }
            ]
          }]
        }))
      },
      {
        type: 'paragraph',
        content: [{
          type: 'text',
          text: 'Please correct the value (it must exactly match an allowed value in Assets) and move the request into the write-back status again.'
        }]
      }
    ]
  };

  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      body: adf,
      properties: [{ key: 'sd.public.comment', value: { internal: true } }]
    })
  });
  if (!res.ok) console.error(`[ADF] ${issueKey}: comment failed ${res.status}: ${await res.text()}`);
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
  const info = {}; // attribute id -> names for comment and mail
  for (const m of wbMappings) {
    const def = ctx.defs.find((d) => d.name === m.attribute);
    if (!def || def.editable === false || def.system) continue;

    const current = ctx.valuesById.get(String(def.id)) || [];
    let newVals;
    let oldVals;

    if (m.refObjectTypeId) {
      newVals = toReferenceKeys(ctx.fields[m.field]);
      if (!newVals.length) continue;
      oldVals = current.map((x) => x.refKey).filter(Boolean);
    } else {
      newVals = toAssetValues(kindOfMapping(m), ctx.fields[m.field]);
      if (!newVals) continue;
      oldVals = current.map((x) => (x.value === null ? '' : String(x.value)));
    }

    if ([...oldVals].sort().join('|') === [...newVals].sort().join('|')) continue;

    console.log(
      `[ADF] ${ctx.objectKey}.${def.name}: ${JSON.stringify(oldVals)} -> ${JSON.stringify(newVals)} (from ${m.fieldName}${m.refObjectTypeId ? ', reference' : ''})`
    );
    updates.push({ objectTypeAttributeId: def.id, objectAttributeValues: newVals.map((value) => ({ value })) });
    info[String(def.id)] = { attribute: def.name, fieldName: m.fieldName };
  }

  if (!updates.length) {
    console.log(`[ADF] ${issueKey}: no changes for ${ctx.objectKey}`);
    return { objectKey: ctx.objectKey, updated: 0, failed: [] };
  }

  const { updated, failed } = await updateAssetPartial(ctx.ws, ctx.obj.id, cfg.objectTypeId, updates, info);

  console.log(`[ADF] ${issueKey}: ${updated.length} attribute(s) updated in ${ctx.objectKey}`);
  if (failed.length) {
    console.warn(`[ADF] ${issueKey}: ${failed.length} attribute(s) skipped: ${failed.map((f) => `${f.attribute} ("${f.value}")`).join(', ')}`);
    await commentFailures(issueKey, ctx.objectKey, failed);
    await safeNotify(
      issueKey,
      cfg,
      `Write-back ${issueKey} → ${ctx.objectKey}: ${failed.length} field(s) not updated`,
      failed
        .map((f) => `${f.field} → ${f.attribute}: value "${f.value}" – ${f.reason}`)
        .concat([`${updated.length} other attribute(s) were updated successfully.`])
    );
  }
  return { objectKey: ctx.objectKey, updated: updated.length, failed };
};

// ---------------------------------------------------------------------------
// Trigger: request created
// ---------------------------------------------------------------------------
export async function onCreate(event) {
  const issueKey = event && event.issue ? event.issue.key : null;
  if (!issueKey) return;
  let cfg = null;
  try {
    cfg = await findConfig(issueKey);
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
    if (cfg) await safeNotify(issueKey, cfg, `Write-back ${issueKey} failed`, [e.message]);
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

  let cfg = null;
  try {
    cfg = await findConfig(issueKey);
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

    // Only mark as done when everything was written; otherwise a new status change retries
    if (result && !(result.failed || []).length) await markDone(issueKey, result.objectKey);
  } catch (e) {
    console.error(`[ADF] Write-back error on status change (${issueKey}):`, e.message);
    if (cfg) await safeNotify(issueKey, cfg, `Write-back ${issueKey} failed`, [e.message]);
  }
}