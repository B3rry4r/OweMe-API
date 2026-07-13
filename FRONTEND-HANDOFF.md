# Frontend handoff — updates & answers for the backend pipeline

Written 2026-07-10 by the OweMe-Mobile session, on the owner's instruction.
Read this BEFORE Phase 0's conventions interview — it contains finalized,
owner-approved decisions. Treat everything here as recorded-decision input
(Supersedes / declarations / product truths). The product document for
Step 0 is `/workspace/projects/OweMe-Mobile/OweMe.pdf` — chapters 6, 7,
and 9 (reminders/automation, features, pricing) matter most. The frontend
is current at commit `94c198e` ("Model rev 2") — §4 below reflects it.

A previous pipeline session (transcript in this project's .claude history)
explored these questions but froze nothing — no .pipeline/ artifacts or
conventions.md exist. Start clean; this document supersedes that session's
working assumptions.

## 1. AUTH — final decision (corrects earlier email/Resend exploration)

We are NOT using email. Resend is dead. Login is **phone number +
backend-issued 6-digit OTP**. Everything else you specified stands (always
202 on request so accounts can't be enumerated, hashed codes, 10-minute
expiry, 5 attempts, rate limits per phone and per IP, refresh rotation,
provider isolation) — but the sole `OtpSender` implementation is
**BulkSMSNigeria** (`POST /api/v2/sms`, Bearer token from env,
`gateway: "otp"` — required so codes reach DND-listed numbers; messages
deliver under their shared sender ID "INFINITI" until the business's CAC
registration exists; Termii replaces it later behind the same interface,
touching nothing else).

Consequences:
- `login_screen.dart` and `otp_screen.dart` are correct as-built — NOT
  stale evidence. Extraction should read them at face value; no login UI
  alignment task should exist.
- The Supersedes list is exactly: whole naira→kobo, int
  autoincrement→UUIDv7, free-text plan literals→canonical ids.

## 2. Rulings on open questions (raised by the earlier session)

1. **`call` channel: KEEP, log-only.** The trader phoned the debtor and
   taps to record that it happened. No delivery contract — `POST /reminders`
   accepts `channel: "call"` as recorded history. (The PDF lists assisted
   phone calls as a future channel; this logs the manual version meanwhile.)
2. **Deep-link sending (Mode 1): already built.** It shipped in frontend
   commit `f476925` (`url_launcher`, `wa.me`/`sms:` with message + pay-link
   prefilled, clipboard fallback). Out of your scope. `POST /reminders`
   records history exactly as you specified.
3. **`_verifyWithBackend`: confirmed.** The server becomes the sole
   entitlement authority in Phase 6; the app reflects server state only.
   A patched APK losing free Business is exactly the intent.

Plan-string bug: confirmed and already fixed frontend-side in `f476925` —
canonical ids `starter|market|business|enterprise` (lowercase), unknown
values fail CLOSED to starter, the app now writes the canonical id
(`lib/data/billing/billing.dart` is the single constants seam). The server
remains the authority.

## 3. Frontend state at commit f476925 — what extraction will see

Commit `f476925` added screens, so most backend surfaces are now ordinary
screen-backed resources:

- **Payout account screen** (`/settings/payout`): bank list, 10-digit NUBAN
  entry, name-resolve confirmation, save. Mirrors your `GET /banks`,
  `POST /payout-account/resolve`, `PUT /payout-account` contracts.
- **Usage screen**: ONE unified "OweMe credits" meter (rev 2 replaced the
  two separate meters) with a bundle purchase CTA, capped at 2 bundles per
  calendar month.
- **Debt detail**: the automatic-reminder schedule card (3 days before due →
  due date → +3 → +7, stops on payment) from the PDF's recovery engine.
- **Subscription screen**: BVUM ("business scale") computed and displayed.

Only `GET /insights/dashboard` and `GET /customers/:id/risk` remain
screen-less 501 scaffolds (`sourceScreens: []`).

## 4. Metering numbers — MODEL REV 2 (final, owner-approved 2026-07-12)

This section SUPERSEDES the earlier metering model in full: the old
allowances (10/50/150 sends, 10/100/500 AI credits), the 4-tier plan
ladder, the ₦2M/₦2M/₦20M/unlimited ceilings, and — critically — the
"upgrade recommendations only" BVUM rule. If your seeded plans or guards
still encode any of those, replace them.

- **Plans** (canonical ids now FIVE:
  `starter|market|business|wholesale|enterprise`; unknown fails closed to
  starter): starter free · market ₦2,500 · business ₦6,000 · wholesale
  ₦12,000 (NEW tier) · enterprise from ₦25,000 (off-store, talk-to-sales,
  banded — below).
- **Unified "OweMe credits"** — ONE pool replaces the separate
  message-send allowance and AI-credit ledgers. Weighted debits, on
  success only: automated reminder send = 5 credits · voice parse = 1 ·
  insight/risk score = 4. Monthly grants: starter 50, market 300,
  business 1,200, wholesale 3,000, enterprise fair-use. Manual deeplink
  sends and printable statements remain unmetered and free.
  `GET /usage` should return a single credits meter (used/limit) — the
  app currently derives one from the two old meters as an interim shim
  (`_unifiedUsed` in `subscription_screens.dart`) and will switch to the
  server's single meter as soon as it exists.
- **Bundles** (IAP consumables, server verifies receipts): SKUs
  `oweme_credits_250` ₦2,000 · `oweme_credits_600` ₦4,000 ·
  `oweme_credits_1500` ₦8,000. HARD CAP: 2 bundle purchases per business
  per calendar month, enforced server-side (reject the third receipt);
  the app also blocks client-side but the server is the authority.
- **BVUM ceilings — ENFORCED INSTANTLY, no grace window**: starter
  ₦300k · market ₦1.5M · business ₦6M · wholesale ₦20M · enterprise
  BANDED, never unlimited: base ₦25,000/mo covers ₦40M, each additional
  ₦20M band adds ₦12,500/mo (the same 0.0625%/mo rate as the base).
  Weights per the PDF: outstanding receivables 40%, monthly credit
  issued 30%, recovery volume 15%, active debtors 10%, complexity 5%;
  30-day window. Enforcement semantics: creating a NEW debt that would
  push BVUM above the plan's ceiling is REJECTED with
  `403 {error: {code: "BVUM_CEILING", requiredPlan: "<id>"}}`; the
  existing book, payments, reminders, and everything collection-related
  keep working — growth is gated, never recovery.
- **Pay-link commission**: OweMe takes 1% capped ₦500 per payment ON TOP
  of Paystack's 1.5% + ₦100 capped ₦2,000 (via Paystack subaccount
  transaction split). The pay-link response and any fee field expose ONE
  combined figure only — 2.5% + ₦100, capped ₦2,500 — never the
  Paystack/OweMe breakdown. The app already discloses the combined fee
  on the payout-setup and reminder-preview screens.
