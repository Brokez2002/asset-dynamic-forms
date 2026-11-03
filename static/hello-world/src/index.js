import { uiModificationsApi } from '@forge/jira-bridge';
import { invoke } from '@forge/bridge';

const KEY_PATTERN = /^([A-Z][A-Z0-9]*-\d+)/;

let CONFIG = null;

const norm = (s) =>
  String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

const toAdf = (text) => ({
  version: 1,
  type: 'doc',
  content: text
    ? String(text).split('\n').map((line) => ({
        type: 'paragraph',
        content: line ? [{ type: 'text', text: line }] : []
      }))
    : []
});

// Fallback for older configs without "kind"
const legacyKind = (type = '') => {
  if (type.endsWith(':float') || type === 'number') return 'number';
  if (type.endsWith(':textarea') || type === 'description') return 'textarea';
  if (type.endsWith(':textfield') || type === 'summary' || type === 'string') return 'text';
  return 'unknown';
};

const findOption = (options, raw) => {
  if (raw === null || raw === undefined) return null;
  const n = norm(raw);
  return (options || []).find((o) => norm(o.label) === n || String(o.id) === String(raw)) || null;
};

const label = (x) => (x ? (x.display !== null && x.display !== undefined ? x.display : x.value) : null);
const raw = (x) => (x ? (x.value !== null && x.value !== undefined ? x.value : x.display) : null);

// Asset values -> setValue format; returns { value } or { skip: reason }
const convert = (m, kind, vals) => {
  const first = vals.length ? vals[0] : null;
  switch (kind) {
    case 'number': {
      const v = raw(first);
      if (v === null || v === '') return { value: null };
      const n = Number(v);
      return Number.isNaN(n) ? { skip: `not a number: ${v}` } : { value: n };
    }
    case 'textarea':
    case 'description':
      return { value: toAdf(label(first) || '') };
    case 'text':
    case 'summary':
      return { value: label(first) === null ? '' : String(label(first)) };
    case 'select':
    case 'priority': {
      if (!first) return { value: null };
      const o = findOption(m.options, label(first)) || findOption(m.options, raw(first));
      return o ? { value: String(o.id) } : { skip: `no option matches "${label(first)}"` };
    }
    case 'multiselect': {
      const ids = [];
      vals.forEach((x) => {
        const o = findOption(m.options, label(x)) || findOption(m.options, raw(x));
        if (o) ids.push(String(o.id));
        else console.warn(`[ADF] ${m.fieldName}: no option matches "${label(x)}"`);
      });
      return { value: ids };
    }
    case 'date': {
      const v = raw(first);
      return { value: v ? String(v).slice(0, 10) : null };
    }
    case 'datetime': {
      const v = raw(first);
      if (!v) return { value: null };
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? { skip: `invalid date/time: ${v}` } : { value: d.toISOString() };
    }
    case 'labels':
      return {
        value: vals.map((x) => String(label(x) || '').trim().replace(/\s+/g, '_')).filter(Boolean)
      };
    case 'user': {
      const v = raw(first);
      return { value: v ? String(v) : null };
    }
    default:
      return { skip: `field type "${kind}" is not filled live` };
  }
};

// Reference list: linked object keys -> option IDs of the synced select list
const convertReference = async (m, kind, vals) => {
  const keys = vals.map((v) => v.refKey).filter(Boolean);
  if (!keys.length) return { value: kind === 'multiselect' ? [] : null };

  let map = {};
  try {
    map = (await invoke('resolveRefOptions', { fieldId: m.field, keys })) || {};
  } catch (e) {
    return { skip: `resolveRefOptions failed: ${e && e.message ? e.message : e}` };
  }

  const ids = keys.map((k) => map[k]).filter(Boolean);
  const missing = keys.filter((k) => !map[k]);
  if (missing.length) console.warn(`[ADF] ${m.fieldName}: no synced option for ${missing.join(', ')} (run sync?)`);

  if (kind === 'multiselect') return { value: ids };
  return ids.length ? { value: ids[0] } : { skip: `no synced option for ${keys[0]}` };
};

const isLive = (m) => (m.mode || 'live') === 'live';

const ensureConfig = async (uiModifications) => {
  if (CONFIG) return CONFIG;
  const entry = (uiModifications || [])[0];
  let configId = null;
  try {
    configId = JSON.parse((entry && entry.data) || '{}').configId;
  } catch (e) {
    console.error('[ADF] UIM data not readable:', entry && entry.data);
  }
  if (!configId) {
    console.warn('[ADF] No configId in UIM data');
    return null;
  }
  CONFIG = await invoke('getConfigById', { configId });
  console.log('[ADF] Config loaded:', JSON.stringify(CONFIG));
  return CONFIG;
};

uiModificationsApi.onInit(
  async ({ uiModifications }) => {
    await ensureConfig(uiModifications);
  },
  () => []
);

uiModificationsApi.onChange(
  async ({ api, change, uiModifications }) => {
    const { current } = change;
    if (!current) return;

    const cfg = await ensureConfig(uiModifications);
    if (!cfg || current.getId() !== cfg.triggerField) return;

    const value = current.getValue();
    const text = value && typeof value === 'object' ? value.value : value;
    const match = typeof text === 'string' ? text.match(KEY_PATTERN) : null;
    if (!match) return;

    const objectKey = match[1];
    console.log(`[ADF] Trigger ${current.getId()} -> asset ${objectKey}`);

    let result;
    try {
      result = await invoke('getAssetByKey', { objectKey });
    } catch (e) {
      console.error('[ADF] invoke failed:', e && e.message ? e.message : e);
      return;
    }
    if (!result || result.error) {
      console.error('[ADF] Asset error:', JSON.stringify(result));
      return;
    }

    for (const m of (cfg.mappings || []).filter(isLive)) {
      const field = api.getFieldById(m.field);
      if (!field) {
        console.log(`[ADF] Not available in form: ${m.fieldName} (${m.field})`);
        continue;
      }
      const kind = m.kind || legacyKind((field.getType && field.getType()) || m.fieldType);
      const vals =
        (result.values && result.values[m.attribute]) ||
        (result.attributes && result.attributes[m.attribute] !== undefined
          ? [{ value: result.attributes[m.attribute], display: result.attributes[m.attribute] }]
          : []);

      const r = m.refObjectTypeId
        ? await convertReference(m, kind, vals)
        : convert(m, kind, vals);

      if (r.skip) {
        console.log(`[ADF] Skipped ${m.fieldName}: ${r.skip}`);
        continue;
      }
      console.log(`[ADF] ${m.fieldName} (${kind}${m.refObjectTypeId ? ', reference' : ''}) <- ${JSON.stringify(r.value)}`);
      field.setValue(r.value);
    }
  },
  () => (CONFIG ? (CONFIG.mappings || []).filter(isLive).map((m) => m.field) : [])
);

uiModificationsApi.onError(({ errors }) => {
  console.error('[ADF] Error:', JSON.stringify(errors, null, 2));
});