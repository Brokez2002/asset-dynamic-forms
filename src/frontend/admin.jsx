import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box, Stack, Inline, Heading, Text, Strong, Lozenge, Badge, Button, ButtonGroup,
  SectionMessage, DynamicTable, Select, Textfield, Toggle, Label, HelperMessage,
  Spinner, EmptyState, UserPicker,
  Modal, ModalBody, ModalFooter, ModalHeader, ModalTitle, ModalTransition,
  xcss
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { norm, kindOf, fillModeOf, OPTION_KINDS, KIND_LABELS } from '../fieldKinds';

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------
const opt = (x) => ({ label: x.name, value: String(x.id) });

const SELF = '__self__';
const LIST_KINDS = ['select', 'multiselect'];
const fieldKind = (f) => kindOf(f.id, f.type);
const isSupported = (f) => fillModeOf(fieldKind(f)) !== null;

// Select list mapped to a reference attribute -> options are synced from the referenced object type
const isRefList = (kind, attr) => LIST_KINDS.includes(kind) && !!attr && !!attr.isReference;

// UserPicker value(s) -> [{ accountId, name }]
const toNotifyUsers = (v) =>
  (Array.isArray(v) ? v : v ? [v] : [])
    .map((u) => (typeof u === 'string' ? { accountId: u, name: '' } : { accountId: u.id || u.accountId, name: u.name || u.displayName || '' }))
    .filter((u) => u.accountId);

// Compute mapping: keep manual entries, otherwise match by name
const computeMapping = (flds, attrs, prev) => {
  const byNorm = new Map(attrs.map((a) => [norm(a.name), a]));
  const names = new Set(attrs.map((a) => a.name).concat([SELF]));
  const m = {};
  flds.forEach((f) => {
    const p = prev ? prev[f.id] : null;
    if (p && p.manual && (p.attribute === '' || names.has(p.attribute) || !attrs.length)) {
      m[f.id] = p;
      return;
    }
    const kind = fieldKind(f);
    const a = isSupported(f) ? byNorm.get(norm(f.name)) : null;
    m[f.id] = {
      attribute: a ? a.name : '',
      writeback: !!(a && a.editable) && kind !== 'assets',
      refAqlFilter: '',
      manual: false
    };
  });
  return m;
};

// Write-back timing options
const MODE_OPTIONS = [
  { label: 'On submit (when the request is created)', value: 'onCreate' },
  { label: 'On status change (e.g. after approval)', value: 'onStatus' }
];
const modeOf = (c) => (c && c.writebackMode === 'onStatus' ? 'onStatus' : 'onCreate');

// ---------------------------------------------------------------------------
// Sync status: short summary + list of issues
// ---------------------------------------------------------------------------
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
const SEVERITY_LOZENGE = { error: 'removed', warning: 'moved', info: 'default' };

const syncIssues = (s) =>
  ((s && s.results) || [])
    .filter((r) => r.severity || r.error)
    .map((r) => ({
      severity: r.severity || 'error',
      field: r.field,
      fieldName: r.fieldName || r.field,
      config: r.config || null,
      configLabel: r.configLabel || (r.config ? '' : 'Not in any configuration'),
      message: r.message || r.error
    }))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

