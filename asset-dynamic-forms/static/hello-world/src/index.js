import { uiModificationsApi } from '@forge/jira-bridge';
import { invoke } from '@forge/bridge';

// Wert beginnt mit einem Asset-Key, z. B. "FOR-3286 – test 2"
const KEY_PATTERN = /^([A-Z][A-Z0-9]*-\d+)/;

// Alle Felder des Formulars, wird in onInit befüllt
let FORM_FIELDS = [];

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');

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

// Wert anhand des Jira-Feldtyps konvertieren; undefined = Feldtyp nicht unterstützt
const convert = (value, type = '') => {
  const empty = value === null || value === undefined || value === '';
  if (type.endsWith(':float') || type === 'number') {
    if (empty) return null;
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }
  if (type.endsWith(':textarea') || type === 'description') return toAdf(empty ? '' : value);
  if (type.endsWith(':textfield') || type === 'summary') return empty ? '' : String(value);
  return undefined;
};

uiModificationsApi.onInit(
  ({ api }) => {
    FORM_FIELDS = api.getFields().map((f) => ({
      id: f.getId(),
      name: f.getName?.(),
      type: f.getType?.(),
      norm: norm(f.getName?.())
    }));
    console.log('[ADF] Formularfelder:', JSON.stringify(FORM_FIELDS, null, 2));
  },
  () => []
);

uiModificationsApi.onChange(
  async ({ api, change }) => {
    const { current } = change;
    if (!current) return;

    const raw = current.getValue();
    const text = typeof raw === 'object' && raw !== null ? raw.value : raw;
    const match = typeof text === 'string' ? text.match(KEY_PATTERN) : null;
    if (!match) return;

    const objectKey = match[1];
    console.log(`[ADF] Auslöser ${current.getId()} -> Asset ${objectKey}`);

    let result;
    try {
      result = await invoke('getAssetByKey', { objectKey });
    } catch (e) {
      console.error('[ADF] invoke fehlgeschlagen:', e?.message || e);
      return;
    }
    if (result?.error) {
      console.error('[ADF] Asset-Fehler:', JSON.stringify(result));
      return;
    }

    const attrMap = new Map(
      Object.entries(result.attributes || {}).map(([name, value]) => [norm(name), value])
    );

    for (const f of FORM_FIELDS) {
      if (f.id === current.getId() || !attrMap.has(f.norm)) continue;
      const value = convert(attrMap.get(f.norm), f.type);
      if (value === undefined) {
        console.log(`[ADF] Übersprungen (Typ nicht unterstützt): ${f.name} (${f.type})`);
        continue;
      }
      console.log(`[ADF] ${f.name} <- ${JSON.stringify(attrMap.get(f.norm))}`);
      api.getFieldById(f.id)?.setValue(value);
    }
  },
  () => FORM_FIELDS.map((f) => f.id)
);

uiModificationsApi.onError(({ errors }) => {
  console.error('[ADF] Fehler:', JSON.stringify(errors, null, 2));
});