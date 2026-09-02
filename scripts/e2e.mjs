import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9348;
const appPort = 4188;
const qa = path.resolve('.qa');
const profile = path.join(qa, 'chrome-profile');
const site = path.join(qa, 'release-site');
const downloads = path.join(qa, 'downloads');
fs.rmSync(qa, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(downloads, { recursive: true });
const sourceRoot = path.resolve('.');
fs.mkdirSync(site, { recursive: true });
for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
  if (entry.name === '.qa' || entry.name === 'node_modules') continue;
  fs.cpSync(path.join(sourceRoot, entry.name), path.join(site, entry.name), { recursive: true });
}
const sourceWorker = fs.readFileSync(path.join(site, 'sw.js'), 'utf8');
const baseCache = sourceWorker.match(/const CACHE = '([^']+)'/)?.[1];
if (!baseCache) throw new Error('Could not read the release service-worker cache name.');
const cacheVersion = baseCache.match(/^(.*-v)(\d+)$/);
if (!cacheVersion) throw new Error(`Service-worker cache name is not versioned: ${baseCache}`);
const nextCache = `${cacheVersion[1]}${Number(cacheVersion[2]) + 1}`;

let server;
function startServer() {
  server = spawn('python', ['-m', 'http.server', String(appPort), '--bind', '127.0.0.1'], { cwd: site, stdio: 'ignore' });
  return server;
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, 'exit');
  server.kill();
  await Promise.race([exited, pause(2500)]);
}
startServer();
const browser = spawn(chrome, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new', '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function endpoint() {
  for (let i = 0; i < 80; i++) {
    try {
      const data = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
      if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
    } catch {}
    await pause(100);
  }
  throw new Error('Chrome CDP did not start.');
}

let id = 0;
const pending = new Map();
const consoleErrors = [];
const securityMessages = [];
const externalNetworkOrigins = new Set();
try {
  const ws = new WebSocket(await endpoint());
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.text);
    if (message.method === 'Log.entryAdded' && message.params.entry.source === 'security') securityMessages.push(message.params.entry.text);
    if (message.method === 'Network.requestWillBeSent') {
      const requestUrl = message.params.request.url;
      if (/^https?:/.test(requestUrl) && new URL(requestUrl).origin !== `http://127.0.0.1:${appPort}`) externalNetworkOrigins.add(new URL(requestUrl).origin);
    }
    if (message.id && pending.has(message.id)) {
      const handlers = pending.get(message.id);
      pending.delete(message.id);
      message.error ? handlers.reject(new Error(message.error.message)) : handlers.resolve(message.result);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const call = { id: ++id, method, params };
    if (sessionId) call.sessionId = sessionId;
    pending.set(call.id, { resolve, reject });
    ws.send(JSON.stringify(call));
  });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  const { targetId } = await send('Target.createTarget', { url: `http://127.0.0.1:${appPort}/` });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, label, attempts = 120) => {
    for (let i = 0; i < attempts; i++) {
      try { if (await evaluate(expression)) return; } catch {}
      await pause(100);
    }
    throw new Error(`Timed out waiting for ${label}.`);
  };

  await waitFor(`document.querySelector('h1')?.textContent.includes('Know what expires')`, 'home screen');
  const baseline = await evaluate(`({
    title: document.title,
    h1: document.querySelector('h1')?.textContent.trim(),
    externalOrigins: [...performance.getEntriesByType('resource')].map((entry) => new URL(entry.name).origin).filter((origin) => origin !== location.origin),
    missingLabels: [...document.querySelectorAll('input:not([type="hidden"]),select,textarea')].filter((node) => !node.labels?.length && !node.closest('label')).length,
    emptyActions: [...document.querySelectorAll('button,a.button')].filter((node) => !node.textContent.trim() && !node.getAttribute('aria-label')).length,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    skipTarget: document.querySelector('.skip-link')?.getAttribute('href'),
    skipTargetFocusable: document.querySelector(document.querySelector('.skip-link')?.getAttribute('href'))?.getAttribute('tabindex'),
    requiredMarksExposed: document.querySelectorAll('.field b:not([aria-hidden="true"])').length,
    filtersMissingPressedState: document.querySelectorAll('[data-filter]:not([aria-pressed])').length
  })`);
  if (baseline.externalOrigins.length || baseline.missingLabels || baseline.emptyActions || baseline.horizontalOverflow || baseline.skipTarget !== '#top' || baseline.skipTargetFocusable !== '-1' || baseline.requiredMarksExposed || baseline.filtersMissingPressedState) throw new Error(`Desktop accessibility baseline failed: ${JSON.stringify(baseline)}`);

  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/privacy.html` }, sessionId);
  await waitFor(`document.querySelector('h1')?.textContent.includes('deadline ledger')`, 'privacy notice');
  const privacyPage = await evaluate(`({
    h1Count: document.querySelectorAll('h1').length,
    inlineStyles: document.querySelectorAll('[style]').length,
    externalOrigins: [...performance.getEntriesByType('resource')].map((entry) => new URL(entry.name).origin).filter((origin) => origin !== location.origin),
    hasSecurityBoundary: document.body.textContent.includes('Local storage is not a secure vault'),
    hasOperationalBoundary: document.body.textContent.includes('does not determine required permits')
  })`);
  if (privacyPage.h1Count !== 1 || privacyPage.inlineStyles || privacyPage.externalOrigins.length || !privacyPage.hasSecurityBoundary || !privacyPage.hasOperationalBoundary || securityMessages.length) throw new Error(`Privacy/CSP page review failed: ${JSON.stringify({ privacyPage, securityMessages })}`);
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` }, sessionId);
  await waitFor(`document.querySelector('h1')?.textContent.includes('Know what expires')`, 'return to app');

  await evaluate(`(() => {
    const values = { name: 'Food establishment permit', location: 'West Loop', category: 'Permit', agency: 'City licensing office', permitNumber: 'P-42', expirationDate: '2026-10-15', leadDays: '60', owner: 'Operations', authorityUrl: 'https://example.gov/renew', notes: 'Confirm fees from the official agency page.' };
    const form = document.querySelector('#record-form');
    for (const [name, value] of Object.entries(values)) { const field = form.elements[name]; field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); }
    form.requestSubmit();
    return true;
  })()`);
  await waitFor(`document.querySelector('.record-card h3')?.textContent === 'Food establishment permit'`, 'saved record');
  const flow = await evaluate(`({
    stored: JSON.parse(localStorage.getItem('permitkeep.records.v1')).length,
    status: document.querySelector('.record-card .status')?.textContent.trim(),
    renewal: [...document.querySelectorAll('.record-grid dd')][0]?.textContent,
    agencyLink: document.querySelector('.record-card a')?.href,
    summary: [...document.querySelectorAll('.stats span')].map((node) => Number(node.textContent))
  })`);
  if (flow.stored !== 1 || !flow.status.includes('Renew now') || flow.renewal !== '2026-08-16' || flow.agencyLink !== 'https://example.gov/renew' || flow.summary[0] !== 1) throw new Error(`Core browser flow failed: ${JSON.stringify(flow)}`);

  await evaluate(`document.querySelector('#backup-export').click()`);
  for (let i = 0; i < 80 && !fs.readdirSync(downloads).some((name) => name.endsWith('.json')); i++) await pause(100);
  const backupName = fs.readdirSync(downloads).find((name) => name.endsWith('.json'));
  if (!backupName) throw new Error('Backup download did not complete.');
  const downloadedBackup = JSON.parse(fs.readFileSync(path.join(downloads, backupName), 'utf8'));
  if (downloadedBackup.schema !== 1 || downloadedBackup.records.length !== 1) throw new Error('Downloaded backup did not contain the saved record.');

  const chooseBackup = async (name, text, confirmResult = true) => evaluate(`(async () => {
    window.confirm = () => ${confirmResult};
    const input = document.querySelector('#backup-import');
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(text)}], ${JSON.stringify(name)}, { type: 'application/json' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { value: input.value, count: JSON.parse(localStorage.getItem('permitkeep.records.v1')).length, toast: document.querySelector('#toast').textContent, tone: document.querySelector('#toast').dataset.tone, role: document.querySelector('#toast').getAttribute('role') };
  })()`);

  const malformed = await chooseBackup('broken.json', '{not json');
  if (malformed.count !== 1 || malformed.value !== '' || !/valid JSON/i.test(malformed.toast) || malformed.tone !== 'error' || malformed.role !== 'alert') throw new Error(`Malformed restore safety failed: ${JSON.stringify(malformed)}`);
  const secondRecord = { ...downloadedBackup.records[0], id: 'second-record', name: 'Second permit', updatedAt: '2026-09-02T13:00:00.000Z' };
  const twoRecordBackup = JSON.stringify({ ...downloadedBackup, records: [downloadedBackup.records[0], secondRecord] });
  const restored = await chooseBackup('two-records.json', twoRecordBackup);
  if (restored.count !== 2 || restored.value !== '' || !/2 record\(s\) restored/i.test(restored.toast)) throw new Error(`Valid restore failed: ${JSON.stringify(restored)}`);
  const cancelled = await chooseBackup('one-record.json', JSON.stringify(downloadedBackup), false);
  if (cancelled.count !== 2 || cancelled.value !== '') throw new Error(`Cancelled restore changed data or left the chooser dirty: ${JSON.stringify(cancelled)}`);

  const quotaFailure = await evaluate(`(() => {
    const before = localStorage.getItem('permitkeep.records.v1');
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new DOMException('Storage quota exceeded', 'QuotaExceededError'); };
    const form = document.querySelector('#record-form');
    form.elements.name.value = 'Should not save';
    form.elements.location.value = 'Test';
    form.elements.agency.value = 'Test agency';
    form.requestSubmit();
    Storage.prototype.setItem = original;
    return { unchanged: localStorage.getItem('permitkeep.records.v1') === before, cards: document.querySelectorAll('.record-card').length, toast: document.querySelector('#toast').textContent, tone: document.querySelector('#toast').dataset.tone };
  })()`);
  if (!quotaFailure.unchanged || quotaFailure.cards !== 2 || quotaFailure.tone !== 'error' || !/quota/i.test(quotaFailure.toast)) throw new Error(`Storage failure was not atomic: ${JSON.stringify(quotaFailure)}`);

  const axTree = await send('Accessibility.getFullAXTree', {}, sessionId);
  const interactiveRoles = new Set(['button', 'link', 'textbox', 'combobox', 'spinbutton']);
  const unnamedAxNodes = axTree.nodes.filter((node) => !node.ignored && interactiveRoles.has(node.role?.value) && !node.name?.value).map((node) => node.role.value);
  const accessibility = await evaluate(`(() => {
    const parse = (value) => { const parts = value.match(/[\\d.]+/g).map(Number); return parts.length === 4 ? parts.slice(0, 3).map((n) => n * parts[3] + 255 * (1 - parts[3])) : parts.slice(0, 3); };
    const luminance = (rgb) => rgb.map((n) => n / 255).map((n) => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
    const ratio = (foreground, background) => { const values = [luminance(parse(foreground)), luminance(parse(background))].sort((a, b) => b - a); return (values[0] + .05) / (values[1] + .05); };
    const samples = [
      ['body', getComputedStyle(document.body).color, getComputedStyle(document.body).backgroundColor],
      ['muted copy', 'rgb(96, 112, 108)', 'rgb(247, 245, 239)'],
      ['danger status', 'rgb(138, 53, 40)', 'rgb(249, 220, 212)'],
      ['warning status', 'rgb(118, 82, 11)', 'rgb(255, 240, 200)'],
      ['info status', 'rgb(40, 91, 115)', 'rgb(222, 237, 244)'],
      ['success status', 'rgb(31, 109, 77)', 'rgb(223, 243, 231)']
    ].map(([name, foreground, background]) => ({ name, ratio: ratio(foreground, background) }));
    return {
      h1Count: document.querySelectorAll('h1').length,
      mainCount: document.querySelectorAll('main').length,
      duplicateIds: [...document.querySelectorAll('[id]')].map((node) => node.id).filter((id, index, all) => all.indexOf(id) !== index),
      pressedFilters: document.querySelectorAll('[data-filter][aria-pressed]').length,
      contrastFailures: samples.filter((sample) => sample.ratio < 4.5),
      deleteNames: [...document.querySelectorAll('[data-action="delete"]')].map((node) => node.getAttribute('aria-label'))
    };
  })()`);
  if (unnamedAxNodes.length || accessibility.h1Count !== 1 || accessibility.mainCount !== 1 || accessibility.duplicateIds.length || accessibility.pressedFilters !== 8 || accessibility.contrastFailures.length || accessibility.deleteNames.some((name) => !name)) throw new Error(`Expanded accessibility review failed: ${JSON.stringify({ unnamedAxNodes, accessibility })}`);

  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
  const reducedMotion = await evaluate(`({ scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior, buttonTransition: getComputedStyle(document.querySelector('.button')).transitionDuration })`);
  if (reducedMotion.scrollBehavior !== 'auto' || reducedMotion.buttonTransition.split(',').some((value) => Number.parseFloat(value) !== 0)) throw new Error(`Reduced-motion support failed: ${JSON.stringify(reducedMotion)}`);

  const desktopShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  fs.writeFileSync('.qa/permitkeep-desktop.png', Buffer.from(desktopShot.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
  await pause(250);
  const mobile = await evaluate(`({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, cards: document.querySelectorAll('.record-card').length, editorVisible: Boolean(document.querySelector('#record-form')) })`);
  if (mobile.scrollWidth > mobile.width || mobile.cards !== 2 || !mobile.editorVisible) throw new Error(`Mobile layout failed: ${JSON.stringify(mobile)}`);
  const mobileShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  fs.writeFileSync('.qa/permitkeep-mobile.png', Buffer.from(mobileShot.data, 'base64'));

  await waitFor(`navigator.serviceWorker?.controller && caches.keys().then((keys) => keys.includes('${baseCache}'))`, 'initial service worker activation');
  await stopServer();
  await send('Page.reload', { ignoreCache: true }, sessionId);
  await waitFor(`document.querySelector('.record-card')`, 'offline refresh');
  const offline = await evaluate(`(async () => ({ records: JSON.parse(localStorage.getItem('permitkeep.records.v1')).length, cards: document.querySelectorAll('.record-card').length, cacheKeys: await caches.keys() }))()`);
  if (offline.records !== 2 || offline.cards !== 2 || !offline.cacheKeys.includes(baseCache)) throw new Error(`Offline refresh failed: ${JSON.stringify(offline)}`);

  fs.writeFileSync(path.join(site, 'sw.js'), fs.readFileSync(path.join(site, 'sw.js'), 'utf8').replace(baseCache, nextCache));
  fs.writeFileSync(path.join(site, 'index.html'), fs.readFileSync(path.join(site, 'index.html'), 'utf8').replace('<title>', '<meta name="release-qa" content="v2">\n  <title>'));
  startServer();
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${appPort}/`, { cache: 'no-store' })).ok) break; } catch {}
    await pause(100);
  }
  await evaluate(`navigator.serviceWorker.getRegistration().then((registration) => registration.update())`);
  await waitFor(`caches.keys().then((keys) => keys.includes('${nextCache}') && !keys.includes('${baseCache}'))`, 'service worker upgrade', 200);
  await stopServer();
  await send('Page.reload', { ignoreCache: true }, sessionId);
  await waitFor(`document.querySelector('meta[name="release-qa"]')?.content === 'v2' && document.querySelectorAll('.record-card').length === 2`, 'upgraded offline shell');
  const upgrade = await evaluate(`(async () => ({ marker: document.querySelector('meta[name="release-qa"]')?.content, records: JSON.parse(localStorage.getItem('permitkeep.records.v1')).length, cards: document.querySelectorAll('.record-card').length, cacheKeys: await caches.keys() }))()`);
  if (upgrade.marker !== 'v2' || upgrade.records !== 2 || upgrade.cards !== 2 || upgrade.cacheKeys.join(',') !== nextCache) throw new Error(`Offline upgrade failed: ${JSON.stringify(upgrade)}`);

  if (externalNetworkOrigins.size) throw new Error(`Unexpected external network origins: ${[...externalNetworkOrigins].join(', ')}`);
  if (consoleErrors.length) throw new Error(`Browser exceptions: ${consoleErrors.join('; ')}`);

  console.log(JSON.stringify({ passed: true, baseline, privacyPage, flow, backupRestore: { malformed, restored, cancelled, downloadedRecords: downloadedBackup.records.length }, quotaFailure, accessibility: { ...accessibility, unnamedAxNodes }, reducedMotion, mobile, offline, upgrade, externalNetworkOrigins: [...externalNetworkOrigins], securityMessages, consoleErrors, artifacts: ['.qa/permitkeep-desktop.png', '.qa/permitkeep-mobile.png'] }, null, 2));
  ws.close();
} finally {
  browser.kill();
  await stopServer();
}
