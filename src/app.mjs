import {
  activityToCsv,
  buildCalendar,
  buildPortfolioReview,
  classifyDeadline,
  classifyWorkStep,
  createActivityEntry,
  recordsToCsv,
  renewalDate,
  sortByUrgency,
} from './core.mjs';
import {
  exportBackup,
  importFullBackup,
  loadProData,
  loadRecords,
  PRO_STORAGE_KEY,
  removeRecord,
  removeWorkStep,
  saveProData,
  saveRecords,
  STORAGE_KEY,
  upsertRecord,
  upsertWorkStep,
} from './store.mjs';
import { loadLicense, saveLicense, verifyLicenseCode } from './license.mjs';

const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
let records = [];
let proData = { steps: [], activity: [] };
let editingId = null;
let editingStepId = null;
let filter = 'all';
let query = '';
let storageRecovery = null;
let license = null;
let reportGrouping = 'urgency';
const isPro = () => license?.product === 'permitkeep-pro-v1';

const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const recordName = (id) => records.find((record) => record.id === id)?.name || 'Deleted record';

function announce(message, tone = 'success') {
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  toast.hidden = false;
  clearTimeout(announce.timer);
  announce.timer = setTimeout(() => { toast.hidden = true; }, 4200);
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

function activity(action, entityId, recordId, summary) {
  return createActivityEntry({ action, entityId, recordId, summary });
}

function persistState(nextRecords, nextPro, message, afterSave) {
  const previousRecords = localStorage.getItem(STORAGE_KEY);
  const previousPro = localStorage.getItem(PRO_STORAGE_KEY);
  try {
    saveRecords(nextRecords);
    saveProData(nextPro);
  } catch (error) {
    try {
      if (previousRecords === null) localStorage.removeItem(STORAGE_KEY); else localStorage.setItem(STORAGE_KEY, previousRecords);
      if (previousPro === null) localStorage.removeItem(PRO_STORAGE_KEY); else localStorage.setItem(PRO_STORAGE_KEY, previousPro);
    } catch {}
    throw error;
  }
  records = nextRecords;
  proData = nextPro;
  afterSave?.();
  render();
  if (message) announce(message);
}

// A saved record may no longer match the active search/filter. Keep keyboard
// users in the dashboard without silently changing their chosen view.
function focusRecordAction(id) {
  const card = [...document.querySelectorAll('.record-card')].find(item => item.dataset.id === id);
  (card?.querySelector('[data-action="edit"]') || document.querySelector('#search'))?.focus();
}

function focusStepAction(id, action = 'edit') {
  const card = [...document.querySelectorAll('.step-card')].find(item => item.dataset.stepId === id);
  (card?.querySelector(`[data-step-action="${action}"]`) || document.querySelector('#step-form [name="title"]'))?.focus();
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
  const openSteps = proData.steps.filter((step) => step.recordId === record.id && !step.completed).sort((a, b) => (a.targetDate || '9999-12-31').localeCompare(b.targetDate || '9999-12-31'));
  const overdue = openSteps.filter((step) => classifyWorkStep(step, today()).key === 'overdue');
  const next = openSteps.find((step) => step.targetDate) || openSteps[0];
  const proSummary = isPro() ? `<div class="record-work-summary"><strong>${overdue.length ? `${overdue.length} overdue step${overdue.length === 1 ? '' : 's'}` : 'No overdue steps'}</strong><span>${next ? `Next: ${escapeHtml(next.title)}${next.targetDate ? ` · ${next.targetDate}` : ' · date needed'}` : 'No open work-plan steps'}</span></div>` : '';
  return `<article class="record-card" data-id="${escapeHtml(record.id)}">
    <div class="record-top"><div><p class="eyebrow">${escapeHtml(record.category || 'Permit or renewal')} · ${escapeHtml(record.location)}</p><h3>${escapeHtml(record.name)}</h3></div><span class="status status-${status.tone}">${escapeHtml(status.label)}</span></div>
    <dl class="record-grid"><div><dt>Start renewal</dt><dd>${renew || 'Set an expiration date'}</dd></div><div><dt>Expires</dt><dd>${record.expirationDate || 'Not set'}</dd></div><div><dt>Agency</dt><dd>${escapeHtml(record.agency)}</dd></div><div><dt>Owner</dt><dd>${escapeHtml(record.owner || 'Unassigned')}</dd></div></dl>
    ${proSummary}${record.notes ? `<p class="notes">${escapeHtml(record.notes)}</p>` : ''}
    <div class="record-actions">${record.authorityUrl ? `<a class="button button-quiet" href="${escapeHtml(record.authorityUrl)}" target="_blank" rel="noopener noreferrer">Agency page <span aria-hidden="true">↗</span></a>` : ''}<button class="button button-quiet" type="button" data-action="edit" aria-label="Edit ${escapeHtml(record.name)}">Edit</button><button class="button button-danger" type="button" data-action="delete" aria-label="Delete ${escapeHtml(record.name)}">Delete</button></div>
  </article>`;
}

function formTemplate() {
  const record = editingId ? records.find((item) => item.id === editingId) : {};
  const value = (field) => escapeHtml(record?.[field] ?? '');
  return `<section class="panel editor" id="editor" aria-labelledby="editor-title"><div class="section-heading"><div><p class="eyebrow">Private local record</p><h2 id="editor-title">${editingId ? 'Edit deadline' : 'Add a deadline'}</h2></div><p>Only you enter the agency facts. PermitKeep does not guess rules.</p></div>
    <form id="record-form"><input type="hidden" name="id" value="${value('id')}"><div class="field-grid">
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
    </div><div class="form-footer"><p id="renewal-preview" class="preview" aria-live="polite"></p><div><button class="button button-quiet" id="cancel-edit" type="button" ${editingId ? '' : 'hidden'}>Cancel</button><button class="button button-primary" type="submit">${editingId ? 'Save changes' : 'Add deadline'}</button></div></div></form>
  </section>`;
}

function activationMarkup() {
  if (isPro()) return '<p class="license-active"><strong>PermitKeep Pro v1 active.</strong> The signed license verifies offline in this browser.</p>';
  return `<div class="pro-preview"><p class="eyebrow">Pro capability preview</p><h2>Run the renewal work, not only the deadline list.</h2><p>The free edition keeps unlimited deadline records, backup/restore, CSV, and calendar export. PermitKeep Pro v1 adds assignable renewal work plans, a print/PDF-ready portfolio review, and local activity history.</p><div class="pro-offer"><div><strong>Checkout is not available yet</strong><span>Pro remains disabled while test-mode payment and fulfillment are verified.</span></div><button class="button button-primary" type="button" disabled aria-disabled="true">Purchase unavailable</button></div><p class="commercial-note">No payment is being accepted for PermitKeep Pro. Existing development licenses can still be verified locally for testing.</p><form id="license-form" class="license-form"><label class="field"><span>Signed PermitKeep Pro license code</span><textarea name="code" rows="3" autocomplete="off" spellcheck="false" placeholder="Paste your signed license code" required></textarea></label><div><button class="button button-primary" type="submit">Verify and activate</button><p id="license-result" aria-live="polite"></p></div></form></div>`;
}

function stepFormMarkup() {
  const step = editingStepId ? proData.steps.find((item) => item.id === editingStepId) : {};
  const value = (field) => escapeHtml(step?.[field] ?? '');
  return `<form id="step-form" class="step-form"><input type="hidden" name="id" value="${value('id')}"><div class="field-grid">
    <label class="field"><span>Permit or renewal <b aria-hidden="true">*</b></span><select name="recordId" required><option value="">Choose a record</option>${records.map((record) => `<option value="${escapeHtml(record.id)}"${step?.recordId === record.id ? ' selected' : ''}>${escapeHtml(record.name)} · ${escapeHtml(record.location)}</option>`).join('')}</select></label>
    <label class="field"><span>Action step <b aria-hidden="true">*</b></span><input name="title" required maxlength="300" value="${value('title')}" placeholder="Confirm documents and current fee"></label>
    <label class="field"><span>Owner</span><input name="owner" maxlength="300" value="${value('owner')}" placeholder="Person or role"></label>
    <label class="field"><span>Target date</span><input name="targetDate" type="date" value="${value('targetDate')}"></label>
    <label class="field field-wide"><span>Handoff note</span><textarea name="note" maxlength="2000" rows="2" placeholder="What the owner needs to know">${value('note')}</textarea></label>
  </div><div class="form-footer"><p class="preview">Stored only in this browser and included in your backup.</p><div><button class="button button-quiet" id="cancel-step-edit" type="button" ${editingStepId ? '' : 'hidden'}>Cancel</button><button class="button button-primary" type="submit">${editingStepId ? 'Save step' : 'Add work step'}</button></div></div></form>`;
}

function stepCard(step) {
  const status = classifyWorkStep(step, today());
  return `<article class="step-card${step.completed ? ' completed' : ''}" data-step-id="${escapeHtml(step.id)}"><div><p class="eyebrow">${escapeHtml(recordName(step.recordId))}</p><h3>${escapeHtml(step.title)}</h3><p>${escapeHtml(step.owner || 'Unassigned')} · ${step.targetDate || 'No target date'}${step.note ? ` · ${escapeHtml(step.note)}` : ''}</p></div><span class="status status-${status.tone}">${escapeHtml(status.label)}</span><div class="step-actions"><button class="button button-quiet" data-step-action="toggle" type="button">${step.completed ? 'Reopen' : 'Complete'}</button><button class="button button-quiet" data-step-action="edit" type="button">Edit</button><button class="button button-danger" data-step-action="delete" type="button">Delete</button></div></article>`;
}

function reportMarkup(review) {
  const groups = review.groups[reportGrouping];
  const recordRow = (record) => {
    const steps = review.stepsByRecord[record.id] || [];
    const done = steps.filter((step) => step.completed).length;
    return `<tr><th scope="row">${escapeHtml(record.name)}</th><td>${escapeHtml(record.location)}</td><td>${escapeHtml(record.owner || 'Unassigned')}</td><td>${escapeHtml(classifyDeadline(record, review.asOf).label)}</td><td>${done}/${steps.length}</td></tr>`;
  };
  return `<section class="portfolio-report" id="portfolio-report" aria-labelledby="report-title"><div class="report-heading"><div><p class="eyebrow">Local management report · as of ${review.asOf}</p><h2 id="report-title">PermitKeep portfolio review</h2></div><button class="button button-primary no-print" id="print-report" type="button">Print / save PDF</button></div>
    <div class="report-totals"><span><strong>${review.totals.records}</strong> ${review.totals.records === 1 ? 'record' : 'records'}</span><span><strong>${review.totals.steps}</strong> ${review.totals.steps === 1 ? 'step' : 'steps'}</span><span><strong>${review.totals.completedSteps}</strong> complete</span><span><strong>${review.totals.overdueSteps}</strong> overdue</span><span><strong>${review.totals.exceptions}</strong> ${review.totals.exceptions === 1 ? 'exception' : 'exceptions'}</span></div>
    <div class="report-tabs no-print" role="group" aria-label="Group report by">${[['urgency','Urgency'],['location','Location'],['owner','Owner']].map(([key,label]) => `<button class="chip${reportGrouping === key ? ' active' : ''}" data-report-group="${key}" aria-pressed="${reportGrouping === key}">${label}</button>`).join('')}</div>
    ${review.nextDueStep ? `<p class="next-due"><strong>Next due step:</strong> ${escapeHtml(review.nextDueStep.title)} · ${escapeHtml(recordName(review.nextDueStep.recordId))} · ${review.nextDueStep.targetDate}</p>` : '<p class="next-due">No open dated steps.</p>'}
    ${groups.map((group) => `<section class="report-group"><h3>${escapeHtml(group.label)}</h3><div class="table-wrap"><table><thead><tr><th>Record</th><th>Location</th><th>Owner</th><th>Urgency</th><th>Steps</th></tr></thead><tbody>${group.records.map(recordRow).join('')}</tbody></table></div></section>`).join('') || '<p>No records to report.</p>'}
    <section class="report-exceptions"><h3>Missing-data exceptions</h3>${review.exceptions.length ? `<ul>${review.exceptions.map((item) => `<li><strong>${escapeHtml(item.name)}</strong> (${escapeHtml(item.location)}): ${escapeHtml(item.missing.join(', '))}</li>`).join('')}</ul>` : '<p>No missing-data exceptions.</p>'}</section>
  </section>`;
}

function proWorkspaceMarkup() {
  if (!isPro()) return `<section class="panel pro-panel" id="pro" aria-labelledby="pro-title">${activationMarkup()}</section>`;
  const review = buildPortfolioReview(records, proData.steps, today());
  const sortedSteps = [...proData.steps].sort((a, b) => Number(a.completed) - Number(b.completed) || (a.targetDate || '9999-12-31').localeCompare(b.targetDate || '9999-12-31'));
  const history = [...proData.activity].sort((a, b) => b.at.localeCompare(a.at));
  return `<section class="pro-workspace" id="pro" aria-labelledby="pro-title"><div class="section-heading"><div><p class="eyebrow">PermitKeep Pro v1 · local operations</p><h2 id="pro-title">Renewal work plans</h2></div><p>Assign concrete steps, review the portfolio, and keep a candid local change history.</p></div>
    <div class="pro-kpis"><span><strong>${review.totals.overdueSteps}</strong> ${review.totals.overdueSteps === 1 ? 'overdue step' : 'overdue steps'}</span><span><strong>${review.nextDueStep?.targetDate || '—'}</strong> next due date</span><span><strong>${review.totals.completedSteps}/${review.totals.steps}</strong> ${review.totals.steps === 1 ? 'step complete' : 'steps complete'}</span></div>
    <section class="panel step-editor" aria-labelledby="step-editor-title"><h3 id="step-editor-title">${editingStepId ? 'Edit work step' : 'Add a work step'}</h3>${records.length ? stepFormMarkup() : '<p>Add a deadline record before building its renewal work plan.</p>'}</section>
    <div class="step-list">${sortedSteps.length ? sortedSteps.map(stepCard).join('') : '<div class="empty compact"><h3>No work-plan steps yet</h3><p>Add the first assignable renewal action above.</p></div>'}</div>
    ${reportMarkup(review)}
    <section class="panel activity-panel" aria-labelledby="activity-title"><div class="section-heading"><div><p class="eyebrow">Local activity history</p><h2 id="activity-title">What changed</h2></div><div><button class="button button-quiet" id="activity-export" type="button">Export history CSV</button></div></div><p class="commercial-note">This is a chronological local activity history, not a tamper-proof legal audit trail.</p><ol class="activity-list">${history.length ? history.slice(0, 200).map((entry) => `<li><time datetime="${escapeHtml(entry.at)}">${escapeHtml(new Date(entry.at).toLocaleString())}</time><span>${escapeHtml(entry.summary)}</span></li>`).join('') : '<li>No recorded changes yet.</li>'}</ol></section>
    <section class="panel license-panel">${activationMarkup()}</section>
  </section>`;
}

function render() {
  if (storageRecovery) {
    app.innerHTML = `<header class="site-header"><a class="brand" href="./" aria-label="PermitKeep home"><span class="brand-mark" aria-hidden="true">PK</span><span>PermitKeep<small>Local data recovery</small></span></a></header><main id="top" tabindex="-1"><section class="panel recovery-panel" aria-labelledby="recovery-title"><p class="eyebrow">Write protection active</p><h1 id="recovery-title">Your local data could not be opened.</h1><p>PermitKeep has not changed the unreadable browser data. Download the damaged value, then reset only that storage area when you are ready.</p><div class="boundary"><strong>Do not reset before preserving what you may need.</strong><p>${escapeHtml(storageRecovery.message)}</p></div><div class="recovery-actions"><button class="button button-primary" id="download-damaged-data" type="button">Download damaged data</button><button class="button button-danger" id="reset-local-data" type="button">Reset damaged local data</button></div></section></main>`;
    document.querySelector('#download-damaged-data').addEventListener('click', () => download(`permitkeep-damaged-data-${today()}.txt`, storageRecovery.raw, 'text/plain;charset=utf-8'));
    document.querySelector('#reset-local-data').addEventListener('click', () => {
      if (!confirm('Reset this unreadable local data? Download it first if you may need recovery. This cannot be undone.')) return;
      localStorage.removeItem(storageRecovery.key);
      storageRecovery = null;
      initialize();
    });
    return;
  }
  const counts = summary();
  const visible = sortByUrgency(records, today()).filter(matches);
  app.innerHTML = `<header class="site-header"><a class="brand" href="#top" aria-label="PermitKeep home"><span class="brand-mark" aria-hidden="true">PK</span><span>PermitKeep<small>Renewals without the spreadsheet scramble</small></span></a><nav><a href="#deadlines">Deadlines</a><a href="#pro">Pro</a><a href="./permit-renewal-tracking-checklist.html">Checklist</a><a href="./privacy.html">Privacy</a><a href="./terms.html">Terms</a></nav></header>
  <main id="top" tabindex="-1"><section class="hero"><div><p class="eyebrow">Local-first permit and renewal desk</p><h1>Know what expires,<br><em>before it becomes urgent.</em></h1><p class="hero-copy">A calm, private deadline ledger for local operators with more locations than time. No account, no rule guessing, no customer-data upload.</p><div class="hero-actions"><a class="button button-primary" href="#editor">Add your first deadline</a><a class="button button-quiet" href="#deadlines">View dashboard</a></div><p class="trust-line"><span>● Data stays in this browser</span><span>● Export anytime</span><span>● No analytics</span></p></div><aside class="deadline-preview" aria-label="Example deadline"><p class="eyebrow">Next action</p><div class="preview-date"><strong>34</strong><span>days<br>remaining</span></div><h2>Annual operating permit</h2><p>Start renewal Oct 06 · Northside location</p><div class="progress"><span></span></div><small>Example only — PermitKeep never invents your dates.</small></aside></section>
    <section class="stats" aria-label="Deadline summary"><button data-filter="action" aria-pressed="${filter === 'action'}"><span>${counts.expired + counts.renew + counts.missing}</span>Needs action</button><button data-filter="upcoming" aria-pressed="${filter === 'upcoming'}"><span>${counts.upcoming}</span>Upcoming</button><button data-filter="current" aria-pressed="${filter === 'current'}"><span>${counts.current}</span>Current</button><button data-filter="all" aria-pressed="${filter === 'all'}"><span>${records.length}</span>Total records</button></section>
    ${formTemplate()}
    <section class="dashboard" id="deadlines" aria-labelledby="deadline-title"><div class="section-heading"><div><p class="eyebrow">Deadline desk</p><h2 id="deadline-title">Every renewal, one view</h2></div><p>Sorted by urgency. Dates are calculated locally from the lead time you set.</p></div><div class="toolbar"><label class="search"><span class="sr-only">Search records</span><input id="search" type="search" value="${escapeHtml(query)}" placeholder="Search location, agency, owner…"></label><div class="filters" role="group" aria-label="Filter records">${[['all','All'],['action','Needs action'],['upcoming','Upcoming'],['current','Current']].map(([key,label]) => `<button type="button" class="chip${filter === key ? ' active' : ''}" data-filter="${key}" aria-pressed="${filter === key}">${label}</button>`).join('')}</div></div><div class="record-list">${visible.length ? visible.map(recordCard).join('') : `<div class="empty"><span aria-hidden="true">◎</span><h3>${records.length ? 'No records match this view' : 'Your deadline desk is ready'}</h3><p>${records.length ? 'Try another filter or search term.' : 'Add one real permit, license, inspection, or certification above.'}</p></div>`}</div></section>
    <section class="panel data-tools" id="privacy"><div><p class="eyebrow">Your records, your custody</p><h2>Portable by design</h2><p>PermitKeep stores records in this browser only. Backup includes deadline records plus any Pro work plans and activity history. Free schema-1 backups remain restorable.</p></div><div class="tool-actions"><button class="button button-quiet" id="backup-export" type="button">Download backup</button><label class="button button-quiet file-button">Restore backup<input id="backup-import" type="file" accept="application/json,.json"></label><button class="button button-quiet" id="csv-export" type="button">Export deadlines CSV</button><button class="button button-quiet" id="ics-export" type="button">Export calendar</button></div></section>
    ${proWorkspaceMarkup()}
    <section class="boundary"><strong>Operational organizer, not compliance advice.</strong><p>Always confirm requirements, dates, fees, and filing status with the issuing agency. PermitKeep does not monitor government sites, determine what your business needs, file renewals, or guarantee compliance.</p></section>
  </main><footer><span>PermitKeep</span><span><a href="./permit-renewal-tracking-checklist.html">Renewal checklist</a> · <a href="./privacy.html">Privacy</a> · <a href="./terms.html">Terms</a> · Local-only by default</span></footer>`;
  bind();
  updatePreview();
}

function updatePreview() {
  const form = document.querySelector('#record-form');
  const preview = document.querySelector('#renewal-preview');
  if (!form || !preview) return;
  try { preview.textContent = form.expirationDate.value ? `Renewal work begins ${renewalDate(form.expirationDate.value, Number(form.leadDays.value))}.` : 'Add an expiration date to calculate a renewal start.'; }
  catch { preview.textContent = 'Enter a valid date and lead window.'; }
}

function bind() {
  document.querySelector('#record-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const input = Object.fromEntries(new FormData(event.currentTarget));
      const wasEditing = Boolean(editingId);
      const nextRecords = upsertRecord(records, input);
      const changed = nextRecords.find((record) => record.id === (input.id || nextRecords.at(-1).id));
      const nextPro = { ...proData, activity: [...proData.activity, activity(wasEditing ? 'record.updated' : 'record.created', changed.id, changed.id, `${wasEditing ? 'Updated' : 'Created'} ${changed.name}`)] };
      persistState(nextRecords, nextPro, wasEditing ? 'Deadline updated.' : 'Deadline added.', () => { editingId = null; });
      focusRecordAction(changed.id);
    } catch (error) { announce(error.message, 'error'); }
  });
  document.querySelector('#record-form')?.addEventListener('input', updatePreview);
  document.querySelector('#cancel-edit')?.addEventListener('click', () => { const id = editingId; editingId = null; render(); focusRecordAction(id); });
  document.querySelectorAll('[data-filter]').forEach((button, index) => button.addEventListener('click', () => {
    // Both summary and toolbar contain the same filter values. Retain the exact
    // initiating control, not the first matching value, after replacing the DOM.
    const restoreFocus = document.activeElement === button;
    filter = button.dataset.filter;
    render();
    if (restoreFocus) document.querySelectorAll('[data-filter]')[index]?.focus();
    else document.querySelector('#deadlines')?.scrollIntoView({ behavior: 'smooth' });
  }));
  const searchInput = document.querySelector('#search');
  searchInput?.addEventListener('compositionend', (event) => {
    // Defer until Firefox finishes its native editor; replacing it during
    // compositionend can clear the new input. A later input event may render first.
    const target = event.target;
    setTimeout(() => { if (target.isConnected) updateSearch({ target }); }, 0);
  });
  searchInput?.addEventListener('input', updateSearch);
  function updateSearch(event) {
    // Keep the native editor intact until composition commits or cancels.
    if (event.isComposing) return;
    const { value, selectionStart, selectionEnd, selectionDirection } = event.target;
    query = value;
    render();
    const input = document.querySelector('#search');
    input?.focus();
    // Preserve the post-edit selection across the replacement input.
    if (selectionStart !== null && selectionEnd !== null) input?.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
  }
  document.querySelectorAll('.record-card').forEach((card) => card.addEventListener('click', (event) => {
    const actionName = event.target.closest('button')?.dataset.action;
    if (actionName === 'edit') { editingId = card.dataset.id; render(); document.querySelector('#record-form [name="name"]')?.focus(); }
    if (actionName === 'delete' && confirm('Delete this local deadline and its work-plan steps? This cannot be undone unless it is in a backup.')) {
      const removed = records.find((record) => record.id === card.dataset.id);
      const nextPro = { steps: proData.steps.filter((step) => step.recordId !== card.dataset.id), activity: [...proData.activity, activity('record.deleted', card.dataset.id, card.dataset.id, `Deleted ${removed?.name || 'record'} and its work plan`)] };
      const neighborId = [...document.querySelectorAll('.record-card')].find(item => item !== card)?.dataset.id;
      try {
        persistState(removeRecord(records, card.dataset.id), nextPro, 'Deadline and linked work-plan steps deleted.');
        focusRecordAction(neighborId);
      } catch (error) { announce(error.message, 'error'); }
    }
  }));
  document.querySelector('#backup-export')?.addEventListener('click', () => download(`permitkeep-backup-${today()}.json`, exportBackup(records, proData), 'application/json'));
  document.querySelector('#csv-export')?.addEventListener('click', () => download(`permitkeep-deadlines-${today()}.csv`, recordsToCsv(records), 'text/csv;charset=utf-8'));
  document.querySelector('#ics-export')?.addEventListener('click', () => download(`permitkeep-calendar-${today()}.ics`, buildCalendar(records), 'text/calendar;charset=utf-8'));
  document.querySelector('#activity-export')?.addEventListener('click', () => download(`permitkeep-activity-${today()}.csv`, activityToCsv(proData.activity), 'text/csv;charset=utf-8'));
  document.querySelector('#backup-import')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const incoming = importFullBackup(await file.text());
      if ((records.length || proData.steps.length || proData.activity.length) && !confirm(`Replace current local data with ${incoming.records.length} record(s), ${incoming.pro.steps.length} step(s), and ${incoming.pro.activity.length} history entries?`)) return;
      persistState(incoming.records, incoming.pro, `${incoming.records.length} record(s) and associated local operations data restored.`);
      document.querySelector('#backup-import')?.focus();
    } catch (error) { announce(error.message, 'error'); }
    finally { event.target.value = ''; }
  });
  document.querySelector('#license-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get('code');
    const verified = await verifyLicenseCode(code);
    if (!verified) { announce('That license is malformed, altered, or for another product.', 'error'); return; }
    try {
      saveLicense(code);
      license = verified;
      render();
      // The activation form is removed by render; move focus into the unlocked
      // workspace rather than leaving keyboard users at the document body.
      const heading = document.querySelector('#pro-title');
      heading?.setAttribute('tabindex', '-1');
      heading?.focus();
      announce('PermitKeep Pro v1 activated in this browser.');
    } catch (error) { announce(`License could not be saved: ${error.message}`, 'error'); }
  });
  document.querySelector('#step-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!isPro()) return;
    try {
      const input = Object.fromEntries(new FormData(event.currentTarget));
      const wasEditing = Boolean(editingStepId);
      const nextSteps = upsertWorkStep(proData.steps, input);
      const changed = nextSteps.find((step) => step.id === (input.id || nextSteps.at(-1).id));
      const nextPro = { steps: nextSteps, activity: [...proData.activity, activity(wasEditing ? 'step.updated' : 'step.created', changed.id, changed.recordId, `${wasEditing ? 'Updated' : 'Added'} work step “${changed.title}” for ${recordName(changed.recordId)}`)] };
      persistState(records, nextPro, wasEditing ? 'Work step updated.' : 'Work step added.', () => { editingStepId = null; });
      focusStepAction(changed.id);
    } catch (error) { announce(error.message, 'error'); }
  });
  document.querySelector('#cancel-step-edit')?.addEventListener('click', () => { const id = editingStepId; editingStepId = null; render(); focusStepAction(id); });
  document.querySelectorAll('.step-card').forEach((card) => card.addEventListener('click', (event) => {
    const actionName = event.target.closest('button')?.dataset.stepAction;
    const step = proData.steps.find((item) => item.id === card.dataset.stepId);
    if (!step || !actionName) return;
    if (actionName === 'edit') { editingStepId = step.id; render(); document.querySelector('#step-form [name="title"]')?.focus(); return; }
    if (actionName === 'delete' && !confirm(`Delete the work step “${step.title}”?`)) return;
    try {
      if (actionName === 'toggle') {
        const nextSteps = upsertWorkStep(proData.steps, { ...step, completed: !step.completed });
        const verb = step.completed ? 'Reopened' : 'Completed';
        persistState(records, { steps: nextSteps, activity: [...proData.activity, activity(step.completed ? 'step.reopened' : 'step.completed', step.id, step.recordId, `${verb} work step “${step.title}” for ${recordName(step.recordId)}`)] }, `${verb} work step.`);
        focusStepAction(step.id, 'toggle');
      }
      if (actionName === 'delete') {
        const neighborId = [...document.querySelectorAll('.step-card')].find(item => item !== card)?.dataset.stepId;
        persistState(records, { steps: removeWorkStep(proData.steps, step.id), activity: [...proData.activity, activity('step.deleted', step.id, step.recordId, `Deleted work step “${step.title}” for ${recordName(step.recordId)}`)] }, 'Work step deleted.');
        focusStepAction(neighborId);
      }
    } catch (error) { announce(error.message, 'error'); }
  }));
  document.querySelectorAll('[data-report-group]').forEach((button) => button.addEventListener('click', () => { reportGrouping = button.dataset.reportGroup; render(); document.querySelector(`[data-report-group="${reportGrouping}"]`)?.focus(); }));
  document.querySelector('#print-report')?.addEventListener('click', () => window.print());
}

async function initialize() {
  try { records = loadRecords(); } catch (error) { records = []; storageRecovery = { key: STORAGE_KEY, message: error.message, raw: localStorage.getItem(STORAGE_KEY) ?? '' }; render(); return; }
  try { proData = loadProData(); } catch (error) { proData = { steps: [], activity: [] }; storageRecovery = { key: PRO_STORAGE_KEY, message: error.message, raw: localStorage.getItem(PRO_STORAGE_KEY) ?? '' }; render(); return; }
  const loaded = await loadLicense();
  license = loaded.license;
  render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

await initialize();
