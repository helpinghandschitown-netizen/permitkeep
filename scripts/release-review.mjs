import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const htmlNames = ['index.html', 'privacy.html', 'terms.html', 'permit-renewal-tracking-checklist.html', 'multi-location-license-renewal-process.html', 'restaurant-permit-renewal-calendar.html'];
const runtimeNames = [...htmlNames, 'styles.css', 'manifest.webmanifest', 'sw.js', 'src/app.mjs', 'src/core.mjs', 'src/store.mjs', 'src/crypto.mjs', 'src/license.mjs'];
const runtime = Object.fromEntries(runtimeNames.map((name) => [name, read(name)]));
const results = [];
const check = (condition, control, detail) => results.push({ control, passed: Boolean(condition), detail });

const packageData = JSON.parse(read('package.json'));
const manifest = JSON.parse(read('manifest.webmanifest'));
const html = htmlNames.map((name) => runtime[name]).join('\n');
const appRuntime = `${runtime['src/app.mjs']}\n${runtime['src/core.mjs']}\n${runtime['src/store.mjs']}\n${runtime['src/crypto.mjs']}\n${runtime['src/license.mjs']}`;

check(!packageData.dependencies && !packageData.devDependencies, 'dependency surface', 'No runtime or development packages are required.');
check(!/\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b|\bfetch\s*\(/.test(appRuntime), 'zero-data application network surface', 'Application modules contain no outbound network APIs.');
check(!/\b(?:eval|Function)\s*\(|document\.write\s*\(/.test(appRuntime), 'dynamic code execution', 'No eval, Function constructor, or document.write in application modules.');
check(!/\b(?:TODO|FIXME|HACK)\b/i.test(runtimeNames.map((name) => runtime[name]).join('\n')), 'unfinished markers', 'No TODO, FIXME, or HACK markers in runtime files.');
const externalRuntimeResource = /<(?:script|img|iframe|audio|video|source)\b[^>]*\b(?:src|srcset)=["']https?:\/\/|<link\b(?=[^>]*\brel=["'](?:stylesheet|icon|manifest|preload|modulepreload|preconnect|dns-prefetch)["'])[^>]*\bhref=["']https?:\/\//i;
check(!externalRuntimeResource.test(html), 'external static resources', 'HTML loads no external scripts, styles, fonts, images, or other runtime resources. Canonical and Open Graph metadata are permitted.');
check(!/\sstyle=["']/i.test(html), 'CSP-compatible styling', 'HTML contains no inline style attributes.');
check(!/<script(?![^>]*\bsrc=)[^>]*>\s*[^<]/i.test(html), 'inline script surface', 'HTML contains no executable inline scripts.');

for (const name of htmlNames) {
  const csp = runtime[name].match(/Content-Security-Policy" content="([^"]+)/)?.[1] ?? '';
  check(csp.includes("default-src 'self'") && csp.includes("connect-src 'none'") && csp.includes("object-src 'none'") && csp.includes("base-uri 'none'") && !csp.includes("'unsafe-inline'") && !csp.includes("'unsafe-eval'") && !csp.includes('frame-ancestors'), `${name} CSP`, 'Self-only static resources, no connections/objects/base rewriting, no ineffective meta frame-ancestors claim.');
}

const assetDeclaration = runtime['sw.js'].match(/const ASSETS = \[([^\]]+)\]/s)?.[1] ?? '';
const cacheAssets = [...assetDeclaration.matchAll(/'([^']+)'/g)].map((match) => match[1]);
const missingAssets = cacheAssets.filter((asset) => {
  if (asset === './') return !fs.existsSync(path.join(root, 'index.html'));
  return !fs.existsSync(path.join(root, asset.replace(/^\.\//, '')));
});
check(cacheAssets.length >= 12 && !missingAssets.length, 'offline asset manifest', missingAssets.length ? `Missing: ${missingAssets.join(', ')}` : `${cacheAssets.length} declared cache assets exist.`);
check(runtime['sw.js'].includes("event.request.method !== 'GET'") && runtime['sw.js'].includes('origin !== self.location.origin'), 'service-worker request boundary', 'Only same-origin GET requests enter cache handling.');
check(runtime['sw.js'].includes('key !== CACHE') && runtime['sw.js'].includes('self.clients.claim()'), 'service-worker upgrade cleanup', 'Old named caches are removed and upgraded workers claim clients.');
check(runtime['sw.js'].includes("key.startsWith('permitkeep-')"), 'service-worker cache namespace', 'Activation can delete only obsolete PermitKeep caches, not sibling application caches on the shared origin.');

const manifestIconsMissing = (manifest.icons ?? []).filter((icon) => !fs.existsSync(path.join(root, icon.src))).map((icon) => icon.src);
check(manifest.start_url === './' && manifest.scope === './' && !manifestIconsMissing.length, 'install manifest paths', manifestIconsMissing.length ? `Missing: ${manifestIconsMissing.join(', ')}` : 'Relative start/scope and icon paths are present.');
check(runtime['src/core.mjs'].includes("parsed.username || parsed.password") && runtime['src/core.mjs'].includes("['http:', 'https:']"), 'authority URL validation', 'Only HTTP(S) URLs without embedded credentials are accepted.');
check(runtime['src/core.mjs'].includes('duplicate record identifier') && runtime['src/store.mjs'].includes('duplicate identifiers'), 'record identity integrity', 'Backup and stored-data paths reject duplicate identifiers.');
check(runtime['src/core.mjs'].includes('/^[=+\\-@]/') && runtime['src/core.mjs'].includes("replaceAll('\\n', '\\\\n')"), 'export injection controls', 'CSV formula prefixes and calendar text/newlines are neutralized.');
check(runtime['src/app.mjs'].includes('const escapeHtml') && runtime['src/app.mjs'].includes('rel="noopener noreferrer"'), 'render and opener controls', 'User text is escaped before template rendering and new tabs block opener access.');
check(runtime['privacy.html'].includes('Local storage is not a secure vault') && runtime['privacy.html'].includes('does not determine required permits') && runtime['privacy.html'].includes('no analytics'), 'privacy and operational disclosure', 'Storage, tracking, and compliance boundaries are stated.');
check(runtime['terms.html'].includes('not currently offered for purchase') && runtime['terms.html'].includes('signature-verified webhook') && runtime['terms.html'].includes('14 days'), 'commercial terms safety state', 'Terms keep checkout disabled until test-mode fulfillment is verified.');
check(runtime['src/app.mjs'].includes('Checkout is not available yet') && runtime['src/app.mjs'].includes('Purchase unavailable') && !/buy\.stripe\.com|\$29|2900/.test(runtime['src/app.mjs']), 'checkout disabled gate', 'No stale live link or mismatched price remains in the product UI.');
check(runtime['src/app.mjs'].includes('storageRecovery') && runtime['src/app.mjs'].includes('Download damaged data') && runtime['src/app.mjs'].includes('Reset damaged local data'), 'corrupt-storage recovery gate', 'Unreadable local data blocks normal writes and offers raw download plus explicit reset.');
check(runtime['src/license.mjs'].includes("crypto.subtle.verify") && runtime['src/license.mjs'].includes("permitkeep-pro-v1") && !runtime['src/license.mjs'].includes('private'), 'offline signed-license boundary', 'The app bundles only a product-specific public verification key and fails closed for wrong-product licenses.');
check(runtime['src/core.mjs'].includes('createWorkStep') && runtime['src/core.mjs'].includes('buildPortfolioReview') && runtime['src/core.mjs'].includes('createActivityEntry'), 'coherent Pro value bundle', 'Work plans, portfolio review, and local activity history are implemented as one bundle.');
check(runtime['src/core.mjs'].includes('LEGACY_BACKUP_SCHEMA') && runtime['src/core.mjs'].includes("pro: { steps, activity }") && runtime['src/app.mjs'].includes('importFullBackup'), 'Pro backup migration', 'Schema-1 free backups migrate and schema-2 backups preserve Pro work plans and history.');
check(!/FREE_RECORD_LIMIT|free records used|unlimited local records/i.test(appRuntime), 'free product boundary', 'No artificial record limit or cosmetic limit-removal sale is present.');
check(runtime['src/app.mjs'].includes('Print / save PDF') && runtime['styles.css'].includes('@media print') && runtime['src/app.mjs'].includes('Missing-data exceptions'), 'portfolio report output', 'The local report is print/PDF ready and includes missing-data exceptions.');
check(!runtime['styles.css'].includes('rgba(47,143,104,.3)') && runtime['styles.css'].includes('input::placeholder, textarea::placeholder { color: var(--muted); }'), 'focus and placeholder contrast', 'Focus indicators are opaque and placeholder text uses the verified muted-text color.');
check(runtimeNames.every((name) => runtime[name].split(/\r?\n/).length < 400), 'maintainable module size', 'Every runtime source file remains below 400 lines.');

const failed = results.filter((result) => !result.passed);
const report = { passed: failed.length === 0, controls: results.length, failed: failed.length, results, residualRisks: [
  'A static meta CSP cannot enforce frame-ancestors; deploy-time security headers must be verified on any host that claims clickjacking protection.',
  'LocalStorage is readable by anyone controlling the unlocked browser profile and is not encrypted by PermitKeep.',
  'Brand/trademark clearance, jurisdiction-specific legal review, public-host headers, and payment-path review are separate release gates.',
] };
console.log(JSON.stringify(report, null, 2));
if (failed.length) process.exitCode = 1;
