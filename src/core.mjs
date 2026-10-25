export const BACKUP_SCHEMA = 2;
export const LEGACY_BACKUP_SCHEMA = 1;
export const MAX_RECORDS = 5000;
export const MAX_WORK_STEPS = 25000;
export const MAX_ACTIVITY_ENTRIES = 50000;

const TEXT_FIELDS = ['name', 'location', 'category', 'permitNumber', 'agency', 'authorityUrl', 'owner', 'notes'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function clean(value, max = 500) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function parseDate(value, label = 'Date') {
  const text = clean(value, 10);
  if (!DATE_PATTERN.test(text)) throw new Error(`${label} must use YYYY-MM-DD.`);
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${label} is not a valid calendar date.`);
  }
  return date;
}

function dateString(date) {
  return date.toISOString().slice(0, 10);
}

function validHttpUrl(value) {
  if (!value) return '';
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Authority URL must be a valid http or https URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Authority URL must use http or https.');
  if (parsed.username || parsed.password) throw new Error('Authority URL must not contain embedded credentials.');
  return parsed.href;
}

export function createRecord(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Record data is required.');
  const values = Object.fromEntries(TEXT_FIELDS.map((field) => [field, clean(input[field], field === 'notes' ? 2000 : 300)]));
  if (!values.name) throw new Error('Permit or renewal name is required.');
  if (!values.location) throw new Error('Location is required.');
  if (!values.agency) throw new Error('Issuing agency is required.');
  const expirationDate = clean(input.expirationDate, 10);
  if (expirationDate) parseDate(expirationDate, 'Expiration date');
  const leadDays = Number(input.leadDays ?? 60);
  if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > 365) throw new Error('Lead days must be a whole number from 0 to 365.');
  const now = clean(options.now || input.updatedAt || new Date().toISOString(), 40);
  if (Number.isNaN(Date.parse(now))) throw new Error('Updated timestamp is invalid.');
  const createdAt = clean(input.createdAt || now, 40);
  if (Number.isNaN(Date.parse(createdAt))) throw new Error('Created timestamp is invalid.');
  const generatedId = globalThis.crypto?.randomUUID?.() || `record-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id: clean(options.id || input.id || generatedId, 100),
    ...values,
    authorityUrl: validHttpUrl(values.authorityUrl),
    expirationDate,
    leadDays,
    createdAt,
    updatedAt: now,
  };
}

export function createWorkStep(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Work-step data is required.');
  const recordId = clean(input.recordId, 100);
  const title = clean(input.title, 300);
  if (!recordId) throw new Error('A work step must belong to a record.');
  if (!title) throw new Error('Work-step title is required.');
  const targetDate = clean(input.targetDate, 10);
  if (targetDate) parseDate(targetDate, 'Target date');
  const now = clean(options.now || input.updatedAt || new Date().toISOString(), 40);
  if (Number.isNaN(Date.parse(now))) throw new Error('Work-step timestamp is invalid.');
  const createdAt = clean(input.createdAt || now, 40);
  if (Number.isNaN(Date.parse(createdAt))) throw new Error('Work-step created timestamp is invalid.');
  const generatedId = globalThis.crypto?.randomUUID?.() || `step-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id: clean(options.id || input.id || generatedId, 100),
    recordId,
    title,
    owner: clean(input.owner, 300),
    targetDate,
    completed: input.completed === true || input.completed === 'true' || input.completed === 'on',
    note: clean(input.note, 2000),
    createdAt,
    updatedAt: now,
  };
}

export function createActivityEntry(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Activity data is required.');
  const action = clean(input.action, 80);
  const entityId = clean(input.entityId, 100);
  const summary = clean(input.summary, 500);
  if (!action || !entityId || !summary) throw new Error('Activity action, entity, and summary are required.');
  const at = clean(options.at || input.at || new Date().toISOString(), 40);
  if (Number.isNaN(Date.parse(at))) throw new Error('Activity timestamp is invalid.');
  const generatedId = globalThis.crypto?.randomUUID?.() || `activity-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return { id: clean(options.id || input.id || generatedId, 100), action, entityId, recordId: clean(input.recordId, 100), summary, at };
}

export function renewalDate(expirationDate, leadDays = 60) {
  const date = parseDate(expirationDate, 'Expiration date');
  const days = Number(leadDays);
  if (!Number.isInteger(days) || days < 0 || days > 365) throw new Error('Lead days must be a whole number from 0 to 365.');
  date.setUTCDate(date.getUTCDate() - days);
  return dateString(date);
}

export function daysBetween(fromDate, toDate) {
  return Math.round((parseDate(toDate).getTime() - parseDate(fromDate).getTime()) / 86_400_000);
}

