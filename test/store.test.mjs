import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecord } from '../src/core.mjs';
import { loadRecords, saveRecords, STORAGE_KEY } from '../src/store.mjs';

const base = {
  name: 'Operating permit',
  location: 'North location',
  agency: 'Licensing office',
  expirationDate: '2026-12-31',
  leadDays: 60,
};

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('local store round-trips normalized records', () => {
  const storage = memoryStorage();
  const record = createRecord(base, { id: 'one', now: '2026-09-02T12:00:00.000Z' });
  saveRecords([record], storage);
  assert.deepEqual(loadRecords(storage), [record]);
});

test('local store reports corrupt values without returning partial data', () => {
  const storage = memoryStorage({ [STORAGE_KEY]: '{broken' });
  assert.throws(() => loadRecords(storage), /could not read local data/i);
});

test('local store rejects duplicate identifiers', () => {
  const record = createRecord(base, { id: 'same', now: '2026-09-02T12:00:00.000Z' });
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify([record, { ...record, name: 'Other permit' }]) });
  assert.throws(() => loadRecords(storage), /duplicate identifiers/i);
});
