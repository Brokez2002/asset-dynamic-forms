import api, { route } from '@forge/api';
import Resolver from '@forge/resolver';

const UI_MODIFICATIONS_NAME = 'asset-dynamic-forms-portal';

const PORTAL_ID = '12';
const REQUEST_TYPE_ID = '1338';

const createUiModification = async (portalId, requestTypeId) => {
  const result = await api.asApp().requestJira(route`/rest/api/3/uiModifications`, {
    method: 'POST',
    body: JSON.stringify({
      name: UI_MODIFICATIONS_NAME,
      data: JSON.stringify({ requestTypeId }),
      contexts: [
        {
          portalId,
          requestTypeId,
          viewType: 'JSMRequestCreate'
        }
      ]
    }),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }
  });

  const body = await result.text();
  console.log(`UIM create status: ${result.status}`);
  console.log(`UIM create response: ${body}`);
  return result.status;
};

export async function run(event, context) {
  console.log('Creating UI modification context for JSM portal...');
  try {
    await createUiModification(PORTAL_ID, REQUEST_TYPE_ID);
  } catch (e) {
    console.error('Error creating UI modification:', e);
  }
}
const resolver = new Resolver();

const getWorkspaceId = async () => {
  const res = await api.asApp().requestJira(route`/rest/servicedeskapi/assets/workspace`);
  const text = await res.text();
  console.log(`[ADF] Workspace status: ${res.status} body: ${text}`);
  if (!res.ok) throw new Error(`Workspace ${res.status}`);
  return JSON.parse(text).values[0].workspaceId;
};

resolver.define('getAssetByKey', async ({ payload }) => {
  const { objectKey } = payload;
  const workspaceId = await getWorkspaceId();

  const res = await api.asApp().requestJira(
    route`/jsm/assets/workspace/${workspaceId}/v1/object/aql?includeAttributes=true`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
export const handler = resolver.getDefinitions();