export function classifyDeadline(record, today = dateString(new Date())) {
  if (!record?.expirationDate) return { key: 'missing', label: 'Date needed', days: null, tone: 'neutral' };
  const days = daysBetween(today, record.expirationDate);
  if (days < 0) return { key: 'expired', label: `Expired ${Math.abs(days)}d ago`, days, tone: 'danger' };
  if (days <= Number(record.leadDays ?? 60)) return { key: 'renew', label: days === 0 ? 'Expires today' : `Renew now · ${days}d left`, days, tone: 'warning' };
  if (days <= 90) return { key: 'upcoming', label: `Upcoming · ${days}d left`, days, tone: 'info' };
  return { key: 'current', label: `Current · ${days}d left`, days, tone: 'success' };
}

export function classifyWorkStep(step, today = dateString(new Date())) {
  if (step?.completed) return { key: 'completed', label: 'Completed', tone: 'success', days: null };
  if (!step?.targetDate) return { key: 'unscheduled', label: 'Date needed', tone: 'neutral', days: null };
  const days = daysBetween(today, step.targetDate);
  if (days < 0) return { key: 'overdue', label: `Overdue ${Math.abs(days)}d`, tone: 'danger', days };
  if (days === 0) return { key: 'next', label: 'Due today', tone: 'warning', days };
  return { key: 'next', label: `Due in ${days}d`, tone: days <= 7 ? 'warning' : 'info', days };
}

export function sortByUrgency(records, today) {
  const weights = { expired: 0, renew: 1, upcoming: 2, missing: 3, current: 4 };
  return [...records].sort((a, b) => {
    const aClass = classifyDeadline(a, today);
    const bClass = classifyDeadline(b, today);
    return weights[aClass.key] - weights[bClass.key]
      || (a.expirationDate || '9999-12-31').localeCompare(b.expirationDate || '9999-12-31')
      || a.name.localeCompare(b.name);
  });
}

export function createBackup(records, pro = { steps: [], activity: [] }, exportedAt = new Date().toISOString()) {
  return JSON.stringify({ schema: BACKUP_SCHEMA, product: 'PermitKeep', exportedAt, records, pro: { steps: pro?.steps || [], activity: pro?.activity || [] } }, null, 2);
}

export function parseBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Backup must be valid JSON.'); }
  if (!data || ![LEGACY_BACKUP_SCHEMA, BACKUP_SCHEMA].includes(data.schema)) throw new Error('This backup version is not supported.');
  if (data.product && data.product !== 'PermitKeep') throw new Error('This backup belongs to another product.');
  if (!Array.isArray(data.records)) throw new Error('Backup records are missing.');
  if (data.records.length > MAX_RECORDS) throw new Error(`A backup may contain at most ${MAX_RECORDS} records.`);
  const records = data.records.map((record) => createRecord(record, { id: record?.id, now: record?.updatedAt }));
  if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error('Backup contains a duplicate record identifier.');
  const rawPro = data.schema === LEGACY_BACKUP_SCHEMA || data.pro === undefined ? { steps: [], activity: [] } : data.pro;
  if (!rawPro || !Array.isArray(rawPro.steps) || !Array.isArray(rawPro.activity)) throw new Error('Backup Pro data is invalid.');
  if (rawPro.steps.length > MAX_WORK_STEPS) throw new Error(`A backup may contain at most ${MAX_WORK_STEPS} work steps.`);
  if (rawPro.activity.length > MAX_ACTIVITY_ENTRIES) throw new Error(`A backup may contain at most ${MAX_ACTIVITY_ENTRIES} activity entries.`);
  const recordIds = new Set(records.map((record) => record.id));
  const steps = rawPro.steps.map((step) => createWorkStep(step, { id: step?.id, now: step?.updatedAt }));
  if (new Set(steps.map((step) => step.id)).size !== steps.length) throw new Error('Backup contains a duplicate work-step identifier.');
  if (steps.some((step) => !recordIds.has(step.recordId))) throw new Error('Backup contains a work step for a missing record.');
  const activity = rawPro.activity.map((entry) => createActivityEntry(entry, { id: entry?.id, at: entry?.at }));
  if (new Set(activity.map((entry) => entry.id)).size !== activity.length) throw new Error('Backup contains a duplicate activity identifier.');
  return { ...data, schema: BACKUP_SCHEMA, records, pro: { steps, activity } };
}

function spreadsheetSafe(value) {
  const text = clean(value, 4000);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  return `"${spreadsheetSafe(value).replaceAll('"', '""')}"`;
}

