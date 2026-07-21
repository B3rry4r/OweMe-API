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
import { OTP_SENDER, OtpSender, uuidv7 } from '../../../common';
import { AuthModule } from '../../../auth/auth.module';
import { AdminModule } from '../../admin.module';
import { hashPassword } from '../../common';
import { AdminSyncHealthModule } from '../admin-sync-health.module';

// Admin secrets are env-driven with no insecure fallback; specs boot with explicit
// test values, mirroring how test/setenv.ts boots the user-auth specs.
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'test-admin-access-secret';
process.env.ADMIN_JWT_REFRESH_SECRET =
  process.env.ADMIN_JWT_REFRESH_SECRET ?? 'test-admin-refresh-secret';

/** Spy OtpSender so the spec can mint a REAL user session for cross-rejection. */
class SpyOtpSender implements OtpSender {
  readonly codes = new Map<string, string>();
  async sendOtp(phone: string, code: string): Promise<void> {
    this.codes.set(phone, code);
  }
}

/**
 * AdminSyncHealthView (contract, need gap-4). Same boot as app.module (global user
 * guards, ValidationPipe, HttpExceptionFilter) plus AdminModule (admin login) and the
 * user AuthModule (a real user token for the cross-rejection gate). Covers the
 * empty-database read, the seeded totals/per-business shape, the recency proxy, paging,
 * query validation, both role gates and the read-only invariant.
 */
