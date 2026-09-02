import { createActivityEntry, createBackup, createRecord, createWorkStep, MAX_ACTIVITY_ENTRIES, MAX_RECORDS, MAX_WORK_STEPS, parseBackup } from './core.mjs';

const STORAGE_KEY = 'permitkeep.records.v1';
const PRO_STORAGE_KEY = 'permitkeep.pro-data.v1';

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
  const next = createRecord({ ...existing, ...input }, { id: input.id || options.id, now: options.now || new Date().toISOString() });
  return existing ? records.map((record) => record.id === next.id ? next : record) : [...records, next];
}

export function removeRecord(records, id) {
  return records.filter((record) => record.id !== id);
}

export function loadProData(storage = globalThis.localStorage) {
  const raw = storage?.getItem(PRO_STORAGE_KEY);
  if (!raw) return { steps: [], activity: [] };
  try {
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.steps) || !Array.isArray(data.activity)) throw new Error('Stored Pro data is invalid.');
    if (data.steps.length > MAX_WORK_STEPS || data.activity.length > MAX_ACTIVITY_ENTRIES) throw new Error('Stored Pro data is too large.');
    const steps = data.steps.map((step) => createWorkStep(step, { id: step?.id, now: step?.updatedAt }));
    const activity = data.activity.map((entry) => createActivityEntry(entry, { id: entry?.id, at: entry?.at }));
    if (new Set(steps.map((step) => step.id)).size !== steps.length) throw new Error('Stored Pro data contains duplicate work-step identifiers.');
    if (new Set(activity.map((entry) => entry.id)).size !== activity.length) throw new Error('Stored Pro data contains duplicate activity identifiers.');
    return { steps, activity };
  } catch (error) {
    throw new Error(`PermitKeep could not read local Pro data: ${error.message}`);
  }
}

export function saveProData(pro, storage = globalThis.localStorage) {
  if (!pro || !Array.isArray(pro.steps) || !Array.isArray(pro.activity)) throw new Error('Pro data is invalid.');
  if (pro.steps.length > MAX_WORK_STEPS || pro.activity.length > MAX_ACTIVITY_ENTRIES) throw new Error('Pro data is too large.');
  storage?.setItem(PRO_STORAGE_KEY, JSON.stringify(pro));
}

export function upsertWorkStep(steps, input, options = {}) {
  const existing = input.id ? steps.find((step) => step.id === input.id) : null;
  const next = createWorkStep({ ...existing, ...input }, { id: input.id || options.id, now: options.now || new Date().toISOString() });
  return existing ? steps.map((step) => step.id === next.id ? next : step) : [...steps, next];
}

export function removeWorkStep(steps, id) {
  return steps.filter((step) => step.id !== id);
}

export function exportBackup(records, pro = { steps: [], activity: [] }) {
  return createBackup(records, pro);
}

export function importBackup(text) {
  return parseBackup(text).records;
}

export function importFullBackup(text) {
  return parseBackup(text);
}

export { PRO_STORAGE_KEY, STORAGE_KEY };
