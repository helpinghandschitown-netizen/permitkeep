# PermitKeep

PermitKeep is a private, local-first permit and renewal deadline desk for multi-location local operators. It organizes user-entered dates, locations, agencies, owners, and official links; calculates a renewal-start date; and exports portable backup, CSV, and calendar files.

## Current product lane

The production static application is live at https://helpinghandschitown-netizen.github.io/permitkeep/. A product-specific live Stripe offer remains a separate gate; do not infer that the public deployment is already purchasable.

Owned educational resources cover the general renewal workflow, multi-location handoffs, and restaurant deadline-calendar operations. They organize user-verified facts and do not identify required permits or replace official agency guidance.

## Run and verify

```bash
npm run verify
npm run serve
```

Open `http://127.0.0.1:4188/` after starting the server.

`npm run verify` runs unit tests, syntax checks, the deterministic release review, and clean-profile Chrome QA for backup/restore, accessibility, mobile layout, offline refresh, and service-worker upgrade behavior. Review scope and residual risks are recorded in `RELEASE_REVIEW.md`.

## Architecture

- Static installable PWA; no backend, account, analytics, cookies, external scripts, or external fonts.
- Records use browser `localStorage`; backups are user-controlled JSON.
- CSV export neutralizes spreadsheet formula prefixes.
- Calendar export creates renewal-start and expiration events.
- Content Security Policy blocks network connections from app code.

## Safety boundary

PermitKeep is an operational organizer, not compliance, legal, tax, or filing advice. It does not discover required permits, monitor rules, scrape government websites, verify authority data, file renewals, or guarantee compliance. Dates and links are entered and confirmed by the operator.

## Brand note

“PermitKeep” is a preliminary working brand. Exact-name and broader confusing-similarity web searches on 2026-09-02 found no exact software match, while the spaced name “Permit Keeper” is used by an older permit-card printing product. This is not legal advice or comprehensive trademark clearance. The release avoids any claim of exclusivity and must be renamed if a rights conflict is identified.