export function recordsToCsv(records) {
  const fields = ['name', 'category', 'location', 'permitNumber', 'agency', 'authorityUrl', 'owner', 'expirationDate', 'leadDays', 'renewalDate', 'notes'];
  const rows = [fields.map(csvCell).join(',')];
  for (const record of records) {
    const row = { ...record, renewalDate: record.expirationDate ? renewalDate(record.expirationDate, record.leadDays) : '' };
    rows.push(fields.map((field) => csvCell(row[field])).join(','));
  }
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

export function activityToCsv(activity) {
  const fields = ['at', 'action', 'summary', 'recordId', 'entityId'];
  const rows = [fields.map(csvCell).join(',')];
  for (const entry of [...activity].sort((a, b) => a.at.localeCompare(b.at))) rows.push(fields.map((field) => csvCell(entry[field])).join(','));
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

function groupedRecords(records, keyFor) {
  const groups = new Map();
  for (const record of records) {
    const key = keyFor(record) || 'Unspecified';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, items]) => ({ key, label: key, records: items }));
}

export function buildPortfolioReview(records, steps, today = dateString(new Date()), generatedAt = new Date().toISOString()) {
  const urgencyOrder = ['expired', 'renew', 'upcoming', 'missing', 'current'];
  const urgencyLabels = { expired: 'Expired', renew: 'Renew now', upcoming: 'Upcoming', missing: 'Date needed', current: 'Current' };
  const stepsByRecord = new Map(records.map((record) => [record.id, []]));
  for (const step of steps) if (stepsByRecord.has(step.recordId)) stepsByRecord.get(step.recordId).push(step);
  const overdueSteps = steps.filter((step) => classifyWorkStep(step, today).key === 'overdue');
  const openDated = steps.filter((step) => !step.completed && step.targetDate).sort((a, b) => a.targetDate.localeCompare(b.targetDate));
  const exceptions = records.map((record) => {
    const missing = [];
    if (!record.expirationDate) missing.push('expiration date');
    if (!record.owner) missing.push('record owner');
    if (!record.authorityUrl) missing.push('official agency URL');
    const recordSteps = stepsByRecord.get(record.id) || [];
    if (!recordSteps.length) missing.push('renewal work plan');
    if (recordSteps.some((step) => !step.owner)) missing.push('step owner');
    if (recordSteps.some((step) => !step.targetDate && !step.completed)) missing.push('step target date');
    return missing.length ? { recordId: record.id, name: record.name, location: record.location, missing } : null;
  }).filter(Boolean);
  const urgency = urgencyOrder.map((key) => ({ key, label: urgencyLabels[key], records: sortByUrgency(records.filter((record) => classifyDeadline(record, today).key === key), today) })).filter((group) => group.records.length);
  return {
    generatedAt,
    asOf: today,
    totals: { records: records.length, steps: steps.length, completedSteps: steps.filter((step) => step.completed).length, overdueSteps: overdueSteps.length, exceptions: exceptions.length },
    nextDueStep: openDated[0] || null,
    overdueSteps,
    exceptions,
    stepsByRecord: Object.fromEntries([...stepsByRecord.entries()]),
    groups: { urgency, location: groupedRecords(records, (record) => record.location), owner: groupedRecords(records, (record) => record.owner || 'Unassigned') },
  };
}

function icsText(value) {
  // Validated fields can exceed 800 characters when combined; fold, do not truncate.
  return String(value ?? '').replace(/\r\n?/g, '\n').trim().replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll(',', '\\,').replaceAll(';', '\\;');
}

function icsDate(value) { return value.replaceAll('-', ''); }

function event({ uid, date, stamp, summary, description }) {
  return ['BEGIN:VEVENT', `UID:${icsText(uid)}@permitkeep.local`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${icsDate(date)}`, `SUMMARY:${icsText(summary)}`, `DESCRIPTION:${icsText(description)}`, 'TRANSP:TRANSPARENT', 'END:VEVENT'];
}

function foldIcsLine(line) {
  const encoder = new TextEncoder();
  const folded = [];
  let chunk = '';
  let limit = 75;
  for (const character of line) {
    if (encoder.encode(chunk + character).length > limit) {
      folded.push(`${folded.length ? ' ' : ''}${chunk}`);
      chunk = character;
      limit = 74;
    } else chunk += character;
  }
  folded.push(`${folded.length ? ' ' : ''}${chunk}`);
  return folded;
}

export function buildCalendar(records, generatedAt = new Date().toISOString()) {
  const stamp = new Date(generatedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PermitKeep//Renewal Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:PermitKeep deadlines'];
  for (const record of records) {
    if (!record.expirationDate) continue;
    const detail = [record.location, record.agency, record.permitNumber].filter(Boolean).join(' · ');
    lines.push(...event({ uid: `${record.id}-renew`, date: renewalDate(record.expirationDate, record.leadDays), stamp, summary: `Start renewal — ${record.name}`, description: detail }));
    lines.push(...event({ uid: `${record.id}-expire`, date: record.expirationDate, stamp, summary: `Expires — ${record.name}`, description: detail }));
  }
  lines.push('END:VCALENDAR');
  return `${lines.flatMap(foldIcsLine).join('\r\n')}\r\n`;
}