describe('AdminSyncHealthView (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sender = new SpyOtpSender();

  const ROOT_EMAIL = 'root-sync@oweme.app';
  const ROOT_PASSWORD = 'RootPass!2026';
  const SUPPORT_EMAIL = 'support-sync@oweme.app';
  const SUPPORT_PASSWORD = 'SupportPass!1';
  const USER_PHONE = '2348039990077';
  let rootAccess: string;
  let supportAccess: string;
  let userAccess: string;
  let userMeStatus: number;

  // businessName asc is the paging order: Alpha, Beta, Gamma.
  const ALPHA = uuidv7();
  const BETA = uuidv7();
  const GAMMA = uuidv7();

  const login = async (email: string, password: string) =>
    request(app.getHttpServer()).post('/admin/auth/login').send({ email, password });

  const get = async (query: Record<string, string | number> = {}, token: string = rootAccess) =>
    request(app.getHttpServer())
      .get('/admin/sync-health')
      .query(query)
      .set('Authorization', `Bearer ${token}`);

  const expectBusinessShape = (b: Record<string, unknown>): void => {
    expect(Object.keys(b).sort()).toEqual([
      'businessId',
      'businessName',
      'customerTombstones',
      'debtTombstones',
      'newestWriteAt',
    ]);
    expect(typeof b.businessId).toBe('string');
    expect(typeof b.businessName).toBe('string');
    expect(typeof b.customerTombstones).toBe('number');
    expect(typeof b.debtTombstones).toBe('number');
    if (b.newestWriteAt !== null) {
      expect(new Date(b.newestWriteAt as string).toISOString()).toBe(b.newestWriteAt);
    }
  };

  const createBusiness = async (id: string, businessName: string): Promise<void> => {
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
  };

  const createCustomer = async (
    businessId: string,
    name: string,
    deleted: boolean,
  ): Promise<string> => {
    const id = uuidv7();
    await prisma.customer.create({
      data: { id, businessId, name, phone: '08030000000', deleted },
    });
    return id;
  };

  const createDebt = async (
    businessId: string,
    customerId: string,
    amount: number,
    deleted: boolean,
  ): Promise<string> => {
    const id = uuidv7();
    await prisma.debt.create({ data: { id, businessId, customerId, amount, deleted } });
    return id;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // AdminSyncHealthModule is imported directly: the integrator, not this agent,
      // adds it to AdminModule, so the spec must stand alone until that lands.
      imports: [PrismaModule, CommonModule, AdminModule, AdminSyncHealthModule, AuthModule],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(OTP_SENDER)
      .useValue(sender)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    prisma = app.get(PrismaService);
    await app.init();

    // Mint a REAL user session through the live OTP flow FIRST: verify-otp provisions an
    // onboarding Business + Staff, and this reader's totals are global, so the spec proves
    // the token works and then clears every tenant row before reading anything.
    await request(app.getHttpServer()).post('/auth/request-otp').send({ phone: USER_PHONE });
    const userSession = await request(app.getHttpServer())
      .post('/auth/verify-otp')
      .send({ phone: USER_PHONE, code: sender.codes.get(USER_PHONE) });
    userAccess = userSession.body.accessToken as string;
    userMeStatus = (
      await request(app.getHttpServer()).get('/me').set('Authorization', `Bearer ${userAccess}`)
    ).status;

    // Totals are global, so the spec owns the tenant tables for its run.
    await prisma.payment.deleteMany({});
    await prisma.reminder.deleteMany({});
    await prisma.debt.deleteMany({});
    await prisma.customer.deleteMany({});
    await prisma.refreshToken.deleteMany({});
    await prisma.staff.deleteMany({});
    await prisma.business.deleteMany({});

    await prisma.adminRefreshToken.deleteMany({});
    await prisma.adminUser.deleteMany({});
    for (const [email, name, role, password] of [
      [ROOT_EMAIL, 'Sync Root', 'superadmin', ROOT_PASSWORD],
      [SUPPORT_EMAIL, 'Sync Support', 'support', SUPPORT_PASSWORD],
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
    rootAccess = (await login(ROOT_EMAIL, ROOT_PASSWORD)).body.accessToken as string;
    supportAccess = (await login(SUPPORT_EMAIL, SUPPORT_PASSWORD)).body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('empty tables (new-table-free reader must still read honest zeros)', () => {
    it('GET /admin/sync-health returns zeros, an empty page and the limitation list', async () => {
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.body.totals).toEqual({
        customerTombstones: 0,
        debtTombstones: 0,
        archivedDebts: 0,
      });
      expect(res.body.perBusiness).toEqual({ data: [], page: 1, total: 0 });
      expect(Array.isArray(res.body.knownLimitations)).toBe(true);
      expect(res.body.knownLimitations.length).toBeGreaterThan(0);
    });
  });

  describe('seeded data', () => {
    let alphaNewest: string;

    beforeAll(async () => {
      await createBusiness(ALPHA, 'Alpha Traders');
      await createBusiness(BETA, 'Beta Stores');
      await createBusiness(GAMMA, 'Gamma Ventures');

      // Alpha: 2 customer tombstones + 1 live customer, 3 debt tombstones + 1 live debt,
      // and a payment written LAST so it owns the recency proxy.
      const alphaLive = await createCustomer(ALPHA, 'Live Alpha Customer', false);
      await createCustomer(ALPHA, 'Gone Alpha Customer 1', true);
      await createCustomer(ALPHA, 'Gone Alpha Customer 2', true);
      const alphaDebt = await createDebt(ALPHA, alphaLive, 500000, false);
      for (let i = 0; i < 3; i += 1) await createDebt(ALPHA, alphaLive, 100000, true);
      const payment = await prisma.payment.create({
        data: {
          id: uuidv7(),
          businessId: ALPHA,
          debtId: alphaDebt,
          amount: 100000,
          method: 'Cash',
          reference: 'OWM-00418',
        },
      });
      alphaNewest = payment.updatedAt.toISOString();

      // Beta: live rows only, so zero tombstones but a real newestWriteAt.
      const betaCustomer = await createCustomer(BETA, 'Live Beta Customer', false);
      await createDebt(BETA, betaCustomer, 250000, false);

      // Gamma: no synced rows at all -> zeros and a null recency proxy.
    });

    it('returns global tombstone totals across every business', async () => {
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.body.totals).toEqual({
        customerTombstones: 2,
        debtTombstones: 3,
        // Same column as debtTombstones by construction; asserted so the conflation is contractual.
        archivedDebts: 3,
      });
    });

    it('surfaces the payment hard-delete limitation verbatim for support', async () => {
      const res = await get();
      expect(res.status).toBe(200);
      const joined = (res.body.knownLimitations as string[]).join(' ');
      expect(joined).toContain('/debts/:id/undo-payment');
      expect(joined).toContain('HARD-delete');
      expect(joined).toContain('NO sync tombstone');
    });

    it('returns Paged<AdminSyncBusinessView> with per-business counts and the recency proxy', async () => {
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.body.perBusiness.page).toBe(1);
      expect(res.body.perBusiness.total).toBe(3);
      expect(res.body.perBusiness.data).toHaveLength(3);
      for (const row of res.body.perBusiness.data) expectBusinessShape(row);

      const [alpha, beta, gamma] = res.body.perBusiness.data;
      expect(alpha.businessName).toBe('Alpha Traders');
      expect(alpha.businessId).toBe(ALPHA);
      expect(alpha.customerTombstones).toBe(2);
      expect(alpha.debtTombstones).toBe(3);
      // Max updatedAt across Customer/Debt/Payment: the payment was written last.
      expect(alpha.newestWriteAt).toBe(alphaNewest);

      expect(beta.businessName).toBe('Beta Stores');
      expect(beta.customerTombstones).toBe(0);
      expect(beta.debtTombstones).toBe(0);
      expect(beta.newestWriteAt).not.toBeNull();

      expect(gamma.businessName).toBe('Gamma Ventures');
      expect(gamma.customerTombstones).toBe(0);
      expect(gamma.debtTombstones).toBe(0);
      expect(gamma.newestWriteAt).toBeNull();
    });

    it('paginates the per-business table by offset with a stable order', async () => {
      const page1 = await get({ page: 1, limit: 2 });
      expect(page1.status).toBe(200);
      expect(page1.body.perBusiness.data).toHaveLength(2);
      expect(page1.body.perBusiness.page).toBe(1);
      expect(page1.body.perBusiness.total).toBe(3);
      expect(page1.body.perBusiness.data.map((b: { businessName: string }) => b.businessName)).toEqual([
        'Alpha Traders',
        'Beta Stores',
      ]);

      const page2 = await get({ page: 2, limit: 2 });
      expect(page2.status).toBe(200);
      expect(page2.body.perBusiness.data).toHaveLength(1);
      expect(page2.body.perBusiness.page).toBe(2);
      expect(page2.body.perBusiness.total).toBe(3);
      expect(page2.body.perBusiness.data[0].businessName).toBe('Gamma Ventures');

      // Totals stay global on every page, never page-scoped.
      expect(page2.body.totals).toEqual({
        customerTombstones: 2,
        debtTombstones: 3,
        archivedDebts: 3,
      });

      const past = await get({ page: 9, limit: 2 });
      expect(past.status).toBe(200);
      expect(past.body.perBusiness).toEqual({ data: [], page: 9, total: 3 });
    });

    it('rejects out-of-range paging and unknown query keys -> 422 VALIDATION_ERROR', async () => {
      const badQueries: Record<string, string | number>[] = [
        { page: 0 },
        { limit: 0 },
        { limit: 101 },
        { limit: 'many' },
        { nonsense: 'x' },
      ];
      for (const query of badQueries) {
        const res = await get(query);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('auth and role gates (registry: superadmin + support)', () => {
    it('support -> 200', async () => {
      const res = await get({}, supportAccess);
      expect(res.status).toBe(200);
      expect(res.body.perBusiness.total).toBe(3);
    });

    it('no token -> 401 UNAUTHENTICATED', async () => {
      const res = await request(app.getHttpServer()).get('/admin/sync-health');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('garbage token -> 401', async () => {
      const res = await get({}, 'not-a-token');
      expect(res.status).toBe(401);
    });

    it('a valid USER access token is rejected -> 401', async () => {
      // The token is genuine: it passed the user guard on /me during setup.
      expect(userMeStatus).toBe(200);

      const res = await get({}, userAccess);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('read-only invariant', () => {
    it('exposes no write route -> 404 NOT_FOUND', async () => {
      const attempts: ['post' | 'put' | 'patch' | 'delete', string][] = [
        ['post', '/admin/sync-health'],
        ['put', '/admin/sync-health'],
        ['patch', '/admin/sync-health'],
        ['delete', '/admin/sync-health'],
        ['delete', `/admin/sync-health/${ALPHA}`],
      ];
      for (const [method, path] of attempts) {
        const res = await request(app.getHttpServer())
          [method](path)
          .set('Authorization', `Bearer ${rootAccess}`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      expect(await prisma.customer.count({ where: { deleted: true } })).toBe(2);
    });
  });
});