const syncSummary = (s) => {
  if (!s || (!s.at && !s.running)) return s && s.requested ? 'A full sync is requested and starts within 5 minutes.' : 'No sync has run yet.';
  if (s.running) return `Sync (${s.mode || 'quick'}) running since ${new Date(s.startedAt).toLocaleString()}…`;
  if (s.error) return `Last sync ${new Date(s.at).toLocaleString()} failed: ${s.error}`;
  const lists = (s.results || []).filter((r) => ['full', 'quick', 'unchanged'].includes(r.mode));
  const sum = (k) => lists.reduce((n, r) => n + (r[k] || 0), 0);
  const issues = syncIssues(s);
  const count = (sev) => issues.filter((i) => i.severity === sev).length;
  let t = `Last sync (${s.mode || 'quick'}) ${new Date(s.at).toLocaleString()}: ${lists.length} list${lists.length === 1 ? '' : 's'}, ${sum('assets')} assets checked, ${sum('created')} created, ${sum('updated')} updated, ${sum('disabled')} disabled.`;
  if (issues.length) t += ` ${count('error')} error(s), ${count('warning')} warning(s), ${count('info')} info.`;
  if (s.requested) t += ' A full sync is requested and starts within 5 minutes.';
  return t;
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const pageStyle = xcss({ maxWidth: '1180px', paddingBlock: 'space.200' });

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
// Building blocks
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
  const [editorKey, setEditorKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [syncStatus, setSyncStatus] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null); // config waiting for delete confirmation

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

  const [writebackMode, setWritebackMode] = useState('onCreate');
  const [statuses, setStatuses] = useState([]);
  const [selectedStatuses, setSelectedStatuses] = useState([]);
  const [notifyUsers, setNotifyUsers] = useState([]);

  const loadSyncStatus = async () => setSyncStatus((await invoke('getSyncStatus')) || null);

  useEffect(() => {
    setLoading(true);
    Promise.all([invoke('getConfigs'), invoke('getServiceDesks'), invoke('getObjectSchemas'), invoke('getSyncStatus')])
      .then((res) => {
        setConfigs(res[0] || []);
        setDesks(res[1] || []);
        setSchemas(res[2] || []);
        setSyncStatus(res[3] || null);
      })
      .finally(() => setLoading(false));
  }, []);

  const loadStatuses = async (deskValue, rtIds) => {
    if (!deskValue || !rtIds.length) return [];
    const d = desks.find((x) => String(x.id) === String(deskValue));
    if (!d || !d.projectId) return [];
    return (await invoke('getWorkflowStatuses', {
      serviceDeskId: deskValue,
      projectId: d.projectId,
      requestTypeIds: rtIds
    })) || [];
  };

  // -------------------------------------------------------------------------
  // Reset / open editor
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
    setWritebackMode('onCreate');
    setStatuses([]);
    setSelectedStatuses([]);
    setNotifyUsers([]);
  };

  const startNew = () => {
    resetEditor();
    setEditId(null);
    setEditorKey((k) => k + 1);
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
      const deskOpt = d ? opt(d) : { label: `Service desk ${cfg.serviceDeskId}`, value: String(cfg.serviceDeskId) };
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

      // Apply saved mapping, everything else stays "not mapped"
      const prev = {};
      flds.forEach((f) => {
        const em = (cfg.mappings || []).find((x) => x.field === f.id);
        prev[f.id] = em && isSupported(f)
          ? { attribute: em.attribute, writeback: !!em.writeback, refAqlFilter: em.refAqlFilter || '', manual: true }
          : { attribute: '', writeback: false, refAqlFilter: '', manual: true };
      });
      setMapping(prev);

      setWritebackMode(modeOf(cfg));
      const sts = await loadStatuses(deskOpt.value, rtIds);
      setStatuses(sts);
      const savedIds = (cfg.writebackStatusIds || []).map(String);
      setSelectedStatuses(sts.filter((s) => savedIds.includes(String(s.id))).map(opt));

      setNotifyUsers(toNotifyUsers(cfg.notifyUsers || []));
      setEditorKey((k) => k + 1); // re-mount UserPicker with the saved users
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
  // Selection handlers
  // -------------------------------------------------------------------------
  const onDesk = async (v) => {
    setDesk(v);
    setSelectedRts([]);
    setFields([]);
    setTriggerField(null);
    setMapping({});
    setStatuses([]);
    setSelectedStatuses([]);
    setRequestTypes(v ? (await invoke('getRequestTypes', { serviceDeskId: v.value })) || [] : []);
  };

  const onRts = async (v) => {
    const list = v || [];
    setSelectedRts(list);
    const rtIds = list.map((r) => r.value);
    const flds = list.length
      ? (await invoke('getRequestTypeFields', { serviceDeskId: desk.value, requestTypeIds: rtIds })) || []
      : [];
    setFields(flds);
    if (triggerField && !flds.find((f) => f.id === triggerField.value)) setTriggerField(null);
    setMapping(computeMapping(flds, attributes, mapping));

    const sts = await loadStatuses(desk.value, rtIds);
    setStatuses(sts);
    const ids = new Set(sts.map((s) => String(s.id)));
    setSelectedStatuses((prev) => prev.filter((s) => ids.has(s.value)));
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
  // Save / delete / sync
  // -------------------------------------------------------------------------
  const mappableFields = fields.filter((f) => !triggerField || f.id !== triggerField.value);
  const isMapped = (f) => isSupported(f) && mapping[f.id] && mapping[f.id].attribute;
  const mappedCount = mappableFields.filter(isMapped).length;
  const writebackCount = mappableFields.filter((f) => isMapped(f) && mapping[f.id].writeback).length;
  const attrByName = (name) => attributes.find((a) => a.name === name);

  const refWithoutType = mappableFields.filter((f) => {
    if (!isMapped(f)) return false;
    const a = attrByName(mapping[f.id].attribute);
    return isRefList(fieldKind(f), a) && !a.refObjectTypeId;
  });

  const missing = [];
  if (!desk) missing.push('Service project');
  if (!selectedRts.length) missing.push('Request type');
  if (!schema || !objectType) missing.push('Object type');
  if (!triggerField) missing.push('Trigger field');
  if (writebackCount && writebackMode === 'onStatus' && !selectedStatuses.length) missing.push('Target status');
  const canSave = !missing.length && !busy;

  const save = async () => {
    setBusy(true);
    try {
      const d = desks.find((x) => String(x.id) === desk.value);
      const mappings = mappableFields
        .filter(isMapped)
        .map((f) => {
          const kind = fieldKind(f);
          const a = attrByName(mapping[f.id].attribute);
          const ref = isRefList(kind, a);
          return {
            field: f.id,
            fieldName: f.name,
            fieldType: f.type,
            kind,
            mode: fillModeOf(kind),
            attribute: mapping[f.id].attribute,
            writeback: kind !== 'assets' && mapping[f.id].attribute !== SELF && !!mapping[f.id].writeback,
            refObjectTypeId: ref ? a.refObjectTypeId || null : null,
            refAqlFilter: ref ? String(mapping[f.id].refAqlFilter || '').trim() : '',
            options: !ref && OPTION_KINDS.includes(kind) ? f.options || [] : []
          };
        });

      const onStatus = writebackMode === 'onStatus';
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
        mappings,
        writebackMode,
        writebackStatusIds: onStatus ? selectedStatuses.map((s) => s.value) : [],
        writebackStatusNames: onStatus ? selectedStatuses.map((s) => s.label) : [],
        notifyUsers
      });
      setConfigs(result || []);

      await invoke('runSyncNow');
      await loadSyncStatus();

      const wbCount = mappings.filter((m) => m.writeback).length;
      const after = mappings.filter((m) => m.mode === 'afterSubmit').length;
      const timing = onStatus ? `on status ${selectedStatuses.map((s) => s.label).join(', ')}` : 'on submit';
      setFlash({
        appearance: 'success',
        title: 'Configuration saved',
        text: `${mappings.length} field mapping${mappings.length === 1 ? '' : 's'} (${after} set after submit), ${wbCount} with write-back (${timing}), ${notifyUsers.length} user(s) notified on errors. A full sync of the select lists starts within 5 minutes.`
      });
      resetEditor();
      setEditId(null);
      setView('list');
    } catch (e) {
      setFlash({ appearance: 'error', title: 'Saving failed', text: String(e && e.message ? e.message : e) });
    } finally {
      setBusy(false);
    }
  };

  // Delete only after confirmation in the modal
  const confirmRemove = async () => {
    const cfg = confirmDelete;
    setConfirmDelete(null);
    if (!cfg) return;
    setBusy(true);
    try {
      setConfigs((await invoke('deleteConfig', { id: cfg.id })) || []);
      setFlash({
        appearance: 'information',
        title: 'Configuration deleted',
        text: 'The related portal contexts have been removed. Select lists that were only synced by this configuration are cleaned up with the next sync run (only app-created options are disabled).'
      });
    } catch (e) {
      setFlash({ appearance: 'error', title: 'Deleting failed', text: String(e && e.message ? e.message : e) });
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setBusy(true);
    try {
      await invoke('runSyncNow');
      await loadSyncStatus();
      setFlash({
        appearance: 'information',
        title: 'Full sync requested',
        text: 'The full sync starts with the next scheduled run (within 5 minutes). Use "Refresh status" to see the result.'
      });
    } catch (e) {
      setFlash({ appearance: 'error', title: 'Sync could not be requested', text: String(e && e.message ? e.message : e) });
    } finally {
      setBusy(false);
    }
  };

  // -------------------------------------------------------------------------
  // View: overview
  // -------------------------------------------------------------------------
  const deskName = (c) => {
    if (c.serviceDeskName) return c.serviceDeskName;
    const d = desks.find((x) => String(x.id) === String(c.serviceDeskId));
    return d ? d.name : `Service desk ${c.serviceDeskId || '-'}`;
  };

  const configLabel = (id) => {
    const c = configs.find((x) => x.id === id);
    return c ? `${deskName(c)} – ${(c.requestTypeNames || c.requestTypeIds || []).join(', ') || '-'}` : '';
  };

  const timingLabel = (c) => {
    if (modeOf(c) !== 'onStatus') return 'On submit';
    const names = c.writebackStatusNames || c.writebackStatusIds || [];
    return names.length ? `On status: ${names.join(', ')}` : 'On status (none selected)';
  };

  const listRows = configs.map((c) => {
    const maps = c.mappings || [];
    const wb = maps.filter((m) => m.writeback).length;
    const refs = maps.filter((m) => m.refObjectTypeId).length;
    const notify = (c.notifyUsers || []).length;
    const complete = c.objectTypeId && c.triggerField;
    return {
      key: c.id,
      cells: [
        {
          key: 'desk',
          content: (
            <Stack space="space.050">
              <Strong>{deskName(c)}</Strong>
              <Text>{c.id}</Text>
              {!complete && <Lozenge appearance="moved">Incomplete</Lozenge>}
            </Stack>
          )
        },
        { key: 'rts', content: <Text>{(c.requestTypeNames || c.requestTypeIds || []).join(', ') || '-'}</Text> },
        {
          key: 'source',
          content: (
            <Stack space="space.050">
              <Text>{c.objectTypeName || '-'}</Text>
              {c.aqlFilter ? <Lozenge appearance="new">AQL filter</Lozenge> : null}
            </Stack>
          )
        },
        { key: 'trigger', content: <Text>{c.triggerFieldName || c.triggerField || '-'}</Text> },
        {
          key: 'maps',
          content: (
            <Stack space="space.050">
              <Inline space="space.100" alignBlock="center">
                <Badge>{maps.length}</Badge>
                {wb ? <Lozenge appearance="success">{`${wb} write-back`}</Lozenge> : <Lozenge>Read only</Lozenge>}
                {refs ? <Lozenge appearance="new">{`${refs} reference`}</Lozenge> : null}
              </Inline>
              {wb ? <Text>{timingLabel(c)}</Text> : null}
              {notify ? <Lozenge appearance="inprogress">{`${notify} notified on errors`}</Lozenge> : null}
            </Stack>
          )
        },
        {
          key: 'actions',
          content: (
            <ButtonGroup>
              <Button appearance="subtle" onClick={() => startEdit(c)} isDisabled={busy}>Edit</Button>
              <Button appearance="subtle" onClick={() => setConfirmDelete(c)} isDisabled={busy}>Delete</Button>
            </ButtonGroup>
          )
        }
      ]
    };
  });

  // Issues of the last sync as a table
  const issues = syncIssues(syncStatus);
  const issueRows = issues.map((i, idx) => ({
    key: `issue-${idx}`,
    cells: [
      { key: 'sev', content: <Lozenge appearance={SEVERITY_LOZENGE[i.severity] || 'default'}>{i.severity}</Lozenge> },
      {
        key: 'field',
        content: (
          <Stack space="space.025">
            <Strong>{i.fieldName}</Strong>
            {i.fieldName !== i.field ? <Text>{i.field}</Text> : null}
          </Stack>
        )
      },
      {
        key: 'config',
        content: i.config ? (
          <Stack space="space.025">
            <Text>{i.configLabel || configLabel(i.config) || '-'}</Text>
            <Text>{i.config}</Text>
          </Stack>
        ) : (
          <Text>Not in any configuration</Text>
        )
      },
      { key: 'msg', content: <Text>{i.message}</Text> }
    ]
  }));

  const renderList = () => (
    <Stack space="space.200">
      <Box xcss={footerStyle}>
        <Stack space="space.150">
          <Inline spread="space-between" alignBlock="center">
            <Text>{syncSummary(syncStatus)}</Text>
            <Button appearance="subtle" onClick={loadSyncStatus} isDisabled={busy}>Refresh status</Button>
          </Inline>
          {issueRows.length > 0 && (
            <DynamicTable
              head={{
                cells: [
                  { key: 'sev', content: 'Severity' },
                  { key: 'field', content: 'Field' },
                  { key: 'config', content: 'Configuration' },
                  { key: 'msg', content: 'Details' }
                ]
              }}
              rows={issueRows}
            />
          )}
        </Stack>
      </Box>
      <Box xcss={cardStyle}>
        {configs.length ? (
          <DynamicTable
            head={{
              cells: [
                { key: 'desk', content: 'Service project' },
                { key: 'rts', content: 'Request types' },
                { key: 'source', content: 'Asset source' },
                { key: 'trigger', content: 'Trigger field' },
                { key: 'maps', content: 'Mappings' },
                { key: 'actions', content: '' }
              ]
            }}
            rows={listRows}
          />
        ) : (
          <EmptyState
            header="No configurations yet"
            description="Define which portal forms load values from Assets and write changes back."
            primaryAction={<Button appearance="primary" onClick={startNew}>Create configuration</Button>}
          />
        )}
      </Box>
    </Stack>
  );

  // Confirmation dialog for deleting a configuration
  const renderDeleteModal = () => (
    <ModalTransition>
      {confirmDelete && (
        <Modal onClose={() => setConfirmDelete(null)}>
          <ModalHeader>
            <ModalTitle appearance="danger">Delete configuration?</ModalTitle>
          </ModalHeader>
          <ModalBody>
            <Stack space="space.150">
              <Text>
                {`Service project: ${deskName(confirmDelete)} · Request types: ${(confirmDelete.requestTypeNames || confirmDelete.requestTypeIds || []).join(', ') || '-'} · Asset source: ${confirmDelete.objectTypeName || '-'} · ID: ${confirmDelete.id}`}
              </Text>
              <SectionMessage appearance="warning">
                <Text>
                  The portal forms of these request types are no longer filled from Assets and no write-back happens anymore.
                  Select lists that are only synced by this configuration are cleaned up with the next sync run (app-created options are disabled, manual options stay).
                  This cannot be undone.
                </Text>
              </SectionMessage>
            </Stack>
          </ModalBody>
          <ModalFooter>
            <Button appearance="subtle" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button appearance="danger" onClick={confirmRemove}>Delete configuration</Button>
          </ModalFooter>
        </Modal>
      )}
    </ModalTransition>
  );

  // -------------------------------------------------------------------------
  // View: editor
  // -------------------------------------------------------------------------
  const attrLabel = (a) => {
    let l = a.name;
    if (a.isReference) l += ' → reference';
    if (!a.editable) l += ' (read-only)';
    return l;
  };

  const baseAttrOptions = [{ label: '– Not mapped –', value: '' }].concat(
    attributes.map((a) => ({ label: attrLabel(a), value: a.name }))
  );

  const assetsAttrOptions = () => {
    const refs = attributes.filter((a) => a.isReference);
    return [
      { label: '– Not mapped –', value: '' },
      { label: '(Selected asset)', value: SELF }
    ].concat((refs.length ? refs : attributes).map((a) => ({ label: attrLabel(a), value: a.name })));
  };

  const mappingRows = mappableFields.map((f) => {
    const kind = fieldKind(f);
    const mode = fillModeOf(kind);
    const supported = mode !== null;
    const row = mapping[f.id] || { attribute: '', writeback: false, refAqlFilter: '', manual: false };
    const attr = attrByName(row.attribute);
    const ref = isRefList(kind, attr);
    const canWrite =
      supported && kind !== 'assets' && row.attribute !== SELF &&
      !!row.attribute && !!attr && attr.editable !== false;
    const options = kind === 'assets' ? assetsAttrOptions() : baseAttrOptions;

    let status = <Lozenge>Not mapped</Lozenge>;
    if (!supported) status = <Lozenge appearance="removed">Not supported</Lozenge>;
    else if (ref) status = <Lozenge appearance="new">Synced list</Lozenge>;
    else if (row.attribute && !row.manual) status = <Lozenge appearance="success">Automatic</Lozenge>;
    else if (row.attribute) status = <Lozenge appearance="inprogress">Manual</Lozenge>;

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
        { key: 'type', content: <Lozenge>{KIND_LABELS[kind] || kind}</Lozenge> },
        {
          key: 'fill',
          content: !supported
            ? <Text>-</Text>
            : mode === 'live'
              ? <Lozenge appearance="success">Live</Lozenge>
              : <Lozenge appearance="moved">After submit</Lozenge>
        },
        {
          key: 'attr',
          content: (
            <Stack space="space.100">
              <Select
                options={options}
                isDisabled={!supported}
                value={supported ? options.find((o) => o.value === row.attribute) : options[0]}
                onChange={(v) => {
                  const val = v ? v.value : '';
                  const a = attrByName(val);
                  setRow(f.id, { attribute: val, writeback: kind !== 'assets' && !!(a && a.editable) });
                }}
              />
              {ref && (
                <Textfield
                  value={row.refAqlFilter || ''}
                  placeholder='AQL filter for this list, e.g. Status = "Active"'
                  onChange={(e) => setRow(f.id, { refAqlFilter: e.target.value })}
                />
              )}
            </Stack>
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
      <Section step="1" title="Portal and request types" description="Which portal forms should the app be active on?">
        <Inline space="space.300" shouldWrap>
          <Box xcss={xcss({ width: '320px' })}>
            <Field id="desk" label="Service project">
              <Select id="desk" options={desks.map(opt)} value={desk} onChange={onDesk} placeholder="Select a project" />
            </Field>
          </Box>
          <Box xcss={xcss({ width: '480px' })}>
            <Field id="rts" label="Request types" helper="You can select multiple. Fields from all selected request types are combined.">
              <Select id="rts" isMulti isDisabled={!desk} options={requestTypes.map(opt)} value={selectedRts} onChange={onRts} placeholder="Select request types" />
            </Field>
          </Box>
        </Inline>
      </Section>

      <Section step="2" title="Asset source" description="Which object type in Assets do the values come from?">
        <Inline space="space.300" shouldWrap>
          <Box xcss={xcss({ width: '320px' })}>
            <Field id="schema" label="Object schema">
              <Select id="schema" options={schemas.map(opt)} value={schema} onChange={onSchema} placeholder="Select a schema" />
            </Field>
          </Box>
          <Box xcss={xcss({ width: '320px' })}>
            <Field id="type" label="Object type">
              <Select id="type" isDisabled={!schema} options={types.map(opt)} value={objectType} onChange={onType} placeholder="Select an object type" />
            </Field>
          </Box>
        </Inline>
        <Box xcss={xcss({ maxWidth: '660px' })}>
          <Field id="aql" label="AQL filter for the trigger field (optional)" helper="Limits which objects can be selected in the trigger field.">
            <Textfield id="aql" value={aqlFilter} placeholder='e.g. Status = "Approved"' onChange={(e) => setAqlFilter(e.target.value)} />
          </Field>
        </Box>
      </Section>

      <Section step="3" title="Trigger field" description="The select list customers use to choose the asset. The app keeps its options up to date automatically.">
        <Box xcss={xcss({ width: '320px' })}>
          <Field id="trigger" label="Select list">
            <Select
              id="trigger"
              isDisabled={!fields.length}
              options={fields.filter((f) => fieldKind(f) === 'select').map(opt)}
              value={triggerField}
              onChange={setTriggerField}
              placeholder="Select a field"
            />
          </Field>
        </Box>
        {fields.length > 0 && !fields.some((f) => fieldKind(f) === 'select') && (
          <SectionMessage appearance="warning" title="No select list in the form">
            <Text>Add a single-select list to the request form so customers can choose an asset.</Text>
          </SectionMessage>
        )}
      </Section>

      <Section
        step="4"
        title="Field mapping"
        description="Fields and attributes with matching names are mapped automatically. Live fields are filled in the portal as soon as an asset is selected. After-submit fields cannot be changed in the portal by apps and are set on the request right after it is created, if the customer left them empty."
        aside={
          mappingRows.length ? (
            <Inline space="space.100">
              <Lozenge appearance="success">{`${mappedCount} mapped`}</Lozenge>
              <Lozenge appearance="inprogress">{`${writebackCount} write-back`}</Lozenge>
            </Inline>
          ) : null
        }
      >
        {mappingRows.length && attributes.length ? (
          <DynamicTable
            head={{
              cells: [
                { key: 'field', content: 'Form field' },
                { key: 'type', content: 'Field type' },
                { key: 'fill', content: 'Filled' },
                { key: 'attr', content: 'Asset attribute' },
                { key: 'wb', content: 'Write back' },
                { key: 'status', content: 'Status' }
              ]
            }}
            rows={mappingRows}
          />
        ) : (
          <SectionMessage appearance="information">
            <Text>Select request types and an object type to see the mapping.</Text>
          </SectionMessage>
        )}
        {refWithoutType.length > 0 && (
          <SectionMessage appearance="warning" title="Referenced object type not found">
            <Text>{`Assets did not return the referenced object type for: ${refWithoutType.map((f) => f.name).join(', ')}. These lists cannot be synced.`}</Text>
          </SectionMessage>
        )}
        <SectionMessage appearance="information">
          <Text>Reference attributes (→ reference): map them to a select list and the app keeps that list synced with the objects of the referenced type. Use the AQL filter below the attribute to limit the list, e.g. Status = "Active". Select lists with a normal attribute: the asset value must match the option name. Cascading select: use "Parent &gt; Child". Assets object fields: choose "(Selected asset)" or a reference attribute.</Text>
        </SectionMessage>
      </Section>

      <Section step="5" title="Write-back timing" description="When should changed values be written back to the asset? Use a status change to wait for approvals first.">
        {writebackCount ? (
          <Stack space="space.200">
            <Box xcss={xcss({ width: '420px' })}>
              <Field id="wbmode" label="Write back">
                <Select
                  id="wbmode"
                  options={MODE_OPTIONS}
                  value={MODE_OPTIONS.find((o) => o.value === writebackMode)}
                  onChange={(v) => setWritebackMode(v ? v.value : 'onCreate')}
                />
              </Field>
            </Box>
            {writebackMode === 'onStatus' && (
              <Box xcss={xcss({ width: '480px' })}>
                <Field
                  id="wbstatus"
                  label="Target status"
                  helper="Write-back runs when the request moves into one of these statuses. Choose the status after approval so rejected requests are not written back."
                >
                  <Select
                    id="wbstatus"
                    isMulti
                    isDisabled={!statuses.length}
                    options={statuses.map(opt)}
                    value={selectedStatuses}
                    onChange={(v) => setSelectedStatuses(v || [])}
                    placeholder={statuses.length ? 'Select statuses' : 'Select request types first'}
                  />
                </Field>
              </Box>
            )}
          </Stack>
        ) : (
          <SectionMessage appearance="information">
            <Text>No field has write-back enabled. Turn on "Write back" for at least one field in step 4.</Text>
          </SectionMessage>
        )}
      </Section>

      <Section
        step="6"
        title="Error notifications"
        description="These users get an e-mail from Jira when a write-back of this configuration fails or single fields could not be written. They must have permission to view the request."
        aside={notifyUsers.length ? <Lozenge appearance="inprogress">{`${notifyUsers.length} user(s)`}</Lozenge> : null}
      >
        <Box xcss={xcss({ width: '480px' })}>
          <UserPicker
            key={`notify-${editorKey}`}
            name="notifyUsers"
            label="Notify users"
            isMulti
            placeholder="Search users"
            defaultValue={notifyUsers.map((u) => u.accountId)}
            onChange={(v) => setNotifyUsers(toNotifyUsers(v))}
          />
        </Box>
      </Section>

      <Box xcss={footerStyle}>
        <Inline spread="space-between" alignBlock="center">
          <Text>{missing.length ? `Still missing: ${missing.join(', ')}` : 'All required settings are complete.'}</Text>
          <ButtonGroup>
            <Button appearance="subtle" onClick={cancel} isDisabled={busy}>Cancel</Button>
            <Button appearance="primary" onClick={save} isDisabled={!canSave}>
              {editId ? 'Save changes' : 'Save configuration'}
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
            <Heading as="h2">{view === 'edit' ? (editId ? `Edit configuration (${editId})` : 'New configuration') : 'Asset Dynamic Forms'}</Heading>
            <Text>Fills portal forms with values from Assets and writes changes back.</Text>
          </Stack>
          {view === 'list' && (
            <ButtonGroup>
              <Button onClick={syncNow} isDisabled={busy || !configs.length}>Full sync now</Button>
              <Button appearance="primary" onClick={startNew} isDisabled={busy}>New configuration</Button>
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

        {renderDeleteModal()}
      </Stack>
    </Box>
  );
};

ForgeReconciler.render(<App />);