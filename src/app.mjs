import { buildCalendar, classifyDeadline, recordsToCsv, renewalDate, sortByUrgency } from './core.mjs';
import { exportBackup, importBackup, loadRecords, removeRecord, saveRecords, STORAGE_KEY, upsertRecord } from './store.mjs';

const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
let records = [];
let editingId = null;
let filter = 'all';
let query = '';
let storageRecovery = null;

const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function announce(message, tone = 'success') {
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  toast.hidden = false;
  clearTimeout(announce.timer);
  announce.timer = setTimeout(() => { toast.hidden = true; }, 4200);
}

function persist(next, message) {
  saveRecords(next);
  records = next;
  render();
  if (message) announce(message);
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function summary() {
  const counts = { expired: 0, renew: 0, upcoming: 0, missing: 0, current: 0 };
  records.forEach((record) => counts[classifyDeadline(record, today()).key]++);
  return counts;
}

function matches(record) {
  const status = classifyDeadline(record, today()).key;
  const statusMatch = filter === 'all' || filter === status || (filter === 'action' && ['expired', 'renew', 'missing'].includes(status));
  const haystack = [record.name, record.location, record.agency, record.owner, record.permitNumber, record.category].join(' ').toLowerCase();
  return statusMatch && haystack.includes(query.toLowerCase());
}

function recordCard(record) {
  const status = classifyDeadline(record, today());
  const renew = record.expirationDate ? renewalDate(record.expirationDate, record.leadDays) : '';
  return `<article class="record-card" data-id="${escapeHtml(record.id)}">
    <div class="record-top">
      <div>
        <p class="eyebrow">${escapeHtml(record.category || 'Permit or renewal')} · ${escapeHtml(record.location)}</p>
        <h3>${escapeHtml(record.name)}</h3>
      </div>
      <span class="status status-${status.tone}">${escapeHtml(status.label)}</span>
    </div>
    <dl class="record-grid">
      <div><dt>Start renewal</dt><dd>${renew || 'Set an expiration date'}</dd></div>
      <div><dt>Expires</dt><dd>${record.expirationDate || 'Not set'}</dd></div>
      <div><dt>Agency</dt><dd>${escapeHtml(record.agency)}</dd></div>
      <div><dt>Owner</dt><dd>${escapeHtml(record.owner || 'Unassigned')}</dd></div>
    </dl>
    ${record.notes ? `<p class="notes">${escapeHtml(record.notes)}</p>` : ''}
    <div class="record-actions">
      ${record.authorityUrl ? `<a class="button button-quiet" href="${escapeHtml(record.authorityUrl)}" target="_blank" rel="noopener noreferrer">Agency page <span aria-hidden="true">↗</span></a>` : ''}
      <button class="button button-quiet" type="button" data-action="edit" aria-label="Edit ${escapeHtml(record.name)}">Edit</button>
      <button class="button button-danger" type="button" data-action="delete" aria-label="Delete ${escapeHtml(record.name)}">Delete</button>
    </div>
  </article>`;
}

function formTemplate() {
  const record = editingId ? records.find((item) => item.id === editingId) : {};
  const value = (field) => escapeHtml(record?.[field] ?? '');
  return `<section class="panel editor" id="editor" aria-labelledby="editor-title">
    <div class="section-heading"><div><p class="eyebrow">Private local record</p><h2 id="editor-title">${editingId ? 'Edit deadline' : 'Add a deadline'}</h2></div><p>Only you enter the agency facts. PermitKeep does not guess rules.</p></div>
    <form id="record-form">
      <input type="hidden" name="id" value="${value('id')}">
      <div class="field-grid">
        <label class="field field-wide"><span>Permit, license, or renewal name <b aria-hidden="true">*</b></span><input name="name" required maxlength="300" autocomplete="off" value="${value('name')}" placeholder="Food establishment permit"></label>
        <label class="field"><span>Location <b aria-hidden="true">*</b></span><input name="location" required maxlength="300" autocomplete="off" value="${value('location')}" placeholder="West Loop store"></label>
        <label class="field"><span>Category</span><select name="category"><option value="">Choose one</option>${['Business license','Permit','Inspection','Certification','Insurance','Lease or registration','Other'].map((option) => `<option${record?.category === option ? ' selected' : ''}>${option}</option>`).join('')}</select></label>
        <label class="field"><span>Issuing agency <b aria-hidden="true">*</b></span><input name="agency" required maxlength="300" autocomplete="organization" value="${value('agency')}" placeholder="City licensing office"></label>
        <label class="field"><span>Permit or account number</span><input name="permitNumber" maxlength="300" autocomplete="off" value="${value('permitNumber')}" placeholder="Optional"></label>
        <label class="field"><span>Expiration date</span><input name="expirationDate" type="date" value="${value('expirationDate')}"></label>
        <label class="field"><span>Start renewal this many days early</span><input name="leadDays" type="number" min="0" max="365" step="1" value="${record?.leadDays ?? 60}"></label>
        <label class="field"><span>Owner</span><input name="owner" maxlength="300" autocomplete="off" value="${value('owner')}" placeholder="Person or role"></label>
        <label class="field"><span>Official agency URL</span><input name="authorityUrl" type="url" maxlength="300" inputmode="url" value="${value('authorityUrl')}" placeholder="https://agency.gov/renew"></label>
        <label class="field field-wide"><span>Notes</span><textarea name="notes" maxlength="2000" rows="3" placeholder="Required documents, fee-check note, or handoff context">${value('notes')}</textarea></label>
      </div>
      <div class="form-footer"><p id="renewal-preview" class="preview" aria-live="polite"></p><div><button class="button button-quiet" id="cancel-edit" type="button" ${editingId ? '' : 'hidden'}>Cancel</button><button class="button button-primary" type="submit">${editingId ? 'Save changes' : 'Add deadline'}</button></div></div>
    </form>
  </section>`;
}

function render() {
  if (storageRecovery) {
    app.innerHTML = `<header class="site-header"><a class="brand" href="./" aria-label="PermitKeep home"><span class="brand-mark" aria-hidden="true">PK</span><span>PermitKeep<small>Local data recovery</small></span></a></header><main id="top" tabindex="-1"><section class="panel recovery-panel" aria-labelledby="recovery-title"><p class="eyebrow">Write protection active</p><h1 id="recovery-title">Your local records could not be opened.</h1><p>PermitKeep has not changed the unreadable browser data. Download the damaged data for recovery or support, then reset only when you are ready to start empty or restore a known-good backup.</p><div class="boundary"><strong>Do not reset before preserving what you may need.</strong><p>${escapeHtml(storageRecovery.message)}</p></div><div class="recovery-actions"><button class="button button-primary" id="download-damaged-data" type="button">Download damaged data</button><button class="button button-danger" id="reset-local-data" type="button">Reset local data</button></div></section></main>`;
    document.querySelector('#download-damaged-data').addEventListener('click', () => download(`permitkeep-damaged-data-${today()}.txt`, storageRecovery.raw, 'text/plain;charset=utf-8'));
    document.querySelector('#reset-local-data').addEventListener('click', () => {
      if (!confirm('Reset the unreadable local data? Download it first if you may need recovery. This cannot be undone.')) return;
      localStorage.removeItem(STORAGE_KEY);
      storageRecovery = null;
      records = [];
      render();
      announce('Local data reset. You can now restore a backup or start a new ledger.');
    });
    return;
  }
  const counts = summary();
  const visible = sortByUrgency(records, today()).filter(matches);
  app.innerHTML = `<header class="site-header"><a class="brand" href="#top" aria-label="PermitKeep home"><span class="brand-mark" aria-hidden="true">PK</span><span>PermitKeep<small>Renewals without the spreadsheet scramble</small></span></a><nav><a href="#deadlines">Deadlines</a><a href="./permit-renewal-tracking-checklist.html">Checklist</a><a href="./privacy.html">Privacy</a></nav></header>
  <main id="top" tabindex="-1">
    <section class="hero"><div><p class="eyebrow">Local-first permit and renewal desk</p><h1>Know what expires,<br><em>before it becomes urgent.</em></h1><p class="hero-copy">A calm, private deadline ledger for local operators with more locations than time. No account, no rule guessing, no customer-data upload.</p><div class="hero-actions"><a class="button button-primary" href="#editor">Add your first deadline</a><a class="button button-quiet" href="#deadlines">View dashboard</a></div><p class="trust-line"><span>● Data stays in this browser</span><span>● Export anytime</span><span>● No analytics</span></p></div><aside class="deadline-preview" aria-label="Example deadline"><p class="eyebrow">Next action</p><div class="preview-date"><strong>34</strong><span>days<br>remaining</span></div><h2>Annual operating permit</h2><p>Start renewal Oct 06 · Northside location</p><div class="progress"><span></span></div><small>Example only — PermitKeep never invents your dates.</small></aside></section>
    <section class="stats" aria-label="Deadline summary"><button data-filter="action" aria-pressed="${filter === 'action'}"><span>${counts.expired + counts.renew + counts.missing}</span>Needs action</button><button data-filter="upcoming" aria-pressed="${filter === 'upcoming'}"><span>${counts.upcoming}</span>Upcoming</button><button data-filter="current" aria-pressed="${filter === 'current'}"><span>${counts.current}</span>Current</button><button data-filter="all" aria-pressed="${filter === 'all'}"><span>${records.length}</span>Total records</button></section>
    ${formTemplate()}
    <section class="dashboard" id="deadlines" aria-labelledby="deadline-title"><div class="section-heading"><div><p class="eyebrow">Deadline desk</p><h2 id="deadline-title">Every renewal, one view</h2></div><p>Sorted by urgency. Dates are calculated locally from the lead time you set.</p></div>
      <div class="toolbar"><label class="search"><span class="sr-only">Search records</span><input id="search" type="search" value="${escapeHtml(query)}" placeholder="Search location, agency, owner…"></label><div class="filters" role="group" aria-label="Filter records">${[['all','All'],['action','Needs action'],['upcoming','Upcoming'],['current','Current']].map(([key,label]) => `<button type="button" class="chip${filter === key ? ' active' : ''}" data-filter="${key}" aria-pressed="${filter === key}">${label}</button>`).join('')}</div></div>
      <div class="record-list">${visible.length ? visible.map(recordCard).join('') : `<div class="empty"><span aria-hidden="true">◎</span><h3>${records.length ? 'No records match this view' : 'Your deadline desk is ready'}</h3><p>${records.length ? 'Try another filter or search term.' : 'Add one real permit, license, inspection, or certification above.'}</p></div>`}</div>
    </section>
    <section class="panel data-tools" id="privacy"><div><p class="eyebrow">Your records, your custody</p><h2>Portable by design</h2><p>PermitKeep stores records in this browser only. Back up before clearing browser data or changing devices. Calendar and CSV exports are generated on your device.</p></div><div class="tool-actions"><button class="button button-quiet" id="backup-export" type="button">Download backup</button><label class="button button-quiet file-button">Restore backup<input id="backup-import" type="file" accept="application/json,.json"></label><button class="button button-quiet" id="csv-export" type="button">Export CSV</button><button class="button button-quiet" id="ics-export" type="button">Export calendar</button></div></section>
    <section class="boundary"><strong>Operational organizer, not compliance advice.</strong><p>Always confirm requirements, dates, fees, and filing status with the issuing agency. PermitKeep does not monitor government sites, determine what your business needs, file renewals, or guarantee compliance.</p></section>
  </main><footer><span>PermitKeep</span><span><a href="./permit-renewal-tracking-checklist.html">Renewal checklist</a> · <a href="./privacy.html">Privacy</a> · Local-only by default</span></footer>`;
  bind();
  updatePreview();
}

function updatePreview() {
  const form = document.querySelector('#record-form');
  const preview = document.querySelector('#renewal-preview');
  if (!form || !preview) return;
  const expiry = form.expirationDate.value;
  const lead = Number(form.leadDays.value);
  try { preview.textContent = expiry ? `Renewal work begins ${renewalDate(expiry, lead)}.` : 'Add an expiration date to calculate a renewal start.'; }
  catch { preview.textContent = 'Enter a valid date and lead window.'; }
}

function bind() {
  document.querySelector('#record-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const input = Object.fromEntries(new FormData(event.currentTarget));
      persist(upsertRecord(records, input), editingId ? 'Deadline updated.' : 'Deadline added.');
      editingId = null;
      render();
      document.querySelector('#deadlines')?.scrollIntoView({ behavior: 'smooth' });
    } catch (error) { announce(error.message, 'error'); }
  });
  document.querySelector('#record-form')?.addEventListener('input', updatePreview);
  document.querySelector('#cancel-edit')?.addEventListener('click', () => { editingId = null; render(); });
  document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { filter = button.dataset.filter; render(); document.querySelector('#deadlines')?.scrollIntoView({ behavior: 'smooth' }); }));
  document.querySelector('#search')?.addEventListener('input', (event) => { query = event.target.value; render(); document.querySelector('#search')?.focus(); });
  document.querySelectorAll('.record-card').forEach((card) => card.addEventListener('click', (event) => {
    const action = event.target.closest('button')?.dataset.action;
    if (action === 'edit') { editingId = card.dataset.id; render(); document.querySelector('#editor')?.scrollIntoView({ behavior: 'smooth' }); }
    if (action === 'delete' && confirm('Delete this local deadline record? This cannot be undone unless it is in a backup.')) {
      persist(removeRecord(records, card.dataset.id), 'Deadline deleted.');
    }
  }));
  document.querySelector('#backup-export')?.addEventListener('click', () => download(`permitkeep-backup-${today()}.json`, exportBackup(records), 'application/json'));
  document.querySelector('#csv-export')?.addEventListener('click', () => download(`permitkeep-deadlines-${today()}.csv`, recordsToCsv(records), 'text/csv;charset=utf-8'));
  document.querySelector('#ics-export')?.addEventListener('click', () => download(`permitkeep-calendar-${today()}.ics`, buildCalendar(records), 'text/calendar;charset=utf-8'));
  document.querySelector('#backup-import')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const incoming = importBackup(await file.text());
      if (records.length && !confirm(`Replace ${records.length} local record(s) with ${incoming.length} from this backup?`)) return;
      persist(incoming, `${incoming.length} record(s) restored.`);
    } catch (error) { announce(error.message, 'error'); }
    finally { event.target.value = ''; }
  });
}

try { records = loadRecords(); } catch (error) { records = []; storageRecovery = { message: error.message, raw: localStorage.getItem(STORAGE_KEY) ?? '' }; }
render();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => {});
