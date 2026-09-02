import { createBackup, createRecord, MAX_RECORDS, parseBackup } from './core.mjs';

const STORAGE_KEY = 'permitkeep.records.v1';

export function loadRecords(storage = globalThis.localStorage) {
  const raw = storage?.getItem(STORAGE_KEY);
  if (!raw) return [];
  let data;
  try {
    data = JSON.parse(raw);
    if (!Array.isArray(data) || data.length > MAX_RECORDS) throw new Error('Stored record set is invalid.');
    const records = data.map((record) => createRecord(record, { id: record?.id, now: record?.updatedAt }));
    if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error('Stored record set contains duplicate identifiers.');
    return records;
  } catch (error) {
    throw new Error(`PermitKeep could not read local data: ${error.message}`);
  }
}

export function saveRecords(records, storage = globalThis.localStorage) {
  if (!Array.isArray(records) || records.length > MAX_RECORDS) throw new Error(`PermitKeep supports up to ${MAX_RECORDS} records.`);
  storage?.setItem(STORAGE_KEY, JSON.stringify(records));
}

export function upsertRecord(records, input, options = {}) {
  const existing = input.id ? records.find((record) => record.id === input.id) : null;
  const next = createRecord({ ...existing, ...input }, { id: input.id || options.id, now: options.now });
  return existing ? records.map((record) => record.id === next.id ? next : record) : [...records, next];
}

export function removeRecord(records, id) {
  return records.filter((record) => record.id !== id);
}

export function exportBackup(records) {
  return createBackup(records);
}

export function importBackup(text) {
  return parseBackup(text).records;
}

export { STORAGE_KEY };
