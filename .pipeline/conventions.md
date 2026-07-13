# OweMe API — Conventions (Phase 0, frozen on user confirmation)

Framework: **NestJS** + **Prisma** (see `framework-decision.json`). Every sub-agent receives this file read-only. Sources: owner-approved `FRONTEND-HANDOFF.md` (recorded decisions) and `product-truths.json` (from `OweMe.pdf`). Where they collide on target state: **recorded decision > product truth > screen evidence.**

## Auth model
- **Login: phone number + backend-issued 6-digit OTP.** No email, no passwords. (Supersedes the earlier email/Resend exploration — Resend is dead. `login_screen.dart` / `otp_screen.dart` are correct as-built; NO login UI-alignment task.)
- OTP request always returns **`202`** regardless of whether the phone maps to an account (no account enumeration).
- OTP codes are **hashed at rest**, **10-minute expiry**, **max 5 attempts**, rate-limited **per phone and per IP**.
- Sole `OtpSender` implementation: **BulkSMSNigeria** (`POST /api/v2/sms`, Bearer token from env, `gateway: "otp"`). Provider is behind the `OtpSender` interface (Termii can replace it later touching nothing else).
- On successful verify: issue **JWT access + refresh** tokens. `Authorization: Bearer <access>`. **Refresh rotation** at `POST /auth/refresh` (rotate refresh token on every use; detect reuse).
- NestJS idiom: `@nestjs/passport` + JWT strategy; access token carries `sub` (userId), `businessId` (tenant), `role`.

## Roles & permissions
Roles: **`owner` | `staff`** (JWT claim).
- **owner**: full access — debts, customers, billing, staff management, payout account, everything.
- **staff**: read/write **debts** and **customers**; **cannot** delete debts, manage staff, or touch billing/payout/subscription.
- `branchId` column exists **nullable and unused** (reserved for Enterprise; do not gate on it yet).
- Enforcement idiom: `@Roles('owner')` decorator + `RolesGuard`. Default a route to the most restrictive role that any screen/contract requires.

## Tenancy
- **Multi-tenant by business.** Every domain row carries `businessId`. Every query is scoped to the JWT's `businessId`; cross-tenant access is impossible by construction (enforce in a base service / Prisma middleware, not per-endpoint).

## Entitlements (server is the SOLE authority)
- Server-enforced guards read the business's **plan** (canonical id) and current **allowance/credit ledgers**. Client state is **display-only** — a patched APK cannot grant entitlement.
- A blocked capability returns **`403 { "error": { "code": "PLAN_REQUIRED", "requiredPlan": "<id>" } }`** so the app can show an upgrade prompt.
- Canonical plan ids: **`starter | market | business | enterprise`** (lowercase). Unknown/absent → **fail CLOSED to `starter`**.
- Entitlement philosophy (product truth): plans sell **scale and sophistication**, never gate **core recovery** (customers, debts, receipts, offline, basic dashboard, reminder *automation/scheduling*). What IS metered: SMS/WhatsApp **delivery sends** and **AI** usage — see Metering.

## Error envelope (one shape for the whole API)
```json
{ "error": { "code": "SNAKE_CASE_CODE", "message": "human readable", "details": [ ... optional ... ] } }
```
- Produced in **one** global `HttpExceptionFilter` in `src/common/` (owned by the schema/pre-step agent). Build agents throw typed exceptions; they never hand-roll the JSON.
- Validation failures (class-validator) map to `code: "VALIDATION_ERROR"`, `422`, with `details` listing offending fields.
- Known codes: `VALIDATION_ERROR` (422), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `PLAN_REQUIRED` (403), `NOT_FOUND` (404), `VERSION_CONFLICT` (409), `RATE_LIMITED` (429), `INTERNAL` (500).

## Pagination
- **Cursor-based.** Query params `?cursor=<opaque>&limit=<n>` (default limit 20, max 100).
- Response wrapper: `{ "data": [ ... ], "nextCursor": "<opaque|null>" }`.
- Shared shape name: `Paginated<T>`.

## Money
- **Integer kobo** in DB and on the wire everywhere (Supersede S-1). Never floats. UI divides by 100 for display. Field type in contracts/DTOs: integer.

## IDs & idempotency
- **UUIDv7**, client-generated, everywhere (Supersede S-2). `id` is a required string on create payloads (the client mints it).
- **Idempotent create**: a create with an already-seen `id` returns the existing resource (200) rather than erroring — supports offline retry.

## Offline-first sync protocol (mandatory — frontend is offline-first on drift)
- All synced tables carry **`updatedAt`** (server-authoritative timestamp) and **`version`** (monotonic int per row). (Debts/Payments/Reminders lack these today; Customers has `updatedAt` only — schema agent adds them.)
- **Delta pull**: `GET /sync?since=<cursor>` returns changed rows across synced entities since the cursor, plus **tombstones** for deletes, and a new cursor.
- **Writes** carry **`If-Match: version=N`**. A stale write → **`409 { "error": {...}, "current": { ...server row... } }`**; client re-applies. Conflict resolution: **last-writer-wins per field-set**.
- **Local writes are truth until synced** — the server never silently discards an offline write.

