import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box, Stack, Inline, Heading, Text, Strong, Lozenge, Badge, Button, ButtonGroup,
  SectionMessage, DynamicTable, Select, Textfield, Toggle, Label, HelperMessage,
  Spinner, EmptyState, xcss
} from '@forge/react';
import { invoke } from '@forge/bridge';

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------
const norm = (s) =>
  String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

const opt = (x) => ({ label: x.name, value: String(x.id) });

const typeLabel = (t) => {
  const s = String(t || '');
  if (s.endsWith(':float') || s === 'number') return 'Zahl';
  if (s.endsWith(':textarea')) return 'Mehrzeiliger Text';
  if (s.endsWith(':textfield')) return 'Text';
  if (s.endsWith(':select')) return 'Auswahlliste';
  if (s === 'summary') return 'Zusammenfassung';
  if (s === 'description') return 'Beschreibung';
  return s.split(':').pop() || 'Unbekannt';
};

// Mapping berechnen: manuelle Einträge behalten, sonst Namensabgleich
const computeMapping = (flds, attrs, prev) => {
  const byNorm = new Map(attrs.map((a) => [norm(a.name), a]));
  const names = new Set(attrs.map((a) => a.name));
  const m = {};
  flds.forEach((f) => {
    const p = prev ? prev[f.id] : null;
    if (p && p.manual && (p.attribute === '' || names.has(p.attribute) || !attrs.length)) {
      m[f.id] = p;
      return;
    }
    const a = byNorm.get(norm(f.name));
    m[f.id] = { attribute: a ? a.name : '', writeback: !!(a && a.editable), manual: false };
  });
  return m;
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const pageStyle = xcss({ maxWidth: '1120px', paddingBlock: 'space.200' });

const cardStyle = xcss({
  backgroundColor: 'elevation.surface.raised',
  borderRadius: 'border.radius.200',
  boxShadow: 'elevation.shadow.raised',
  padding: 'space.300'
});

const footerStyle = xcss({
  backgroundColor: 'color.background.neutral.subtle',
  borderRadius: 'border.radius.200',
  borderColor: 'color.border',
  borderStyle: 'solid',
  borderWidth: 'border.width',
  padding: 'space.200'
});

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------
const Section = ({ step, title, description, aside, children }) => (
  <Box xcss={cardStyle}>
    <Stack space="space.200">
      <Inline spread="space-between" alignBlock="center">
        <Inline space="space.100" alignBlock="center">
          <Badge appearance="primary">{step}</Badge>
          <Heading as="h4">{title}</Heading>
        </Inline>
        {aside}
      </Inline>
      {description && <Text>{description}</Text>}
      {children}
    </Stack>
  </Box>
);

const Field = ({ id, label, helper, children }) => (
  <Stack space="space.050">
    <Label labelFor={id}>{label}</Label>
    {children}
    {helper && <HelperMessage>{helper}</HelperMessage>}
  </Stack>
);

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const App = () => {
  const [view, setView] = useState('list');
  const [editId, setEditId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);

  const [configs, setConfigs] = useState([]);
  const [desks, setDesks] = useState([]);
  const [schemas, setSchemas] = useState([]);

  const [desk, setDesk] = useState(null);
  const [requestTypes, setRequestTypes] = useState([]);
  const [selectedRts, setSelectedRts] = useState([]);
  const [fields, setFields] = useState([]);
  const [triggerField, setTriggerField] = useState(null);

  const [schema, setSchema] = useState(null);
  const [types, setTypes] = useState([]);
  const [objectType, setObjectType] = useState(null);
  const [attributes, setAttributes] = useState([]);
  const [aqlFilter, setAqlFilter] = useState('');

  const [mapping, setMapping] = useState({});

  useEffect(() => {
    setLoading(true);
    Promise.all([invoke('getConfigs'), invoke('getServiceDesks'), invoke('getObjectSchemas')])
      .then(([c, d, s]) => {
        setConfigs(c || []);
        setDesks(d || []);
        setSchemas(s || []);
      })
      .finally(() => setLoading(false));
  }, []);

  // -------------------------------------------------------------------------
  // Editor zurücksetzen / öffnen
  // -------------------------------------------------------------------------
  const resetEditor = () => {
    setDesk(null);
    setRequestTypes([]);
    setSelectedRts([]);
    setFields([]);
    setTriggerField(null);
    setSchema(null);
    setTypes([]);
    setObjectType(null);
    setAttributes([]);
    setAqlFilter('');
    setMapping({});
  };

  const startNew = () => {
    resetEditor();
    setEditId(null);
    setFlash(null);
    setView('edit');
  };

  const startEdit = async (cfg) => {
    resetEditor();
    setEditId(cfg.id);
    setFlash(null);
    setView('edit');
    setLoading(true);
    try {
      const d = desks.find((x) => String(x.id) === String(cfg.serviceDeskId));
      const deskOpt = d ? opt(d) : { label: `Service Desk ${cfg.serviceDeskId}`, value: String(cfg.serviceDeskId) };
      setDesk(deskOpt);

      const rts = (await invoke('getRequestTypes', { serviceDeskId: deskOpt.value })) || [];
      setRequestTypes(rts);
      const rtIds = (cfg.requestTypeIds || []).map(String);
      setSelectedRts(rts.filter((r) => rtIds.includes(String(r.id))).map(opt));

      const flds = (await invoke('getRequestTypeFields', { serviceDeskId: deskOpt.value, requestTypeIds: rtIds })) || [];
      setFields(flds);
      const trig = flds.find((f) => f.id === cfg.triggerField);
      setTriggerField(trig ? opt(trig) : null);

      const sch = schemas.find((s) => String(s.id) === String(cfg.schemaId));
      setSchema(sch ? opt(sch) : null);
      const ts = cfg.schemaId ? (await invoke('getObjectTypes', { schemaId: cfg.schemaId })) || [] : [];
      setTypes(ts);
      const t = ts.find((x) => String(x.id) === String(cfg.objectTypeId));
      setObjectType(t ? opt(t) : null);

      const at = cfg.objectTypeId ? (await invoke('getAttributes', { objectTypeId: cfg.objectTypeId })) || [] : [];
      setAttributes(at);
      setAqlFilter(cfg.aqlFilter || '');

      // Gespeicherte Zuordnung übernehmen, alles andere bleibt "nicht gemappt"
      const prev = {};
      flds.forEach((f) => {
        const em = (cfg.mappings || []).find((x) => x.field === f.id);
        prev[f.id] = em
          ? { attribute: em.attribute, writeback: !!em.writeback, manual: true }
          : { attribute: '', writeback: false, manual: true };
      });
      setMapping(prev);
    } finally {
      setLoading(false);
    }
  };

  const cancel = () => {
    resetEditor();
    setEditId(null);
    setView('list');
  };

  // -------------------------------------------------------------------------
  // Auswahl-Handler
  // -------------------------------------------------------------------------
  const onDesk = async (v) => {
    setDesk(v);
    setSelectedRts([]);
    setFields([]);
    setTriggerField(null);
    setMapping({});
    setRequestTypes(v ? (await invoke('getRequestTypes', { serviceDeskId: v.value })) || [] : []);
  };

  const onRts = async (v) => {
    const list = v || [];
    setSelectedRts(list);
    const flds = list.length
      ? (await invoke('getRequestTypeFields', { serviceDeskId: desk.value, requestTypeIds: list.map((r) => r.value) })) || []
      : [];
    setFields(flds);
    if (triggerField && !flds.find((f) => f.id === triggerField.value)) setTriggerField(null);
    setMapping(computeMapping(flds, attributes, mapping));
  };

  const onSchema = async (v) => {
    setSchema(v);
    setObjectType(null);
    setAttributes([]);
    setTypes(v ? (await invoke('getObjectTypes', { schemaId: v.value })) || [] : []);
  };

  const onType = async (v) => {
    setObjectType(v);
    const at = v ? (await invoke('getAttributes', { objectTypeId: v.value })) || [] : [];
    setAttributes(at);
    setMapping(computeMapping(fields, at, mapping));
  };

  const setRow = (fieldId, patch) =>
    setMapping((prev) => {
      const next = Object.assign({}, prev);
      next[fieldId] = Object.assign({}, prev[fieldId], patch, { manual: true });
      return next;
    });

  // -------------------------------------------------------------------------
  // Speichern / Löschen / Sync
  // -------------------------------------------------------------------------
  const mappableFields = fields.filter((f) => !triggerField || f.id !== triggerField.value);
  const mappedCount = mappableFields.filter((f) => mapping[f.id] && mapping[f.id].attribute).length;
  const writebackCount = mappableFields.filter((f) => mapping[f.id] && mapping[f.id].attribute && mapping[f.id].writeback).length;

  const missing = [];
  if (!desk) missing.push('Service-Projekt');
  if (!selectedRts.length) missing.push('Request Type');
  if (!schema || !objectType) missing.push('Objekttyp');
  if (!triggerField) missing.push('Auslöserfeld');
  const canSave = !missing.length && !busy;

  const save = async () => {
    setBusy(true);
    try {
      const d = desks.find((x) => String(x.id) === desk.value);
      const mappings = mappableFields
        .filter((f) => mapping[f.id] && mapping[f.id].attribute)
        .map((f) => ({
          field: f.id,
          fieldName: f.name,
          fieldType: f.type,
          attribute: mapping[f.id].attribute,
          writeback: !!mapping[f.id].writeback
        }));

      const result = await invoke('saveConfig', {
        id: editId || undefined,
        serviceDeskId: desk.value,
        serviceDeskName: desk.label,
        projectId: d ? d.projectId : undefined,
        requestTypeIds: selectedRts.map((r) => r.value),
        requestTypeNames: selectedRts.map((r) => r.label),
        triggerField: triggerField.value,
        triggerFieldName: triggerField.label,
        schemaId: schema.value,
        objectTypeId: objectType.value,
        objectTypeName: objectType.label,
        aqlFilter,
        mappings
      });
      setConfigs(result || []);
      setFlash({ appearance: 'success', title: 'Konfiguration gespeichert', text: `${mappings.length} Feld-Zuordnungen, davon ${mappings.filter((m) => m.writeback).length} mit Writeback.` });
      resetEditor();
      setEditId(null);
      setView('list');
    } catch (e) {
      setFlash({ appearance: 'error', title: 'Speichern fehlgeschlagen', text: String(e && e.message ? e.message : e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    setBusy(true);
    try {
      setConfigs((await invoke('deleteConfig', { id })) || []);
      setFlash({ appearance: 'information', title: 'Konfiguration gelöscht', text: 'Die zugehörigen Portal-Kontexte wurden entfernt.' });
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setBusy(true);
    try {
      const res = (await invoke('runSyncNow')) || [];
      const errors = res.filter((r) => r.error);
      const assets = res.reduce((s, r) => s + (r.assets || 0), 0);
      const created = res.reduce((s, r) => s + (r.created || 0), 0);
      const updated = res.reduce((s, r) => s + (r.updated || 0), 0);
      setFlash(errors.length
        ? { appearance: 'error', title: 'Synchronisierung mit Fehlern', text: errors.map((e) => `${e.config}: ${e.error}`).join(' | ') }
        : { appearance: 'success', title: 'Auswahllisten synchronisiert', text: `${assets} Assets geprüft, ${created} Optionen neu, ${updated} aktualisiert.` });
    } catch (e) {
      setFlash({ appearance: 'error', title: 'Synchronisierung fehlgeschlagen', text: String(e && e.message ? e.message : e) });
    } finally {
      setBusy(false);
    }
  };

  // -------------------------------------------------------------------------
  // Ansicht: Übersicht
  // -------------------------------------------------------------------------
  const deskName = (c) => {
    if (c.serviceDeskName) return c.serviceDeskName;
    const d = desks.find((x) => String(x.id) === String(c.serviceDeskId));
    return d ? d.name : `Service Desk ${c.serviceDeskId || '-'}`;
  };

  const listRows = configs.map((c) => {
    const maps = c.mappings || [];
    const wb = maps.filter((m) => m.writeback).length;
    const complete = c.objectTypeId && c.triggerField;
    return {
      key: c.id,
      cells: [
        {
          key: 'desk',
          content: (
            <Stack space="space.050">
              <Strong>{deskName(c)}</Strong>
              {!complete && <Lozenge appearance="moved">Unvollständig</Lozenge>}
            </Stack>
          )
        },
        { key: 'rts', content: <Text>{(c.requestTypeNames || c.requestTypeIds || []).join(', ') || '-'}</Text> },
        {
          key: 'source',
          content: (
            <Stack space="space.050">
              <Text>{c.objectTypeName || '-'}</Text>
              {c.aqlFilter ? <Lozenge appearance="new">AQL-Filter</Lozenge> : null}
            </Stack>
          )
        },
        { key: 'trigger', content: <Text>{c.triggerFieldName || c.triggerField || '-'}</Text> },
        {
          key: 'maps',
          content: (
            <Inline space="space.100" alignBlock="center">
              <Badge>{maps.length}</Badge>
              {wb ? <Lozenge appearance="success">{`${wb} Writeback`}</Lozenge> : <Lozenge>Nur lesen</Lozenge>}
            </Inline>
          )
        },
        {
          key: 'actions',
          content: (
            <ButtonGroup>
              <Button appearance="subtle" onClick={() => startEdit(c)} isDisabled={busy}>Bearbeiten</Button>
              <Button appearance="subtle" onClick={() => remove(c.id)} isDisabled={busy}>Löschen</Button>
            </ButtonGroup>
          )
        }
      ]
    };
  });

  const renderList = () => (
    <Box xcss={cardStyle}>
      {configs.length ? (
        <DynamicTable
          head={{
            cells: [
              { key: 'desk', content: 'Service-Projekt' },
              { key: 'rts', content: 'Request Types' },
              { key: 'source', content: 'Asset-Quelle' },
              { key: 'trigger', content: 'Auslöserfeld' },
              { key: 'maps', content: 'Zuordnungen' },
              { key: 'actions', content: '' }
            ]
          }}
          rows={listRows}
        />
      ) : (
        <EmptyState
          header="Noch keine Konfiguration"
          description="Lege fest, in welchen Portalformularen Werte aus Assets geladen und zurückgeschrieben werden."
          primaryAction={<Button appearance="primary" onClick={startNew}>Konfiguration anlegen</Button>}
        />
      )}
    </Box>
  );

  // -------------------------------------------------------------------------
  // Ansicht: Editor
  // -------------------------------------------------------------------------
  const attrOptions = [{ label: '– nicht zugeordnet –', value: '' }].concat(
    attributes.map((a) => ({ label: a.editable ? a.name : `${a.name} (schreibgeschützt)`, value: a.name }))
  );

  const mappingRows = mappableFields.map((f) => {
    const row = mapping[f.id] || { attribute: '', writeback: false, manual: false };
    const attr = attributes.find((a) => a.name === row.attribute);
    const canWrite = !!row.attribute && !!attr && attr.editable !== false;

    let status = <Lozenge>Nicht zugeordnet</Lozenge>;
    if (row.attribute && !row.manual) status = <Lozenge appearance="success">Automatisch</Lozenge>;
    else if (row.attribute) status = <Lozenge appearance="inprogress">Manuell</Lozenge>;

    return {
      key: f.id,
      cells: [
        {
          key: 'field',
          content: (
            <Stack space="space.025">
              <Strong>{f.name}</Strong>
              <Text>{f.id}</Text>
            </Stack>
          )
        },
        { key: 'type', content: <Lozenge>{typeLabel(f.type)}</Lozenge> },
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
            <Toggle
              id={`wb-${f.id}`}
              isChecked={canWrite && !!row.writeback}
              isDisabled={!canWrite}
              onChange={() => setRow(f.id, { writeback: !row.writeback })}
            />
          )
        },
        { key: 'status', content: status }
      ]
    };
  });

  const renderEditor = () => (
    <Stack space="space.300">
      <Section
        step="1"
        title="Portal und Request Types"
        description="In welchen Portalformularen soll die App aktiv sein?"
      >
        <Inline space="space.300" shouldWrap>
          <Box xcss={xcss({ width: '320px' })}>
            <Field id="desk" label="Service-Projekt">
              <Select id="desk" options={desks.map(opt)} value={desk} onChange={onDesk} placeholder="Projekt wählen" />
            </Field>
          </Box>
          <Box xcss={xcss({ width: '480px' })}>
            <Field id="rts" label="Request Types" helper="Mehrfachauswahl möglich. Die Felder aller gewählten Request Types werden zusammengeführt.">
              <Select id="rts" isMulti isDisabled={!desk} options={requestTypes.map(opt)} value={selectedRts} onChange={onRts} placeholder="Request Types wählen" />
            </Field>
          </Box>
        </Inline>
      </Section>

      <Section
        step="2"
        title="Asset-Quelle"
        description="Aus welchem Objekttyp in Assets kommen die Werte?"
      >
        <Inline space="space.300" shouldWrap>
          <Box xcss={xcss({ width: '320px' })}>
            <Field id="schema" label="Objektschema">
              <Select id="schema" options={schemas.map(opt)} value={schema} onChange={onSchema} placeholder="Schema wählen" />
            </Field>
          </Box>
          <Box xcss={xcss({ width: '320px' })}>
            <Field id="type" label="Objekttyp">
              <Select id="type" isDisabled={!schema} options={types.map(opt)} value={objectType} onChange={onType} placeholder="Objekttyp wählen" />
            </Field>
          </Box>
        </Inline>
        <Box xcss={xcss({ maxWidth: '660px' })}>
          <Field id="aql" label="Zusätzlicher AQL-Filter (optional)" helper="Schränkt ein, welche Objekte im Portal auswählbar sind.">
            <Textfield id="aql" value={aqlFilter} placeholder='z. B. Status = "Freigegeben"' onChange={(e) => setAqlFilter(e.target.value)} />
          </Field>
        </Box>
      </Section>

      <Section
        step="3"
        title="Auslöserfeld"
        description="Die Auswahlliste, über die Kunden das Asset wählen. Die Optionen pflegt die App automatisch."
      >
        <Box xcss={xcss({ width: '320px' })}>
          <Field id="trigger" label="Auswahlliste">
            <Select
              id="trigger"
              isDisabled={!fields.length}
              options={fields.filter((f) => String(f.type).endsWith(':select')).map(opt)}
              value={triggerField}
              onChange={setTriggerField}
              placeholder="Feld wählen"
            />
          </Field>
        </Box>
        {fields.length > 0 && !fields.some((f) => String(f.type).endsWith(':select')) && (
          <SectionMessage appearance="warning" title="Keine Auswahlliste im Formular">
            <Text>Nimm eine Einzelauswahlliste in das Anfrageformular auf, damit Kunden ein Asset wählen können.</Text>
          </SectionMessage>
        )}
      </Section>

      <Section
        step="4"
        title="Feld-Zuordnung"
        description="Gleichnamige Felder und Attribute werden automatisch zugeordnet. Jede Zeile lässt sich manuell ändern."
        aside={
          mappingRows.length ? (
            <Inline space="space.100">
              <Lozenge appearance="success">{`${mappedCount} zugeordnet`}</Lozenge>
              <Lozenge appearance="inprogress">{`${writebackCount} Writeback`}</Lozenge>
            </Inline>
          ) : null
        }
      >
        {mappingRows.length && attributes.length ? (
          <DynamicTable
            head={{
              cells: [
                { key: 'field', content: 'Formularfeld' },
                { key: 'type', content: 'Feldtyp' },
                { key: 'attr', content: 'Asset-Attribut' },
                { key: 'wb', content: 'Zurückschreiben' },
                { key: 'status', content: 'Status' }
              ]
            }}
            rows={mappingRows}
          />
        ) : (
          <SectionMessage appearance="information">
            <Text>Wähle Request Types und einen Objekttyp, um die Zuordnung zu sehen.</Text>
          </SectionMessage>
        )}
      </Section>

      <Box xcss={footerStyle}>
        <Inline spread="space-between" alignBlock="center">
          <Text>{missing.length ? `Noch offen: ${missing.join(', ')}` : 'Alle Pflichtangaben vollständig.'}</Text>
          <ButtonGroup>
            <Button appearance="subtle" onClick={cancel} isDisabled={busy}>Abbrechen</Button>
            <Button appearance="primary" onClick={save} isDisabled={!canSave}>
              {editId ? 'Änderungen speichern' : 'Konfiguration speichern'}
            </Button>
          </ButtonGroup>
        </Inline>
      </Box>
    </Stack>
  );

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------
  return (
    <Box xcss={pageStyle}>
      <Stack space="space.300">
        <Inline spread="space-between" alignBlock="center">
          <Stack space="space.050">
            <Heading as="h2">{view === 'edit' ? (editId ? 'Konfiguration bearbeiten' : 'Neue Konfiguration') : 'Asset Dynamic Forms'}</Heading>
            <Text>Befüllt Portalformulare mit Werten aus Assets und schreibt Änderungen zurück.</Text>
          </Stack>
          {view === 'list' && (
            <ButtonGroup>
              <Button onClick={syncNow} isDisabled={busy || !configs.length}>Auswahllisten jetzt synchronisieren</Button>
              <Button appearance="primary" onClick={startNew} isDisabled={busy}>Neue Konfiguration</Button>
            </ButtonGroup>
          )}
        </Inline>

        {flash && (
          <SectionMessage appearance={flash.appearance} title={flash.title}>
            <Text>{flash.text}</Text>
          </SectionMessage>
        )}

        {loading || busy ? (
          <Inline alignInline="center">
            <Spinner size="large" />
          </Inline>
        ) : null}

        {!loading && (view === 'list' ? renderList() : renderEditor())}
      </Stack>
    </Box>
  );
};

ForgeReconciler.render(<App />);
