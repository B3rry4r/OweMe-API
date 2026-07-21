import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { PrismaModule } from '../../../prisma/prisma.module';
import { PrismaService } from '../../../prisma/prisma.service';
import { CommonModule } from '../../../common/common.module';
import { HttpExceptionFilter } from '../../../common/filters/http-exception.filter';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { uuidv7 } from '../../../common';
import { AdminModule } from '../../admin.module';
import { hashPassword } from '../../common';
import { AdminAuditService } from '../admin-audit.service';

// Admin secrets are env-driven with no insecure fallback; specs boot with explicit
// test values, mirroring how test/setenv.ts boots the user-auth specs.
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'test-admin-access-secret';
process.env.ADMIN_JWT_REFRESH_SECRET =
  process.env.ADMIN_JWT_REFRESH_SECRET ?? 'test-admin-refresh-secret';

/**
 * AdminAuditLog (contract). Same boot as app.module (global user guards,
 * ValidationPipe, HttpExceptionFilter) + the AdminModule aggregate. Covers the
 * shared record() write helper, the paged/filtered list joined to business names,
 * the id+name admin enumeration for the filter dropdown, the support-may-read role
 * gate and the append-only invariant (no write route exists on this resource).
 */
describe('AdminAuditLog (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let audit: AdminAuditService;

  const ROOT_EMAIL = 'root-audit@oweme.app';
  const ROOT_PASSWORD = 'RootPass!2026';
  const SUPPORT_EMAIL = 'support-audit@oweme.app';
  const SUPPORT_PASSWORD = 'SupportPass!1';
  let rootId: string;
  let supportId: string;
  let rootAccess: string;
  let supportAccess: string;

  const BUSINESS_A = uuidv7(); // Mama Nkechi Provisions
  const BUSINESS_B = uuidv7(); // Okoro Electronics

  const rootActor = () => ({ adminId: rootId, name: 'Audit Root', role: 'superadmin' as const });
  const supportActor = () =>
    ({ adminId: supportId, name: 'Audit Support', role: 'support' as const });

  const login = async (email: string, password: string) =>
    request(app.getHttpServer()).post('/admin/auth/login').send({ email, password });

  const list = async (query: Record<string, string | number> = {}, token: string = rootAccess) =>
    request(app.getHttpServer())
      .get('/admin/audit-log')
      .query(query)
      .set('Authorization', `Bearer ${token}`);

  const expectEntryShape = (e: Record<string, unknown>): void => {
    expect(typeof e.id).toBe('string');
    expect(typeof e.at).toBe('string');
    expect(new Date(e.at as string).toISOString()).toBe(e.at);
    expect(typeof e.adminId).toBe('string');
    expect(typeof e.adminName).toBe('string');
    expect(['superadmin', 'support']).toContain(e.adminRole);
    expect(typeof e.actionType).toBe('string');
    expect(typeof e.action).toBe('string');
    for (const key of ['targetBusinessId', 'targetBusinessName', 'targetType', 'targetId', 'note']) {
      expect(e[key] === null || typeof e[key] === 'string').toBe(true);
    }
    for (const key of ['before', 'after']) {
      expect(e[key] === null || typeof e[key] === 'object').toBe(true);
    }
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, AdminModule],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    prisma = app.get(PrismaService);
    audit = app.get(AdminAuditService);
    await app.init();

    await prisma.adminAuditLog.deleteMany({});
    await prisma.adminRefreshToken.deleteMany({});
    await prisma.adminUser.deleteMany({});
    for (const [email, name, role, password] of [
      [ROOT_EMAIL, 'Audit Root', 'superadmin', ROOT_PASSWORD],
      [SUPPORT_EMAIL, 'Audit Support', 'support', SUPPORT_PASSWORD],
    ]) {
      await prisma.adminUser.create({
        data: {
          id: uuidv7(),
          email,
          name,
          passwordHash: hashPassword(password),
          role,
          status: 'active',
          mustChangePassword: false,
        },
      });
    }
    rootId = (await prisma.adminUser.findUnique({ where: { email: ROOT_EMAIL } }))!.id;
    supportId = (await prisma.adminUser.findUnique({ where: { email: SUPPORT_EMAIL } }))!.id;
    rootAccess = (await login(ROOT_EMAIL, ROOT_PASSWORD)).body.accessToken as string;
    supportAccess = (await login(SUPPORT_EMAIL, SUPPORT_PASSWORD)).body.accessToken as string;

    for (const [id, businessName] of [
      [BUSINESS_A, 'Mama Nkechi Provisions'],
      [BUSINESS_B, 'Okoro Electronics'],
    ]) {
      await prisma.business.create({
        data: {
          id,
          businessName,
          ownerName: 'Owner',
          phone: '2348000000000',
          category: 'Retail',
          currency: 'NGN (₦)',
          reminderTone: 'friendly',
        },
      });
    }

    // The two setup logins wrote their own audit rows; start the read tests clean.
    await prisma.adminAuditLog.deleteMany({});
  });

  afterAll(async () => {
    await prisma.business.deleteMany({ where: { id: { in: [BUSINESS_A, BUSINESS_B] } } });
    await app.close();
  });

  describe('empty table', () => {
    it('GET /admin/audit-log reads gracefully from the empty table', async () => {
      const res = await list();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [], page: 1, total: 0 });
    });
  });

  describe('record() write helper', () => {
    it('persists a self-contained row with actor snapshots', async () => {
      await audit.record(rootActor(), {
        actionType: 'grant-credits',
        action: 'Audit Root granted 500 credits to Mama Nkechi Provisions',
        targetType: 'CreditLedger',
        targetId: 'ledger-1',
        targetBusinessId: BUSINESS_A,
        before: { balance: 100 },
        after: { balance: 600 },
        note: 'Goodwill top-up',
      });

      const row = await prisma.adminAuditLog.findFirst({ where: { actionType: 'grant-credits' } });
      expect(row).not.toBeNull();
      expect(row!.adminUserId).toBe(rootId);
      expect(row!.adminNameSnapshot).toBe('Audit Root');
      expect(row!.adminRoleSnapshot).toBe('superadmin');
      expect(row!.action).toContain('granted 500 credits');
      expect(row!.targetType).toBe('CreditLedger');
      expect(row!.targetId).toBe('ledger-1');
      expect(row!.targetBusinessId).toBe(BUSINESS_A);
      expect(row!.before).toEqual({ balance: 100 });
      expect(row!.after).toEqual({ balance: 600 });
      expect(row!.note).toBe('Goodwill top-up');
      expect(row!.createdAt).toBeInstanceOf(Date);
    });

    it('optional fields default to null', async () => {
      await audit.record(supportActor(), {
        actionType: 'retry-reminder',
        action: 'Audit Support retried a failed reminder for Okoro Electronics',
        targetType: 'Reminder',
        targetId: 'reminder-1',
        targetBusinessId: BUSINESS_B,
      });

      const row = await prisma.adminAuditLog.findFirst({ where: { actionType: 'retry-reminder' } });
      expect(row).not.toBeNull();
      expect(row!.adminRoleSnapshot).toBe('support');
      expect(row!.before).toBeNull();
      expect(row!.after).toBeNull();
      expect(row!.note).toBeNull();
    });
  });

  describe('GET /admin/audit-log (filters + paging)', () => {
    beforeAll(async () => {
      // Two more rows on top of grant-credits + retry-reminder: 4 total.
      await audit.record(rootActor(), {
        actionType: 'suspend',
        action: 'Audit Root suspended Mama Nkechi Provisions',
        targetType: 'Business',
        targetId: BUSINESS_A,
        targetBusinessId: BUSINESS_A,
        before: { suspendedAt: null },
        after: { suspendedAt: '2026-07-21T00:00:00.000Z' },
      });
      await audit.record(rootActor(), {
        actionType: 'create-admin',
        action: 'Audit Root created support admin Third Admin',
        targetType: 'AdminUser',
        targetId: uuidv7(),
      });
    });

    it('returns Paged<AdminAuditEntryView> newest first with business names joined', async () => {
      const res = await list();
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      expect(res.body.total).toBe(4);
      expect(res.body.data).toHaveLength(4);
      for (const entry of res.body.data) expectEntryShape(entry);

      // Newest first: the create-admin row was written last.
      expect(res.body.data[0].actionType).toBe('create-admin');
      expect(res.body.data[0].targetBusinessId).toBeNull();
      expect(res.body.data[0].targetBusinessName).toBeNull();

      const grant = res.body.data.find(
        (e: Record<string, unknown>) => e.actionType === 'grant-credits',
      );
      expect(grant.targetBusinessName).toBe('Mama Nkechi Provisions');
      expect(grant.adminName).toBe('Audit Root');
      expect(grant.before).toEqual({ balance: 100 });
      expect(grant.after).toEqual({ balance: 600 });
      expect(grant.note).toBe('Goodwill top-up');
    });

    it('filters by adminId', async () => {
      const res = await list({ adminId: supportId });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].actionType).toBe('retry-reminder');
      expect(res.body.data[0].adminId).toBe(supportId);
      expect(res.body.data[0].adminRole).toBe('support');
    });

    it('filters by actionType', async () => {
      const res = await list({ actionType: 'suspend' });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].targetBusinessId).toBe(BUSINESS_A);
    });

    it('filters by targetBusinessId', async () => {
      const res = await list({ targetBusinessId: BUSINESS_A });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      for (const entry of res.body.data) {
        expect(entry.targetBusinessId).toBe(BUSINESS_A);
        expect(entry.targetBusinessName).toBe('Mama Nkechi Provisions');
      }
    });

    it('filters by targetBusinessSearch (business name contains)', async () => {
      const res = await list({ targetBusinessSearch: 'Okoro' });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].actionType).toBe('retry-reminder');

      const none = await list({ targetBusinessSearch: 'No Such Shop' });
      expect(none.status).toBe(200);
      expect(none.body).toEqual({ data: [], page: 1, total: 0 });
    });

    it('filters by month (YYYY-MM)', async () => {
      const now = new Date();
      const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      const res = await list({ month: current });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(4);

      const empty = await list({ month: '2020-01' });
      expect(empty.status).toBe(200);
      expect(empty.body.total).toBe(0);
    });

    it('paginates by offset with a stable order', async () => {
      const page1 = await list({ page: 1, limit: 3 });
      expect(page1.status).toBe(200);
      expect(page1.body.data).toHaveLength(3);
      expect(page1.body.page).toBe(1);
      expect(page1.body.total).toBe(4);

      const page2 = await list({ page: 2, limit: 3 });
      expect(page2.status).toBe(200);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.page).toBe(2);
      expect(page2.body.total).toBe(4);

      const page1Ids = page1.body.data.map((e: Record<string, unknown>) => e.id);
      expect(page1Ids).not.toContain(page2.body.data[0].id);
    });

    it('rejects out-of-range paging and malformed month -> 422 VALIDATION_ERROR', async () => {
      const badQueries: Record<string, string | number>[] = [
        { limit: 0 },
        { limit: 101 },
        { page: 0 },
        { month: '2026-13' },
      ];
      for (const query of badQueries) {
        const res = await list(query);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('GET /admin/audit-log/admins (filter dropdown)', () => {
    it('returns id+name only, never emails or status', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/audit-log/admins')
        .set('Authorization', `Bearer ${supportAccess}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
      for (const row of res.body) {
        expect(Object.keys(row).sort()).toEqual(['id', 'name']);
      }
      const names = res.body.map((r: Record<string, unknown>) => r.name);
      expect(names).toContain('Audit Root');
      expect(names).toContain('Audit Support');
    });
  });

  describe('role gate (support may read per registry)', () => {
    it('support -> 200 on the list; no token -> 401; garbage token -> 401', async () => {
      const support = await list({}, supportAccess);
      expect(support.status).toBe(200);

      const noAuth = await request(app.getHttpServer()).get('/admin/audit-log');
      expect(noAuth.status).toBe(401);
      expect(noAuth.body.error.code).toBe('UNAUTHENTICATED');

      const garbage = await request(app.getHttpServer())
        .get('/admin/audit-log')
        .set('Authorization', 'Bearer not-a-token');
      expect(garbage.status).toBe(401);
    });
  });

  describe('admin writes flow through the shared writer', () => {
    it('a login leaves its audit row (call sites refactored onto AdminAuditService)', async () => {
      const session = await login(SUPPORT_EMAIL, SUPPORT_PASSWORD);
      expect(session.status).toBe(200);

      const res = await list({ actionType: 'login', adminId: supportId });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].adminName).toBe('Audit Support');
    });
  });

  describe('append-only invariant', () => {
    it('exposes no create/update/delete route -> 404 NOT_FOUND', async () => {
      const row = await prisma.adminAuditLog.findFirst({});
      const attempts: ['post' | 'put' | 'patch' | 'delete', string][] = [
        ['post', '/admin/audit-log'],
        ['put', `/admin/audit-log/${row!.id}`],
        ['patch', `/admin/audit-log/${row!.id}`],
        ['delete', `/admin/audit-log/${row!.id}`],
        ['delete', '/admin/audit-log'],
      ];
      for (const [method, path] of attempts) {
        const res = await request(app.getHttpServer())
          [method](path)
          .set('Authorization', `Bearer ${rootAccess}`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      // The rows written throughout the suite are all still there.
      expect(await prisma.adminAuditLog.count()).toBe(5);
    });
  });
});
