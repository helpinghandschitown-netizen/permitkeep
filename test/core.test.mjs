import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKUP_SCHEMA,
  buildCalendar,
  classifyDeadline,
  createRecord,
  parseBackup,
  recordsToCsv,
  renewalDate,
  sortByUrgency,
} from '../src/core.mjs';

const base = {
  name: 'Food establishment permit',
  location: 'West Loop',
  agency: 'City licensing office',
  authorityUrl: 'https://example.gov/renew',
  expirationDate: '2026-12-31',
  leadDays: 60,
  owner: 'Operations',
  notes: 'Confirm fees from the agency page.',
};

test('createRecord trims input and creates deterministic metadata', () => {
  const record = createRecord(
    { ...base, name: '  Food establishment permit  ', permitNumber: '  P-42  ' },
    { id: 'record-1', now: '2026-09-02T12:00:00.000Z' },
  );
  assert.equal(record.id, 'record-1');
  assert.equal(record.name, 'Food establishment permit');
  assert.equal(record.permitNumber, 'P-42');
  assert.equal(record.leadDays, 60);
  assert.equal(record.createdAt, '2026-09-02T12:00:00.000Z');
});

test('createRecord rejects missing identity, invalid dates, URLs, and lead windows', () => {
  assert.throws(() => createRecord({ ...base, name: '' }), /name is required/i);
  assert.throws(() => createRecord({ ...base, expirationDate: '12\/31\/2026' }), /expiration date/i);
  assert.throws(() => createRecord({ ...base, authorityUrl: 'javascript:alert(1)' }), /http/i);
  assert.throws(() => createRecord({ ...base, authorityUrl: 'https://user:secret@example.gov/renew' }), /credentials/i);
  assert.throws(() => createRecord({ ...base, leadDays: 999 }), /lead days/i);
});

test('renewalDate uses UTC calendar days and handles leap years', () => {
  assert.equal(renewalDate('2028-03-01', 1), '2028-02-29');
  assert.equal(renewalDate('2026-01-01', 60), '2025-11-02');
});

test('classifyDeadline distinguishes missing, expired, renew-now, upcoming, and current', () => {
  const today = '2026-09-02';
  assert.equal(classifyDeadline({ expirationDate: '' }, today).key, 'missing');
  assert.equal(classifyDeadline({ expirationDate: '2026-09-01', leadDays: 30 }, today).key, 'expired');
  assert.equal(classifyDeadline({ expirationDate: '2026-09-15', leadDays: 30 }, today).key, 'renew');
  assert.equal(classifyDeadline({ expirationDate: '2026-11-01', leadDays: 30 }, today).key, 'upcoming');
  assert.equal(classifyDeadline({ expirationDate: '2027-04-01', leadDays: 30 }, today).key, 'current');
});

test('sortByUrgency is stable across deadline classes and dates', () => {
  const records = [
    { id: 'c', name: 'Current', expirationDate: '2027-08-01', leadDays: 30 },
    { id: 'e', name: 'Expired', expirationDate: '2026-08-01', leadDays: 30 },
    { id: 'r', name: 'Renew', expirationDate: '2026-09-12', leadDays: 30 },
    { id: 'm', name: 'Missing', expirationDate: '', leadDays: 30 },
  ];
  assert.deepEqual(sortByUrgency(records, '2026-09-02').map((record) => record.id), ['e', 'r', 'm', 'c']);
});

test('backup parser accepts this schema and rejects malformed or unsupported data', () => {
  const payload = JSON.stringify({ schema: BACKUP_SCHEMA, exportedAt: '2026-09-02T12:00:00.000Z', records: [createRecord(base, { id: 'x', now: '2026-09-02T12:00:00.000Z' })] });
  assert.equal(parseBackup(payload).records[0].id, 'x');
  assert.throws(() => parseBackup('{nope'), /valid json/i);
  assert.throws(() => parseBackup(JSON.stringify({ schema: 999, records: [] })), /version/i);
  assert.throws(() => parseBackup(JSON.stringify({ schema: BACKUP_SCHEMA, records: [null] })), /record data is required/i);
});

test('backup parser rejects duplicate record identifiers', () => {
  const record = createRecord(base, { id: 'duplicate', now: '2026-09-02T12:00:00.000Z' });
  const payload = JSON.stringify({ schema: BACKUP_SCHEMA, records: [record, { ...record, name: 'Second record' }] });
  assert.throws(() => parseBackup(payload), /duplicate record identifier/i);
});

test('CSV export neutralizes spreadsheet formulas and quotes values', () => {
  const csv = recordsToCsv([createRecord({ ...base, name: '=HYPERLINK("bad")', notes: 'one, two' }, { id: 'x', now: '2026-09-02T12:00:00.000Z' })]);
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
  assert.match(csv, /"one, two"/);
});

test('calendar export contains renewal and expiration events without unsafe HTML', () => {
  const record = createRecord({ ...base, name: 'Food, permit; west', leadDays: 30 }, { id: 'x', now: '2026-09-02T12:00:00.000Z' });
  const ics = buildCalendar([record], '2026-09-02T12:00:00.000Z');
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261201/);
  assert.match(ics, /SUMMARY:Start renewal — Food\\, permit\\; west/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261231/);
  assert.match(ics, /END:VCALENDAR/);
});
