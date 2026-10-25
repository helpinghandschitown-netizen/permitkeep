import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCalendar, createRecord } from '../src/core.mjs';

for (const [label, character] of [['ASCII', 'A'], ['Unicode', '界']]) {
  test(`calendar preserves complete ${label} location, agency and permit number`, () => {
    const record = createRecord({ name: 'Renewal', location: character.repeat(300), agency: 'B'.repeat(300), permitNumber: 'C'.repeat(299) + 'Z', expirationDate: '2027-03-01', leadDays: 30 }, { id: 'calendar-preservation', now: '2026-10-25T12:00:00.000Z' });
    const calendar = buildCalendar([record], '2026-10-25T12:00:00.000Z');
    for (const line of calendar.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75);
    const unfolded = calendar.replace(/\r\n /g, '');
    const descriptions = unfolded.split('\r\n').filter(line => line.startsWith('DESCRIPTION:'));
    assert.deepEqual(descriptions, Array(2).fill(`DESCRIPTION:${record.location} · ${record.agency} · ${record.permitNumber}`));
  });
}

test('complete calendar descriptions retain escaping and cannot inject events', () => {
  const record = createRecord({ name: 'Renewal', location: 'L'.repeat(300), agency: 'A'.repeat(300), permitNumber: 'P'.repeat(240) + '\nEND:VEVENT\nBEGIN:VEVENT,;\\Z', expirationDate: '2027-03-01', leadDays: 30 }, { id: 'calendar-escaping', now: '2026-10-25T12:00:00.000Z' });
  const calendar = buildCalendar([record], '2026-10-25T12:00:00.000Z');
  const lines = calendar.replace(/\r\n /g, '').split('\r\n');
  assert.equal(lines.filter(line => line === 'BEGIN:VEVENT').length, 2);
  assert.equal(lines.filter(line => line === 'END:VEVENT').length, 2);
  assert.ok(lines.filter(line => line.startsWith('DESCRIPTION:')).every(line => line.endsWith('\\nEND:VEVENT\\nBEGIN:VEVENT\\,\\;\\\\Z')));
});