## Naming & layout (NestJS profile)
- Routes: **kebab-case plural** resource paths (`/debts`, `/payout-account`, `/customers/:id/risk`). REST verbs; custom actions as sub-paths (`POST /debts/:id/pay-link`, `POST /debts/:id/mark-paid`).
- Module layout: `src/<resource>/` — `*.module.ts`, `*.controller.ts`, `*.service.ts`, `dto/`, `tests/<resource>.contract.spec.ts`. Shared code in `src/common/` (guards, filters, decorators, base service) — owned by schema/pre-step agents only.
- Registration entry a build agent may touch: **one import line in `src/app.module.ts`**.
- Validation: **class-validator + class-transformer** DTOs; global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`.
- Testing: **Jest + supertest** against a Nest testing module on a fresh test DB; assert response **shapes** (key presence + types) + status + auth/role rejection, not snapshots.

## Metering (owner-approved, final — §4 of handoff)
- **Plans (store price; net ≈ PDF figures after 15% store fee):** starter **free** · market **₦2,500** · business **₦6,000** · enterprise **from ₦18,000** (off-store, talk-to-sales). *(PDF ch.9 lists net ₦2,000 / ₦5,000 / ₦15,000 — the store prices above are the authoritative recorded decision.)*
- **Monthly automated-send allowances (SMS/WhatsApp delivery):** starter **10** · market **50** · business **150** · enterprise **fair-use**. Manual deep-link sends and printable statements are **unmetered and free**. Allowance increases are ALWAYS an explicit owner decision — **never encode a scheduled lift**.
- **AI credits (one shared ledger):** starter **10** · market **100** · business **500** · enterprise **fair-use**. **Weighted**: voice parse debits **1**; insight or risk score debits **5**. **Debit on success only.**
- **Bundles (IAP consumables, server verifies receipts):** messages 50/₦750 · 150/₦2,000 · 500/₦6,000 (one allowance across SMS & WhatsApp). AI credits 50/₦500 · 150/₦1,200 · 400/₦2,800.
- **BVUM ("Business Value Under Management")** ceilings: starter ₦2M · market ₦2M · business ₦20M · enterprise unlimited. Weights: outstanding receivables **40%**, monthly credit issued **30%**, recovery volume **15%**, active debtors **10%**, complexity **5%**. **30-day observation window.** Output is an **upgrade RECOMMENDATION only** — plan changes are always user-confirmed, never automatic. Downgrades only after sustained sub-threshold BVUM.

## Reminder engine
- On debt creation the backend generates the schedule: **3 days before due → due date → +3 days → +7 days**; **stops on payment**; configurable.
- Delivery worker behind the **`MessageSender`** interface (same BulkSMSNigeria account as OTP; works pre-CAC under shared sender ID "INFINITI").
- Channels: **`sms` | `whatsapp` | `manual` | `printable`**. `manual` (including `call`) and `printable` are **recorded-history only** (no delivery contract) and are **free/unmetered**. `sms`/`whatsapp` automated sends are metered per Metering.
- `channel: "call"` = trader phoned the debtor and taps to log it. Deep-link sending (Mode 1) already shipped in `f476925` (out of backend scope); `POST /reminders` records history exactly.
- The delivery worker MAY ship as a **501 scaffold** initially; contracts are unchanged when it goes live.

## AI
- One shared **credits ledger** (IAP top-ups credit it; any AI endpoint debits on success, weighted per Metering). LLM provider behind an interface.
- `POST /voice/parse` — transcript-only (first consumer, debits 1). Audio path scaffolded **501**.
- `GET /insights/dashboard` and `GET /customers/:id/risk` — **501** contracts against the same ledger (debit 5 on success), `sourceScreens: []`.
- Product-truth guardrail: AI **never** controls critical workflows or irreversible decisions; balance/overdue/scheduling/receipt-numbering/search are **traditional software, never AI**. Recommendations are optional and editable.

## Payments (Paystack platform model)
- One **platform merchant** account; a **subaccount per business** created server-side from the payout-account screen's data (**bankCode, accountNumber, accountName only** — nothing else stored).
- `GET /banks` (proxy), `POST /payout-account/resolve` (name check), `PUT /payout-account` (create/update subaccount), `POST /debts/:id/pay-link`, and signature-verified **`POST /webhooks/paystack`** (idempotent on the Paystack reference).

## Non-REST surfaces present
- **Inbound webhooks**: Paystack (`POST /webhooks/paystack`, provider-signature auth, no user role); IAP server notifications (App Store / Play).
- **Schedulers/background**: reminder schedule generation + delivery worker; BVUM 30-day observation computation.
- **Push notifications**: owner-only (debtors never install the app) — declared surface; may ship later.

## Env / secrets (heads-up; accumulated into env-manifest.json)
BulkSMSNigeria API token · Paystack secret key + webhook secret · JWT access/refresh signing keys · LLM provider key (unused until AI endpoints go live) · IAP verification secrets (Apple shared secret, Google Play service account).
