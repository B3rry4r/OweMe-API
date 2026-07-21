# Defect handoff to the UI pipeline

Compiled by the admin triage classifier, 2026-07-20. These are design/copy/data-presentation
anomalies observed in the dashboard fragments while triaging. The admin backend pipeline will
NOT fix any of these; they belong to the dashboard (UI) pipeline. File paths are relative to
/workspace/projects/OweMe-Dashboard unless stated. Companion classification data:
.pipeline/admin/triage.json (surface recommendations reference these items).

## Copy contradictions (fix the words)

1. Invite card subtitle claims "New admins verify with phone OTP on first sign in."
   This contradicts the owner-confirmed admin auth design (email + password, no 2FA in v1,
   conventions.md). app/(shell)/admins/page.tsx:203. Triage recommends CUT (admins-surf-12).
2. Admins header claims "Only superadmins see this screen." but no role gate exists anywhere
   in the page code; the copy is currently false. app/(shell)/admins/page.tsx:188-191.
   Gate must be enforced when admin auth lands, not just stated.
3. Invite confirmation notice claims "Invite sent to {email}." while nothing is sent
   (local state only). app/(shell)/admins/page.tsx:264-269. Misleading success claim.
4. Reminders route-pricing narrative presents a fabricated cost analysis (pre-CAC retail
   route pricing, an invented June route switch) interpolated with fixture numbers as if it
   were live ops insight. app/(shell)/reminders/page.tsx:202-207. Triage recommends CUT.

## Personal / sensitive data in fixtures

5. Login email placeholder renders a real personal address "excel@moxnafrica.com" from
   lib/fixtures/login.ts:12 (app/login/page.tsx:125). Replace with neutral placeholder copy.
6. Business detail action log hardcodes the admin identity "excel.admin".
   app/(shell)/businesses/detail/page.tsx:120.
7. Auth monitor fixture bulk-ships hardcoded OTP codes with the test-numbers list
   (lib/fixtures/authMonitor.ts:184-241, rendered at page.tsx:133). Codes must only ever be
   fetched per-row on demand behind the superadmin reveal action, never shipped in the list.
8. Payouts screen receives the full 10-digit NUBAN and masks it client-side
   (app/(shell)/payouts/page.tsx:25-27). Masking must be server-side or role-gated.

## Wrong-record and hardcoded-period behavior

9. Unknown ?id= on business detail silently falls back to the first fixture business instead
   of a not-found state. app/(shell)/businesses/detail/page.tsx:482-483.
10. Hardcoded period literals that must derive from data/current date once wired:
    - debts recovered-this-month filter "2026-07": app/(shell)/debts/page.tsx:132
    - pay-links month filter "2026-07": app/(shell)/pay-links/page.tsx:93-104
    - pay-links header "July 2026": app/(shell)/pay-links/page.tsx:156-159
    - payouts settled sub-label "July 2026": app/(shell)/payouts/page.tsx:132
    - ai-usage subtitle "July 2026": app/(shell)/ai-usage/page.tsx:166
    - audit-log month header "July 2026": app/(shell)/audit-log/page.tsx:122-123
    - reminders/credits month labels come from fixtures (lib/fixtures/reminders.ts:36,
      lib/fixtures/credits.ts:51) and must derive when wired.

## Hardcoded contract constants (must come from the backend config read)

11. Credit weights 5/1/4 hardcoded in the business detail component
    (app/(shell)/businesses/detail/page.tsx:144-148, 283-318) and mirrored in credits fixtures;
    triage maps these to the admin config read (credits-need-5).
12. Pay-links fee split recomputed client-side (2.5% + N100 cap N2500; 1% cap N500); must be
    server-authoritative per pay-links-need-1.
13. Plan metadata (planMeta/planOrder/enterpriseBanding/bundleCapPerMonth) imported as fixture
    constants in business detail; must come from the plan catalog / config reads.

## Vocabulary drift vs the live backend (protected-registry.json is the truth)

14. Debt status: dashboard uses active|overdue|paid (debts) and open|part-paid|overdue|paid
    (business detail); live derived vocabulary is
    outstanding|partial|overdue|scheduled|reminder|paid plus the archived filter.
15. Reminder status: dashboard uses delivered|failed|queued; live is scheduled|sent|failed and
    no delivery outcome exists at all (fire-and-forget BulkSMS).
16. Subscription state: dashboard uses active|grace|canceled; live entitlementState is
    none|pending|active|gracePeriod|expired. Pending/expired are unrepresentable today.
17. Subscription "source" (google_play|app_store|direct_invoice) is not persisted anywhere in
    the backend; the column has no data source until one is ruled in.
18. Business status "paused" has no backend basis whatsoever (no suspension state exists);
    see triage gap-5 before keeping the filter option.
19. Payment method: dashboard expects pay link|cash|transfer; live stores verbatim client
    labels plus "Paystack link" for webhook-recorded payments.

## Design-system / brand

20. Font mismatch: the dashboard self-hosts Sora as the display face and app/layout.tsx claims
    parity with the mobile app, but the app's canonical display face is Space Grotesk
    (scan-map.json fonts note). Decide and align.
21. Shell sidebar footer identity is hardcoded (components/shell.tsx, per scan-map.json);
    should render the signed-in admin once admin auth is wired.
