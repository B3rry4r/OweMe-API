# Admin pipeline conventions (Phase 0, owner-approved 2026-07-20)

Pipeline: admin-surface-extension over the LIVE OweMe-API (NestJS + Prisma,
serving the shipped OweMe mobile app). Dashboard repo:
/workspace/projects/OweMe-Dashboard (Next.js static export, fixture stage).
The live backend and everything the app consumes are PROTECTED; all admin
work is additive only. All admin-pipeline artifacts live in
`.pipeline/admin/`; the sibling greenfield artifacts in `.pipeline/` are a
historical record of the original backend build and are READ-ONLY. Where
the greenfield conventions conflict with shipped code (e.g. it predates the
rev 2 five-plan ladder), THE LIVE CODE WINS and the protected registry
records the live truth.

## Identity topology

- User auth is LOCAL to OweMe-API: phone number + SMS OTP (BulkSMSNigeria),
  JWT access + refresh rotation. No SSO. The entire user auth flow (OTP
  issuance, guards, token config) is protected surface.
- Admin identity is SEPARATE: new `AdminUser` table in OweMe-API. Admin
  auth never touches user auth files, guards, or token config.

## Admin auth design (owner-confirmed)

- Local credential login: email + password (hash per codebase convention)
  at `POST /admin/auth/login`, plus refresh and me.
- Distinct token config: env `ADMIN_JWT_SECRET`, iss `oweme-admin`,
  aud `admin-dashboard`. Cross-rejection tested both directions.
- 2FA: none for v1 (owner ruling: password only for now).
- Roles: `superadmin`, `support`. Matrix:
  - superadmin: everything.
  - support: read all monitor surfaces; may resolve support issues
    (retry a reminder, replay a webhook); may NOT touch billing, plans,
    enterprise bands, credit grants, test-account powers, admin users,
    or destructive actions.
- Seed command for the first superadmin from env vars.

## Namespace and placement

- Route prefix `/admin/*`. Code tree `src/admin/<resource>/` following the
  existing module layout; registration per Phase 4 design (single
  AdminModule aggregation preferred to minimise app.module.ts touches).

## Admin data conventions

- Admin view DTOs always distinct: `Admin<Entity>View`. Existing DTOs
  never widened.
- Pagination for admin tables: offset/paged `?page=&limit=` returning
  `{ data, page, total }` (the app's cursor convention is untouched).
- Delete semantics mirror the protected registry per entity; admin never
  hard-deletes where the app soft-deletes.
- `admin_audit_log` NEW table (owner-approved): admin actor, action,
  target entity/id, timestamp, detail/diff. Every admin WRITE endpoint
  records to it.
- Error envelope: match the live API exactly as recorded in the protected
  registry (`{error: {code, message, ...}}`), produced via the same
  mechanism.

## Test-account tooling (owner-approved, each power explicitly)

All superadmin-only and only effective on businesses flagged as test
accounts (new additive column or side table; schema agent decides):

1. Mark/unmark a business as a test account.
2. View the current OTP code for the phone of a TEST-FLAGGED business
   only. Structurally impossible for real users: the query filters on the
   flag server-side.
3. Grant credits; force a plan; set enterprise bands. Setting plan/bands
   on NON-test businesses is also allowed for superadmin (it is the sales
   provisioning path for enterprise ceilings), always audit-logged.
4. Wipe/reseed a test business: hard reset allowed ONLY behind the test
   flag; the endpoint refuses otherwise.

## Deprecation policy

Default confirmed: dashboard orphans ruled deprecate are pruned (screen,
nav, routes) with deprecation-report.md, git-recoverable.
