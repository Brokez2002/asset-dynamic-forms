import { uiModificationsApi } from '@forge/jira-bridge';
import { invoke } from '@forge/bridge';
 
const KEY_PATTERN = /^([A-Z][A-Z0-9]*-\d+)/;
 
let CONFIG = null;
 
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
 
// Wert anhand von Feld-ID bzw. Feldtyp konvertieren; undefined = Typ nicht unterstützt
const convert = (value, type = '', fieldId = '') => {
  const empty = value === null || value === undefined || value === '';
  if (fieldId === 'description' || type === 'description' || type.endsWith(':textarea')) {
    return toAdf(empty ? '' : value);
  }
  if (fieldId === 'summary' || type === 'summary' || type.endsWith(':textfield')) {
    return empty ? '' : String(value);
  }
  if (type.endsWith(':float') || type === 'number') {
    if (empty) return null;
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }
  return undefined;
};
 
// Konfiguration über die configId aus den UIM-Daten laden
const ensureConfig = async (uiModifications) => {
if (CONFIG) return CONFIG;
const entry = (uiModifications || [])[0];
let configId = null;
try {
configId = JSON.parse((entry && entry.data) || '{}').configId;
} catch (e) {
console.error('[ADF] UIM-Daten nicht lesbar:', entry && entry.data);
}
if (!configId) {
console.warn('[ADF] Keine configId in den UIM-Daten');
return null;
}
CONFIG = await invoke('getConfigById', { configId });
console.log('[ADF] Konfiguration geladen:', JSON.stringify(CONFIG));
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
 
const raw = current.getValue();
const text = raw && typeof raw === 'object' ? raw.value : raw;
const match = typeof text === 'string' ? text.match(KEY_PATTERN) : null;
if (!match) return;
 
const objectKey = match[1];
console.log(`[ADF] Auslöser ${current.getId()} -> Asset ${objectKey}`);
 
let result;
try {
result = await invoke('getAssetByKey', { objectKey });
} catch (e) {
console.error('[ADF] invoke fehlgeschlagen:', e && e.message ? e.message : e);
return;
}
if (!result || result.error) {
console.error('[ADF] Asset-Fehler:', JSON.stringify(result));
return;
}
 
for (const m of cfg.mappings || []) {
    const field = api.getFieldById(m.field);
    if (!field) {
    console.log(`[ADF] Übersprungen (Feld im Portal nicht verfügbar): ${m.fieldName}`);
    continue;
    }
    const type = (field.getType && field.getType()) || m.fieldType;
    const attrValue = result.attributes ? result.attributes[m.attribute] : undefined;
    const value = convert(attrValue, type, m.field);
    if (value === undefined) {
    console.log(`[ADF] Übersprungen (Typ nicht unterstützt): ${m.fieldName} (${type})`);
    continue;
    }
    console.log(`[ADF] ${m.fieldName} <- ${JSON.stringify(attrValue)}`);
    field.setValue(value);
}
},
() => (CONFIG ? (CONFIG.mappings || []).map((m) => m.field) : [])
);
 
uiModificationsApi.onError(({ errors }) => {
console.error('[ADF] Fehler:', JSON.stringify(errors, null, 2));
});