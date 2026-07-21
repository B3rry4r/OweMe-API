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
import {
  OTP_SENDER,
  OtpSender,
  PAYSTACK_GATEWAY,
  StubPaystackGateway,
  uuidv7,
} from '../../../common';
import { AuthModule } from '../../../auth/auth.module';
import { AdminModule } from '../../admin.module';
import { hashPassword } from '../../common';
import { AdminPayoutsModule } from '../admin-payouts.module';

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
 * AdminPayoutsView (contract). Same boot as app.module (global user guards,
 * ValidationPipe, HttpExceptionFilter) plus AdminModule (admin login) and the
 * AdminPayoutsModule under test; AuthModule joins so the user-token rejection is
 * proven against a REAL user session. Covers auth + role gates, both endpoint
 * shapes with seeded data AND with no payout accounts at all, server-side NUBAN
 * masking, bank-name resolution, search and paging.
 */
describe('AdminPayoutsView (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sender = new SpyOtpSender();

  const ROOT_EMAIL = 'root-payouts@oweme.app';
  const ROOT_PASSWORD = 'RootPass!2026';
  const SUPPORT_EMAIL = 'support-payouts@oweme.app';
  const SUPPORT_PASSWORD = 'SupportPass!1';
  const USER_PHONE = '2348039990077';
  let rootAccess: string;
  let supportAccess: string;

  const BUSINESS_A = uuidv7(); // Ada Fabrics        - Access Bank, subaccount active
  const BUSINESS_B = uuidv7(); // Mama Nkechi Provisions - Zenith Bank, no subaccount
  const BUSINESS_C = uuidv7(); // Okoro Electronics  - Guaranty Trust Bank, subaccount active
  const BUSINESS_D = uuidv7(); // Chidi Motors       - no payout account at all
  const BUSINESS_IDS = [BUSINESS_A, BUSINESS_B, BUSINESS_C, BUSINESS_D];

  const login = async (email: string, password: string) =>
    request(app.getHttpServer()).post('/admin/auth/login').send({ email, password });

  const accounts = async (
    query: Record<string, string | number> = {},
    token: string = rootAccess,
  ) =>
    request(app.getHttpServer())
      .get('/admin/payouts/accounts')
      .query(query)
      .set('Authorization', `Bearer ${token}`);

  const stats = async (token: string = rootAccess) =>
    request(app.getHttpServer())
      .get('/admin/payouts/stats')
      .set('Authorization', `Bearer ${token}`);

  const expectAccountShape = (a: Record<string, unknown>): void => {
    expect(typeof a.businessId).toBe('string');
    expect(typeof a.businessName).toBe('string');
    expect(typeof a.bankName).toBe('string');
    expect(typeof a.nubanMasked).toBe('string');
    expect(typeof a.accountName).toBe('string');
    expect(typeof a.subaccountActive).toBe('boolean');
    for (const key of [
      'settledMonthKobo',
      'settledTotalKobo',
      'pendingSettlements',
      'lastSettlementAt',
    ]) {
      expect(a[key]).toBeNull();
    }
  };

  const createBusiness = async (
    id: string,
    businessName: string,
    paystackSubaccount: string | null,
  ): Promise<void> => {
    await prisma.business.create({
      data: {
        id,
        businessName,
        ownerName: 'Owner',
        phone: '2348000000000',
        category: 'Retail',
        currency: 'NGN (₦)',
        reminderTone: 'friendly',
        paystackSubaccount,
      },
    });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, AdminModule, AdminPayoutsModule, AuthModule],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(OTP_SENDER)
      .useValue(sender)
      // Pin the bank list so bankName resolution is deterministic.
      .overrideProvider(PAYSTACK_GATEWAY)
      .useValue(new StubPaystackGateway())
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    prisma = app.get(PrismaService);
    await app.init();

    await prisma.adminRefreshToken.deleteMany({});
    await prisma.adminUser.deleteMany({});
    for (const [email, name, role, password] of [
      [ROOT_EMAIL, 'Payouts Root', 'superadmin', ROOT_PASSWORD],
      [SUPPORT_EMAIL, 'Payouts Support', 'support', SUPPORT_PASSWORD],
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
    await prisma.payoutAccount.deleteMany({ where: { businessId: { in: BUSINESS_IDS } } });
    await prisma.business.deleteMany({ where: { id: { in: BUSINESS_IDS } } });
    await app.close();
  });

  describe('auth', () => {
    it('GET /admin/payouts/accounts with no token -> 401', async () => {
      const res = await request(app.getHttpServer()).get('/admin/payouts/accounts');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('GET /admin/payouts/stats with no token -> 401', async () => {
      const res = await request(app.getHttpServer()).get('/admin/payouts/stats');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('a valid USER access token is rejected on both routes', async () => {
      const otpReq = await request(app.getHttpServer())
        .post('/auth/request-otp')
        .send({ phone: USER_PHONE });
      expect(otpReq.status).toBe(202);
      const userSession = await request(app.getHttpServer())
        .post('/auth/verify-otp')
        .send({ phone: USER_PHONE, code: sender.codes.get(USER_PHONE)! });
      expect(userSession.status).toBe(200);
      const userToken = userSession.body.accessToken as string;

      for (const path of ['/admin/payouts/accounts', '/admin/payouts/stats']) {
        const res = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${userToken}`);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('garbage bearer token -> 401', async () => {
      const res = await accounts({}, 'not-a-jwt');
      expect(res.status).toBe(401);
    });
  });

  describe('empty state (no payout accounts)', () => {
    it('GET /admin/payouts/accounts -> empty page, never an error', async () => {
      const res = await accounts();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [], page: 1, total: 0 });
    });

    it('GET /admin/payouts/stats -> honest zeros with null settlement figures', async () => {
      const res = await stats();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        payoutAccountsSetUpCount: 0,
        activeSubaccountCount: 0,
        settledToTradersMonthKobo: null,
        pendingSettlementsTotal: null,
        failedAccountResolutionCount: null,
      });
    });
  });

  describe('seeded reads', () => {
    beforeAll(async () => {
      await createBusiness(BUSINESS_A, 'Ada Fabrics', 'ACCT_ada');
      await createBusiness(BUSINESS_B, 'Mama Nkechi Provisions', null);
      await createBusiness(BUSINESS_C, 'Okoro Electronics', 'ACCT_okoro');
      await createBusiness(BUSINESS_D, 'Chidi Motors', null);

      for (const [businessId, bankCode, accountNumber, accountName] of [
        [BUSINESS_A, '044', '0123456789', 'ADA FABRICS LTD'],
        [BUSINESS_B, '057', '2233445566', 'NKECHI OKAFOR'],
        [BUSINESS_C, '058', '9988776655', 'OKORO ELECTRONICS'],
      ]) {
        await prisma.payoutAccount.create({
          data: { businessId, bankCode, accountNumber, accountName },
        });
      }
    });

    it('GET /admin/payouts/accounts returns the registry shape, business-name ordered', async () => {
      const res = await accounts();
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      expect(res.body.total).toBe(3);
      expect(res.body.data).toHaveLength(3);
      res.body.data.forEach(expectAccountShape);
      expect(res.body.data.map((a: { businessName: string }) => a.businessName)).toEqual([
        'Ada Fabrics',
        'Mama Nkechi Provisions',
        'Okoro Electronics',
      ]);
    });

    it('masks the NUBAN server-side and resolves bankName from bankCode', async () => {
      const res = await accounts();
      const ada = res.body.data[0];
      expect(ada.businessId).toBe(BUSINESS_A);
      expect(ada.bankName).toBe('Access Bank');
      expect(ada.nubanMasked).toBe('****6789');
      expect(ada.accountName).toBe('ADA FABRICS LTD');
      // The full account number never crosses the boundary.
      expect(JSON.stringify(res.body)).not.toContain('0123456789');
      expect(res.body.data[1].bankName).toBe('Zenith Bank');
      expect(res.body.data[2].bankName).toBe('Guaranty Trust Bank');
    });

    it('subaccountActive mirrors Business.paystackSubaccount', async () => {
      const res = await accounts();
      expect(res.body.data[0].subaccountActive).toBe(true); // Ada Fabrics
      expect(res.body.data[1].subaccountActive).toBe(false); // Mama Nkechi Provisions
      expect(res.body.data[2].subaccountActive).toBe(true); // Okoro Electronics
    });

    it('search matches business name', async () => {
      const res = await accounts({ search: 'Nkechi' });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].businessId).toBe(BUSINESS_B);
    });

    it('search matches account name', async () => {
      const res = await accounts({ search: 'NKECHI OKAFOR' });
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].businessId).toBe(BUSINESS_B);
    });

    it('search matches bank name even though only the code is stored', async () => {
      const res = await accounts({ search: 'guaranty' });
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].businessId).toBe(BUSINESS_C);
      expect(res.body.data[0].bankName).toBe('Guaranty Trust Bank');
    });

    it('search with no match -> empty page, not an error', async () => {
      const res = await accounts({ search: 'no-such-trader' });
      expect(res.body).toEqual({ data: [], page: 1, total: 0 });
    });

    it('paginates with page + limit, total counting the whole filtered set', async () => {
      const first = await accounts({ page: 1, limit: 2 });
      expect(first.body.page).toBe(1);
      expect(first.body.total).toBe(3);
      expect(first.body.data).toHaveLength(2);

      const second = await accounts({ page: 2, limit: 2 });
      expect(second.body.page).toBe(2);
      expect(second.body.total).toBe(3);
      expect(second.body.data).toHaveLength(1);
      expect(second.body.data[0].businessName).toBe('Okoro Electronics');

      const past = await accounts({ page: 9, limit: 2 });
      expect(past.body).toEqual({ data: [], page: 9, total: 3 });
    });

    it('rejects an out-of-range limit through the global ValidationPipe', async () => {
      const res = await accounts({ limit: 500 });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('GET /admin/payouts/stats counts real rows, settlement figures stay null', async () => {
      const res = await stats();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        payoutAccountsSetUpCount: 3,
        activeSubaccountCount: 2,
        settledToTradersMonthKobo: null,
        pendingSettlementsTotal: null,
        failedAccountResolutionCount: null,
      });
    });
  });

  describe('role gates (registry: superadmin + support on both endpoints)', () => {
    it('support may read the accounts table', async () => {
      const res = await accounts({}, supportAccess);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      res.body.data.forEach(expectAccountShape);
    });

    it('support may read the stats', async () => {
      const res = await stats(supportAccess);
      expect(res.status).toBe(200);
      expect(res.body.payoutAccountsSetUpCount).toBe(3);
    });
  });
});
