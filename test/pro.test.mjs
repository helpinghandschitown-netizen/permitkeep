import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKUP_SCHEMA,
  activityToCsv,
  buildPortfolioReview,
  classifyWorkStep,
  createActivityEntry,
  createBackup,
  createRecord,
  createWorkStep,
  parseBackup,
} from '../src/core.mjs';

const now = '2026-09-02T12:00:00.000Z';
const record = createRecord({
  name: 'Food permit',
  location: 'West Loop',
  agency: 'City licensing office',
  owner: 'Operations',
  expirationDate: '2026-09-20',
  leadDays: 30,
}, { id: 'permit-1', now });

test('work plans validate owner, target date, completion, and note', () => {
  const step = createWorkStep({
    recordId: record.id,
    title: 'Confirm renewal fee',
    owner: 'Alex',
    targetDate: '2026-09-01',
    completed: false,
    note: 'Use the official agency page.',
  }, { id: 'step-1', now });
  assert.deepEqual(
    { id: step.id, recordId: step.recordId, title: step.title, owner: step.owner, targetDate: step.targetDate, completed: step.completed },
    { id: 'step-1', recordId: 'permit-1', title: 'Confirm renewal fee', owner: 'Alex', targetDate: '2026-09-01', completed: false },
  );
  assert.equal(classifyWorkStep(step, '2026-09-02').key, 'overdue');
  assert.equal(classifyWorkStep({ ...step, targetDate: '2026-09-05' }, '2026-09-02').key, 'next');
  assert.equal(classifyWorkStep({ ...step, completed: true }, '2026-09-02').key, 'completed');
  assert.throws(() => createWorkStep({ recordId: '', title: 'No permit' }), /record/i);
  assert.throws(() => createWorkStep({ recordId: record.id, title: '' }), /title/i);
  assert.throws(() => createWorkStep({ recordId: record.id, title: 'Bad date', targetDate: '09\/01\/2026' }), /target date/i);
});

test('portfolio review groups records and surfaces exceptions and step completion', () => {
  const steps = [
    createWorkStep({ recordId: record.id, title: 'Confirm renewal fee', owner: 'Alex', targetDate: '2026-09-01' }, { id: 'step-1', now }),
    createWorkStep({ recordId: record.id, title: 'Submit packet', owner: 'Alex', targetDate: '2026-09-10', completed: true }, { id: 'step-2', now }),
  ];
  const missing = createRecord({ name: 'Fire inspection', location: 'South Loop', agency: 'Fire office' }, { id: 'permit-2', now });
  const review = buildPortfolioReview([record, missing], steps, '2026-09-02', now);
  assert.equal(review.totals.records, 2);
  assert.equal(review.totals.steps, 2);
  assert.equal(review.totals.completedSteps, 1);
  assert.equal(review.totals.overdueSteps, 1);
  assert.ok(review.groups.urgency.some((group) => group.key === 'renew'));
  assert.ok(review.groups.location.some((group) => group.key === 'West Loop'));
  assert.ok(review.groups.owner.some((group) => group.key === 'Operations'));
  assert.ok(review.exceptions.some((item) => item.recordId === 'permit-2' && item.missing.includes('expiration date')));
});

test('activity entries are chronological and formula-safe in CSV', () => {
  const later = createActivityEntry({ action: 'step.completed', entityId: 'step-1', recordId: record.id, summary: '=Completed step' }, { id: 'activity-2', at: '2026-09-02T13:00:00.000Z' });
  const earlier = createActivityEntry({ action: 'record.created', entityId: record.id, recordId: record.id, summary: 'Created Food permit' }, { id: 'activity-1', at: now });
  const csv = activityToCsv([later, earlier]);
  assert.ok(csv.indexOf('2026-09-02T12:00:00.000Z') < csv.indexOf('2026-09-02T13:00:00.000Z'));
  assert.match(csv, /"'=Completed step"/);
});

test('schema 2 backup round-trips Pro data and schema 1 backups migrate safely', () => {
  const step = createWorkStep({ recordId: record.id, title: 'Confirm renewal fee', owner: 'Alex' }, { id: 'step-1', now });
  const activity = createActivityEntry({ action: 'record.created', entityId: record.id, recordId: record.id, summary: 'Created Food permit' }, { id: 'activity-1', at: now });
  const parsed = parseBackup(createBackup([record], { steps: [step], activity: [activity] }, now));
  assert.equal(BACKUP_SCHEMA, 2);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.pro.steps[0].id, 'step-1');
  assert.equal(parsed.pro.activity[0].id, 'activity-1');

  const migrated = parseBackup(JSON.stringify({ schema: 1, product: 'PermitKeep', exportedAt: now, records: [record] }));
  assert.equal(migrated.records.length, 1);
  assert.deepEqual(migrated.pro, { steps: [], activity: [] });
});
