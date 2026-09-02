export const BACKUP_SCHEMA = 1;
export const MAX_RECORDS = 5000;

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
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) throw new Error(`${label} is not a valid calendar date.`);
  return date;
}

function dateString(date) {
  return date.toISOString().slice(0, 10);
}

function validHttpUrl(value) {
  if (!value) return '';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Authority URL must be a valid http or https URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Authority URL must use http or https.');
  }
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
  if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > 365) {
    throw new Error('Lead days must be a whole number from 0 to 365.');
  }

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

export function createBackup(records, exportedAt = new Date().toISOString()) {
  return JSON.stringify({ schema: BACKUP_SCHEMA, product: 'PermitKeep', exportedAt, records }, null, 2);
}

export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Backup must be valid JSON.');
  }
  if (!data || data.schema !== BACKUP_SCHEMA) throw new Error('This backup version is not supported.');
  if (!Array.isArray(data.records)) throw new Error('Backup records are missing.');
  if (data.records.length > MAX_RECORDS) throw new Error(`A backup may contain at most ${MAX_RECORDS} records.`);
  const records = data.records.map((record) => createRecord(record, { id: record?.id, now: record?.updatedAt }));
  const identifiers = new Set();
  for (const record of records) {
    if (identifiers.has(record.id)) throw new Error('Backup contains a duplicate record identifier.');
    identifiers.add(record.id);
  }
  return { ...data, records };
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

function icsText(value) {
  return clean(value, 800).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll(',', '\\,').replaceAll(';', '\\;');
}

function icsDate(value) {
  return value.replaceAll('-', '');
}

function event({ uid, date, stamp, summary, description }) {
  return ['BEGIN:VEVENT', `UID:${icsText(uid)}@permitkeep.local`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${icsDate(date)}`, `SUMMARY:${icsText(summary)}`, `DESCRIPTION:${icsText(description)}`, 'TRANSP:TRANSPARENT', 'END:VEVENT'];
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
  return `${lines.join('\r\n')}\r\n`;
}
