import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
Heading, Text, Label, Select, Button, Stack, Inline, SectionMessage,
DynamicTable, Checkbox, Textfield
} from '@forge/react';
import { invoke } from '@forge/bridge';
 
const norm = (s) =>
String(s || '').toLowerCase().normalize('NFD')
.replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
 
const opt = (x) => ({ label: x.name, value: x.id });
 
const App = () => {
const [desks, setDesks] = useState([]);
const [desk, setDesk] = useState(null);
const [requestTypes, setRequestTypes] = useState([]);
const [selectedRts, setSelectedRts] = useState([]);
const [fields, setFields] = useState([]);
const [triggerField, setTriggerField] = useState(null);
 
const [schemas, setSchemas] = useState([]);
const [schema, setSchema] = useState(null);
const [types, setTypes] = useState([]);
const [objectType, setObjectType] = useState(null);
const [attributes, setAttributes] = useState([]);
const [aqlFilter, setAqlFilter] = useState('');
 
const [mapping, setMapping] = useState({});
const [configs, setConfigs] = useState([]);
const [msg, setMsg] = useState(null);
 
// Startdaten
useEffect(() => {
invoke('getServiceDesks').then(setDesks);
invoke('getObjectSchemas').then(setSchemas);
invoke('getConfigs').then(setConfigs);
}, []);
 
// Projekt -> Request Types
useEffect(() => {
setSelectedRts([]);
setRequestTypes([]);
if (desk) invoke('getRequestTypes', { serviceDeskId: desk.value }).then(setRequestTypes);
}, [desk]);
 
// Request Types -> Formularfelder
useEffect(() => {
setFields([]);
setTriggerField(null);
if (desk && selectedRts.length) {
invoke('getRequestTypeFields', {
serviceDeskId: desk.value,
requestTypeIds: selectedRts.map((r) => r.value)
}).then(setFields);
}
}, [desk, selectedRts]);
 
// Schema -> Objekttypen
useEffect(() => {
setObjectType(null);
setTypes([]);
if (schema) invoke('getObjectTypes', { schemaId: schema.value }).then(setTypes);
}, [schema]);
 
// Objekttyp -> Attribute
useEffect(() => {
setAttributes([]);
if (objectType) invoke('getAttributes', { objectTypeId: objectType.value }).then(setAttributes);
}, [objectType]);
 
// Vorschlag per Namensabgleich
useEffect(() => {
const byNorm = new Map(attributes.map((a) => [norm(a.name), a]));
const m = {};
for (const f of fields) {
const a = byNorm.get(norm(f.name));
m[f.id] = { attribute: a ? a.name : '', writeback: !!(a && a.editable) };
}
setMapping(m);
}, [fields, attributes]);
 
// Eine Zeile im Mapping ändern
const setRow = (fieldId, patch) =>
setMapping((prev) => {
const next = Object.assign({}, prev);
next[fieldId] = Object.assign({}, prev[fieldId], patch);
return next;
});
 
const attrOptions = [
{ label: '– nicht gemappt –', value: '' },
...attributes.map((a) => ({ label: a.name, value: a.name }))
];
 
const mappableFields = fields.filter((f) => f.id !== (triggerField && triggerField.value));
 
const rows = mappableFields.map((f) => {
const row = mapping[f.id] || { attribute: '', writeback: false };
const attr = attributes.find((a) => a.name === row.attribute);
return {
key: f.id,
cells: [
{ key: 'field', content: <Text>{f.name}</Text> },
{ key: 'id', content: <Text>{f.id}</Text> },
{
key: 'attr',
content: (
<Select
options={attrOptions}
value={attrOptions.find((o) => o.value === row.attribute)}
onChange={(v) => {
const val = v ? v.value : '';
const a = attributes.find((x) => x.name === val);
setRow(f.id, { attribute: val, writeback: !!(a && a.editable) });
}}
/>
)
},
{
key: 'wb',
content: (
<Checkbox
label="zurückschreiben"
isChecked={row.writeback}
isDisabled={!row.attribute || (attr && attr.editable === false)}
onChange={(e) => setRow(f.id, { writeback: e.target.checked })}
/>
)
}
]
};
});
 
const canSave = desk && selectedRts.length && triggerField && schema && objectType;
 
const save = async () => {
const d = desks.find((x) => x.id === desk.value);
const mappings = mappableFields
.filter((f) => mapping[f.id] && mapping[f.id].attribute)
.map((f) => ({
field: f.id,
fieldName: f.name,
fieldType: f.type,
attribute: mapping[f.id].attribute,
writeback: mapping[f.id].writeback
}));
 
const result = await invoke('saveConfig', {
serviceDeskId: d.id,
projectId: d.projectId,
requestTypeIds: selectedRts.map((r) => r.value),
triggerField: triggerField.value,
schemaId: schema.value,
objectTypeId: objectType.value,
objectTypeName: objectType.label,
aqlFilter,
mappings
});
setConfigs(result);
setMsg(`Konfiguration gespeichert (${mappings.length} Feld-Mappings)`);
};
 
const remove = async (id) => setConfigs(await invoke('deleteConfig', { id }));
 
return (
<Stack space="space.200">
<Heading as="h2">Asset Dynamic Forms – Konfiguration</Heading>
{msg && <SectionMessage appearance="success"><Text>{msg}</Text></SectionMessage>}
 
<Heading as="h3">1. Portal</Heading>
<Label labelFor="desk">Service-Projekt</Label>
<Select id="desk" options={desks.map(opt)} value={desk} onChange={setDesk} />
 
<Label labelFor="rts">Request Types</Label>
<Select id="rts" isMulti options={requestTypes.map(opt)}
value={selectedRts} onChange={(v) => setSelectedRts(v || [])} />
 
<Heading as="h3">2. Assets</Heading>
<Label labelFor="schema">Objektschema</Label>
<Select id="schema" options={schemas.map(opt)} value={schema} onChange={setSchema} />
 
<Label labelFor="type">Objekttyp</Label>
<Select id="type" options={types.map(opt)} value={objectType} onChange={setObjectType} />
 
<Label labelFor="aql">Zusätzlicher AQL-Filter (optional)</Label>
<Textfield id="aql" value={aqlFilter} placeholder='z. B. Status = "Freigegeben"'
onChange={(e) => setAqlFilter(e.target.value)} />
 
<Heading as="h3">3. Auslöserfeld</Heading>
<Label labelFor="trigger">Auswahlliste mit den Asset-Keys</Label>
<Select id="trigger"
options={fields.filter((f) => String(f.type).endsWith(':select')).map(opt)}
value={triggerField} onChange={setTriggerField} />
 
<Heading as="h3">4. Feld-Mapping</Heading>
{rows.length ? (
<DynamicTable
head={{
cells: [
{ key: 'field', content: 'Formularfeld' },
{ key: 'id', content: 'Feld-ID' },
{ key: 'attr', content: 'Asset-Attribut' },
{ key: 'wb', content: 'Writeback' }
]
}}
rows={rows}
/>
) : (
<Text>Wähle Request Types und einen Objekttyp, um das Mapping zu sehen.</Text>
)}
 
<Button appearance="primary" isDisabled={!canSave} onClick={save}>Speichern</Button>
 
<Heading as="h3">Gespeicherte Konfigurationen</Heading>
{configs.map((c) => (
<Inline key={c.id} space="space.100" alignBlock="center">
<Text>
{`${c.id} | RT ${(c.requestTypeIds || []).join(', ')} | ${c.objectTypeName || '-'} | ${(c.mappings || []).length} Mappings`}
</Text>
<Button appearance="subtle" onClick={() => remove(c.id)}>Löschen</Button>
</Inline>
))}
<Text>{JSON.stringify(configs)}</Text>
</Stack>
);
};
 
ForgeReconciler.render(<App />);