- **Reminder SMS delivery** uses the same BulkSMSNigeria account and the
  same `MessageSender` isolation as OTP (works pre-CAC under the shared
  sender ID). The 501 delivery worker can become real whenever the owner
  chooses; contracts unchanged.

## 5. Foundation decisions (owner-approved in the earlier session — reuse, don't re-ask)

These were settled via the Phase 0 wizard before this document existed.
They are recorded decisions; Phase 0 should confirm them, not reopen them.

- **IDs**: client-generated UUIDv7 everywhere. Drift's int autoincrement is
  superseded. Retrying a create with the same id is a no-op, not a
  duplicate (idempotency).
- **Money**: integer kobo in DB and on the wire (Paystack-native). UI
  divides by 100 for display. Whole-naira columns are superseded.
- **Sync protocol** (the frontend is offline-first on drift — this answers
  the mandatory sync-strategy question): add `updatedAt` + `version` to all
  synced tables (Debts, Payments, Reminders lack them today; Customers has
  updatedAt only). Delta pull via `GET /sync?since=<cursor>`. Writes carry
  `If-Match: version=N`; a stale write gets `409 { current: {...} }` and
  the client re-applies. Conflict resolution: last-writer-wins per
  field-set. Local writes are truth until synced — the server never
  silently discards an offline write.
- **Tenancy & roles**: business tenant on every row; `role: owner | staff`.
  Staff can read/write debts and customers but not delete debts, manage
  staff, or touch billing. `branchId` exists nullable and unused (reserved
  for Enterprise).
- **Entitlements**: server-enforced guards read the business's plan; a
  blocked capability returns `403 {error: {code: "PLAN_REQUIRED",
  requiredPlan: "<id>"}}` so the app can show an upgrade prompt. Client
  state is display-only.
- **Payments (Paystack platform model)**: one platform merchant account;
  a subaccount per business created server-side from the payout-account
  screen's data (bankCode, accountNumber, accountName — nothing else
  stored). `GET /banks` proxy, `POST /payout-account/resolve` (name check),
  `PUT /payout-account` (create/update subaccount), `POST
  /debts/:id/pay-link`, signature-verified `POST /webhooks/paystack`
  idempotent on the Paystack reference.
- **Reminder engine**: on debt creation the backend generates the schedule
  (3 days before due / due date / +3 / +7; stops on payment; configurable).
  Delivery worker behind `MessageSender`; channels sms | whatsapp | manual
  (recorded only) | printable. Automated sends are metered per §4; manual
  and printable are free and unmetered.
- **AI**: one shared credits ledger (IAP top-ups credit; any AI endpoint
  debits on success — weighted per §4). Voice parse is the first consumer
  (`POST /voice/parse`, transcript-only; audio path scaffolded 501).
  `GET /insights/dashboard` and `GET /customers/:id/risk` are 501
  contracts against the same ledger. LLM provider behind an interface.
- **Env-manifest heads-up**: expected secrets include the BulkSMSNigeria
  API token, Paystack secret + webhook secret, JWT signing keys, and the
  LLM provider key (unused until AI endpoints go live).
