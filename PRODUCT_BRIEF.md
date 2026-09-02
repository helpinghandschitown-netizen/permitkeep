# PermitKeep product brief

## User and problem

Small local operators with several locations can have dozens of business licenses, permits, inspections, certifications, registrations, and insurance renewals. Deadlines differ, ownership is unclear, and a spreadsheet often becomes visible only after something is urgent.

## Narrow value path

1. Operator enters a real record and official agency link.
2. PermitKeep calculates when renewal work should begin from the operator's lead window.
3. Dashboard sorts expired, renew-now, upcoming, missing-date, and current records.
4. Operator hands off by owner and exports a backup, CSV, or calendar.

## Differentiation

- Local-first and usable without an account.
- Multi-location deadline view rather than professional credential/CE tracking.
- Explicitly user-entered facts: no unsafe rule guessing or stale jurisdiction templates.
- Portable data and calendar output from day one.
- Calm, accessible interface aimed at small operators rather than enterprise compliance teams.

## Non-goals for first production release

- Discovering which permits a business requires.
- Government-site scraping, agency monitoring, filing, or fee payment.
- Legal/compliance advice or guarantees.
- Storage of passwords, tax IDs, identity documents, card data, or sensitive filings.
- Email/SMS reminders until there is a consent-based, reliable delivery architecture.

## Commercial hypothesis

The free edition keeps unlimited deadline records and portable exports. PermitKeep Pro v1 adds a coherent operations layer: renewal work plans, a print/PDF portfolio review, and local activity history. The provisional launch hypothesis is $39 one time for Pro v1, subject to a complete test-mode purchase, signed-webhook fulfillment, exact-session claim, activation, and production commerce review. Checkout remains disabled. No revenue or customer claims are authorized without Stripe readback.

## Risks and gates

- **Stale fact risk:** product must continue to say dates/rules come from the operator and must be checked with agencies.
- **Data loss:** backup education and tested import/export are launch gates.
- **Privacy:** local storage is not encrypted; prohibit secrets and explain browser-profile exposure.
- **Security:** retain strict CSP, URL protocol validation, escaped rendering, safe exports, and no external runtime dependencies.
- **Brand/IP:** “PermitKeep” only passed a preliminary exact web search; complete broader name and trademark review before public branding.
- **Accessibility:** keyboard flow, labels, reduced motion, contrast, mobile layout, and screen-reader announcements require runtime checks.

## Release gate

Do not deploy, price, or promote until deterministic tests, full browser flows, import/export recovery, offline behavior, accessibility/security review, privacy copy, release packaging, checkout, and public readback all pass.
