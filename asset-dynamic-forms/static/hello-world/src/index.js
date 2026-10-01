import { uiModificationsApi } from '@forge/jira-bridge';
import { invoke } from '@forge/bridge';

const SELECT_FIELD = 'customfield_11966';

// Asset-Attributname -> Jira-Feld (kommt später aus der Admin-Konfiguration)
const MAPPING = [
  { attribute: 'plan_opex',   field: 'customfield_11963', type: 'number' },
  { attribute: 'plan_capex',  field: 'customfield_11964', type: 'number' },
  { attribute: 'change_ziel', field: 'customfield_11965', type: 'adf' }
];

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

const convert = (value, type) => {
  if (type === 'number') {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }
  if (type === 'adf') return toAdf(value ?? '');
  return value ?? '';
};

uiModificationsApi.onInit(() => {
  console.log('[ADF] UIM geladen');
}, () => []);

uiModificationsApi.onChange(
  async ({ api, change }) => {
    const { current } = change;
    if (!current || current.getId() !== SELECT_FIELD) return;

    const objectKey = current.getValue()?.value?.split(' ')[0];
    if (!objectKey) return;

        console.log('[ADF] Auswahl:', objectKey);
    let result;
    try {
      result = await invoke('getAssetByKey', { objectKey });
    } catch (e) {
      console.error('[ADF] invoke fehlgeschlagen:', e?.message || e);
      return;
    }
    console.log('[ADF] Asset:', JSON.stringify(result, null, 2));
    if (result.error) return;

    console.log('[ADF] Vorhandene Attribute:', Object.keys(result.attributes || {}));

    for (const m of MAPPING) {
      const raw = result.attributes?.[m.attribute];
      const value = convert(raw, m.type);
      console.log(`[ADF] ${m.attribute} -> ${m.field}: roh=${JSON.stringify(raw)} gesetzt=${JSON.stringify(value)}`);
      api.getFieldById(m.field)?.setValue(value);
    }
  },
  () => MAPPING.map((m) => m.field)
);

uiModificationsApi.onError(({ errors }) => {
  console.error('[ADF] Fehler:', JSON.stringify(errors, null, 2));
});