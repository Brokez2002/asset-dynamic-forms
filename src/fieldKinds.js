// Shared field type logic (backend + admin page)

export const norm = (s) =>
  String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

// Map a Jira field (id + schema type) to an internal "kind"
export const kindOf = (id, type) => {
  const t = String(type || '');
  if (id === 'summary' || t === 'summary') return 'summary';
  if (id === 'description' || t === 'description') return 'description';
  if (id === 'duedate' || t === 'duedate') return 'date';
  if (id === 'labels' || t === 'labels' || t.endsWith(':labels')) return 'labels';
  if (id === 'priority' || t === 'priority') return 'priority';
  if (t.endsWith(':textfield')) return 'text';
  if (t.endsWith(':textarea')) return 'textarea';
  if (t.endsWith(':float') || t === 'number') return 'number';
  if (t.endsWith(':select')) return 'select';
  if (t.endsWith(':multiselect')) return 'multiselect';
  if (t.endsWith(':radiobuttons')) return 'radio';
  if (t.endsWith(':multicheckboxes')) return 'checkbox';
  if (t.endsWith(':cascadingselect')) return 'cascading';
  if (t.endsWith(':datepicker')) return 'date';
  if (t.endsWith(':datetime')) return 'datetime';
  if (t.endsWith(':url')) return 'url';
  if (t.endsWith(':userpicker')) return 'user';
  if (t.endsWith(':multiuserpicker')) return 'multiuser';
  if (t.endsWith(':cmdb-object-cftype')) return 'assets';
  if (t === 'string') return 'text';
  return 'unknown';
};

// Filled live in the portal form (UI modification)
export const LIVE_KINDS = [
  'summary', 'description', 'text', 'textarea', 'number',
  'select', 'multiselect', 'date', 'datetime', 'labels', 'user', 'priority'
];

// Not available to UI modifications in the portal -> set on the request right after submit
export const AFTER_SUBMIT_KINDS = ['radio', 'checkbox', 'cascading', 'url', 'multiuser', 'assets'];

export const fillModeOf = (kind) =>
  LIVE_KINDS.includes(kind) ? 'live' : AFTER_SUBMIT_KINDS.includes(kind) ? 'afterSubmit' : null;

export const OPTION_KINDS = ['select', 'multiselect', 'radio', 'checkbox', 'cascading', 'priority'];

export const KIND_LABELS = {
  summary: 'Summary', description: 'Description', text: 'Text', textarea: 'Multi-line text',
  number: 'Number', select: 'Select list', multiselect: 'Multi-select', radio: 'Radio buttons',
  checkbox: 'Checkboxes', cascading: 'Cascading select', date: 'Date', datetime: 'Date/time',
  url: 'URL', labels: 'Labels', user: 'User', multiuser: 'Multi-user', priority: 'Priority',
  assets: 'Assets object', unknown: 'Unknown'
};
