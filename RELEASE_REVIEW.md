# PermitKeep release review

Reviewed: 2026-09-02  
Scope: static application, backup/restore, offline lifecycle, accessibility, privacy, security, maintainability, and GitHub Pages deployment. Payment, comprehensive brand clearance, and jurisdiction-specific legal review are separate gates.

## Review method

- Node unit tests cover record validation, date logic, sorting, backup schema and duplicate IDs, CSV injection defense, calendar escaping, and local-store corruption/identity failures.
- A clean-profile Chrome CDP run exercises desktop/mobile rendering, backup download, malformed restore, replacement confirmation/cancellation, storage-write failure atomicity, accessibility-tree names, contrast samples, reduced motion, offline refresh, and a simulated service-worker v1→v2 upgrade while preserving records.
- `scripts/release-review.mjs` performs a separate fail-closed static pass over all runtime files and declared offline assets.
- Runtime browser instrumentation records external HTTP(S) origins, security-policy messages, and JavaScript exceptions.

## Findings fixed in this pass

1. Backup imports could retain the file-input value after failure or cancellation, preventing reliable same-file retries. The input is now cleared in `finally`.
2. Backups and stored data could contain duplicate identifiers, causing ambiguous edits. Both paths now reject duplicates.
3. Malformed null backup entries produced an internal `TypeError`. They now return the product's bounded validation error.
4. Authority URLs allowed embedded usernames/passwords. These are now rejected.
5. The privacy page used inline styles blocked by its own CSP. Styles moved into `styles.css`.
6. Meta CSPs claimed `frame-ancestors`, which browsers ignore in meta delivery. The ineffective claim was removed; host-header enforcement remains explicit residual risk.
7. Filter state, record action names, required marks, skip navigation, and error announcements lacked complete assistive semantics. ARIA pressed states, record-specific names, a focusable main target, hidden decorative marks, and alert role changes were added.
8. Programmatic downloads now attach the temporary anchor for broader browser compatibility.

## Manual source review

- User-provided template values pass through HTML escaping; authority URLs are parsed and protocol/credential checked before rendering.
- CSV cells neutralize formula-leading characters after trimming and quote embedded values.
- iCalendar fields escape backslashes, newlines, commas, and semicolons.
- Application modules have no fetch/XHR/WebSocket/beacon/EventSource code, analytics, external fonts/scripts, account system, or backend API.
- The service worker only handles same-origin GETs, caches a bounded declared shell at install, and removes prior named caches on activation.
- Storage writes happen before in-memory state replacement, so quota errors do not present unsaved data as saved.

## Residual release risks

- `localStorage` is not encrypted and remains exposed to anyone controlling the unlocked browser profile; the UI and privacy notice prohibit secrets and require user backups.
- Static meta CSP cannot provide `frame-ancestors`; any public host claiming anti-framing protection must prove a response-header policy by readback.
- A fresh independent human or separate-model review was not available in this cron runtime. The deterministic static reviewer is separate from runtime tests but is not a substitute for specialist review.
- Broader trademark/confusing-similarity clearance, jurisdiction-specific legal review, deployment headers, licensing/pricing, checkout, and fulfillment remain open.

## Public deployment readback

- Repository: `https://github.com/helpinghandschitown-netizen/permitkeep` (public, `main`).
- GitHub Pages: `https://helpinghandschitown-netizen.github.io/permitkeep/` (HTTPS enforced, HTTP 200).
- Clean headless Chrome readback rendered the production heading, record form, checklist link, and privacy link.
- The host does not emit a `Content-Security-Policy` response header. The strict meta CSP remains active, but no clickjacking-protection claim is made.
