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
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { hashPassword } from '../../common';
import { AdminOtpRevealModule } from '../admin-otp-reveal.module';

// Admin secrets are env-driven with no insecure fallback; specs boot with explicit
// test values, mirroring how test/setenv.ts boots the user-auth specs.
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'test-admin-access-secret';
process.env.ADMIN_JWT_REFRESH_SECRET =
  process.env.ADMIN_JWT_REFRESH_SECRET ?? 'test-admin-refresh-secret';

/**
 * AdminOtpReveal (contract). Same boot as app.module (global user guards,
 * ValidationPipe, HttpExceptionFilter) plus this resource's module and AdminAuthModule
 * for real logins; the user AuthModule rides along so a REAL user token proves
 * cross-rejection and so a REAL hashed OtpCode row exists to prove it is never read.
 * Covers the auth + superadmin gates, the empty-table state (before instrumentation),
 * the happy reveal with its audit row, every refusal path (unknown business, non-test
 * business, stray side-table row for a non-test phone, expired code) and re-run safety.
 */

/** Spy OtpSender so the spec can mint a REAL user session for cross-rejection. */
class SpyOtpSender implements OtpSender {
  readonly codes = new Map<string, string>();
  async sendOtp(phone: string, code: string): Promise<void> {
    this.codes.set(phone, code);
  }
}

describe('AdminOtpReveal (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sender = new SpyOtpSender();

  const ROOT_EMAIL = 'root-otpreveal@oweme.app';
  const ROOT_PASSWORD = 'RootPass!2026';
  const SUPPORT_EMAIL = 'support-otpreveal@oweme.app';
  const SUPPORT_PASSWORD = 'SupportPass!1';
  let rootAccess: string;
  let supportAccess: string;
  let userAccess: string;

  const USER_PHONE = '2348039991777';
  const TEST_BUSINESS = uuidv7();
  const TEST_BUSINESS_PHONE = '2348011112001';
  const REAL_BUSINESS = uuidv7();
  const REAL_BUSINESS_PHONE = '2348022223002';
  const MISSING_BUSINESS = uuidv7();

  const path = (businessId: string) =>
    `/admin/auth-monitor/test-numbers/${businessId}/reveal`;

  const login = async (email: string, password: string) =>
    request(app.getHttpServer()).post('/admin/auth/login').send({ email, password });

  const reveal = async (businessId: string, token: string = rootAccess) =>
    request(app.getHttpServer())
      .post(path(businessId))
      .set('Authorization', `Bearer ${token}`);

  const auditRows = async (targetId: string) =>
    prisma.adminAuditLog.findMany({
      where: { actionType: 'reveal-otp', targetId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  const putTestCode = async (phone: string, codePlain: string, expiresAt: Date) =>
    prisma.otpTestCode.upsert({
      where: { phone },
      create: { phone, codePlain, expiresAt },
      update: { codePlain, expiresAt },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, AdminAuthModule, AdminOtpRevealModule, AuthModule],
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

    await prisma.otpTestCode.deleteMany({});
    await prisma.otpCode.deleteMany({});
    await prisma.adminAuditLog.deleteMany({});
    await prisma.adminRefreshToken.deleteMany({});
    await prisma.adminUser.deleteMany({});
    for (const [email, name, role, password] of [
      [ROOT_EMAIL, 'Reveal Root', 'superadmin', ROOT_PASSWORD],
      [SUPPORT_EMAIL, 'Reveal Support', 'support', SUPPORT_PASSWORD],
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

    // A REAL user session (live OTP flow) for the cross-rejection assertions. It also
    // leaves the live hashed-OTP machinery exercised on a phone that is not a test phone.
    await request(app.getHttpServer()).post('/auth/request-otp').send({ phone: USER_PHONE });
    const userSession = await request(app.getHttpServer())
      .post('/auth/verify-otp')
      .send({ phone: USER_PHONE, code: sender.codes.get(USER_PHONE)! });
    expect(userSession.status).toBe(200);
    userAccess = userSession.body.accessToken as string;

    await prisma.business.createMany({
      data: [
        {
          id: TEST_BUSINESS,
          businessName: 'QA Sandbox Store',
          ownerName: 'QA Owner',
          phone: TEST_BUSINESS_PHONE,
          category: 'Retail',
          currency: 'NGN (₦)',
          reminderTone: 'friendly',
          isTest: true,
        },
        {
          id: REAL_BUSINESS,
          businessName: 'Mama Nkechi Provisions',
          ownerName: 'Nkechi',
          phone: REAL_BUSINESS_PHONE,
          category: 'Retail',
          currency: 'NGN (₦)',
          reminderTone: 'friendly',
        },
      ],
    });
    await prisma.adminAuditLog.deleteMany({});
  });

  afterAll(async () => {
    await app.close();
  });

  describe('auth + role gates', () => {
    it('no token -> 401 UNAUTHENTICATED and no audit row', async () => {
      const res = await request(app.getHttpServer()).post(path(TEST_BUSINESS));
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
      expect(await auditRows(TEST_BUSINESS)).toHaveLength(0);
    });

    it('a REAL user access token is rejected (cross-rejection) and leaves no audit row', async () => {
      const res = await reveal(TEST_BUSINESS, userAccess);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
      expect(await auditRows(TEST_BUSINESS)).toHaveLength(0);
    });

    it('support -> 403 FORBIDDEN even for a test business, and no audit row', async () => {
      const res = await reveal(TEST_BUSINESS, supportAccess);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(await auditRows(TEST_BUSINESS)).toHaveLength(0);
    });
  });

  describe('empty side table (before the auth.service instrumentation lands)', () => {
    it('superadmin + test business + zero rows -> plain 404, never a 500', async () => {
      expect(await prisma.otpTestCode.count()).toBe(0);

      const res = await reveal(TEST_BUSINESS);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');

      const rows = await auditRows(TEST_BUSINESS);
      expect(rows).toHaveLength(1);
      expect(rows[0].after).toMatchObject({ outcome: 'refused', reason: 'no-active-code' });
      await prisma.adminAuditLog.deleteMany({});
    });
  });

  describe('POST /admin/auth-monitor/test-numbers/:businessId/reveal (happy path)', () => {
    const CODE = '481920';
    let expiresAt: Date;

    beforeAll(async () => {
      expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await putTestCode(TEST_BUSINESS_PHONE, CODE, expiresAt);
      await prisma.adminAuditLog.deleteMany({});
    });

    it('200 AdminOtpRevealView with the live code and a positive expiry countdown', async () => {
      const res = await reveal(TEST_BUSINESS);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(CODE);
      expect(typeof res.body.expiresInSeconds).toBe('number');
      expect(res.body.expiresInSeconds).toBeGreaterThan(0);
      expect(res.body.expiresInSeconds).toBeLessThanOrEqual(600);
      // The frozen DTO is exactly { code, expiresInSeconds } - no phone, no id leakage.
      expect(Object.keys(res.body).sort()).toEqual(['code', 'expiresInSeconds']);
    });

    it('the reveal wrote a truthful reveal-otp audit row that does NOT contain the code', async () => {
      const rows = await auditRows(TEST_BUSINESS);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.actionType).toBe('reveal-otp');
      expect(row.adminNameSnapshot).toBe('Reveal Root');
      expect(row.adminRoleSnapshot).toBe('superadmin');
      expect(row.targetType).toBe('Business');
      expect(row.targetId).toBe(TEST_BUSINESS);
      expect(row.targetBusinessId).toBe(TEST_BUSINESS);
      expect(row.action).toContain('QA Sandbox Store');
      expect(row.after).toMatchObject({
        outcome: 'revealed',
        phoneMasked: `${'*'.repeat(TEST_BUSINESS_PHONE.length - 4)}${TEST_BUSINESS_PHONE.slice(-4)}`,
        codeExpiresAt: expiresAt.toISOString(),
      });
      expect(JSON.stringify(row)).not.toContain(CODE);
      expect(JSON.stringify(row)).not.toContain(TEST_BUSINESS_PHONE);
    });

    it('is re-runnable: the same code comes back, the side table is untouched, audit appends', async () => {
      const again = await reveal(TEST_BUSINESS);
      expect(again.status).toBe(200);
      expect(again.body.code).toBe(CODE);

      // Reveal NEVER consumes a code: the live app owns OtpCode deletion on verify, and
      // this surface introduces no delete of its own.
      const row = await prisma.otpTestCode.findUnique({ where: { phone: TEST_BUSINESS_PHONE } });
      expect(row).not.toBeNull();
      expect(row!.codePlain).toBe(CODE);
      expect(row!.expiresAt.toISOString()).toBe(expiresAt.toISOString());

      const rows = await auditRows(TEST_BUSINESS);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => (r.after as { outcome: string }).outcome === 'revealed')).toBe(true);
    });
  });

  describe('refusals (all indistinguishable 404s)', () => {
    beforeEach(async () => {
      await prisma.adminAuditLog.deleteMany({});
    });

    it('unknown business id -> 404 NOT_FOUND, audit reason business-not-found', async () => {
      const res = await reveal(MISSING_BUSINESS);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.code).toBeUndefined();

      const rows = await auditRows(MISSING_BUSINESS);
      expect(rows).toHaveLength(1);
      expect(rows[0].after).toMatchObject({ outcome: 'refused', reason: 'business-not-found' });
      expect(rows[0].targetBusinessId).toBeNull();
    });

    it('a real (non-test) business -> 404, never a code, even for superadmin', async () => {
      const res = await reveal(REAL_BUSINESS);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.code).toBeUndefined();

      const rows = await auditRows(REAL_BUSINESS);
      expect(rows).toHaveLength(1);
      expect(rows[0].after).toMatchObject({
        outcome: 'refused',
        reason: 'business-not-test-flagged',
      });
    });

    it('a STRAY side-table row for a non-test phone stays structurally unreachable', async () => {
      await putTestCode(REAL_BUSINESS_PHONE, '999111', new Date(Date.now() + 10 * 60 * 1000));

      const res = await reveal(REAL_BUSINESS);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('999111');

      await prisma.otpTestCode.delete({ where: { phone: REAL_BUSINESS_PHONE } });
    });

    it("a real user's hashed OtpCode is never a source: only otp_test_codes is read", async () => {
      // The live flow stores codeHash only; assert the admin path cannot surface anything
      // for a phone that has a REAL outstanding OtpCode row and no side-table row.
      await prisma.otpCode.create({
        data: {
          id: uuidv7(),
          phone: REAL_BUSINESS_PHONE,
          codeHash: 'not-a-plaintext-code',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      const res = await reveal(REAL_BUSINESS);
      expect(res.status).toBe(404);
      expect(res.body.code).toBeUndefined();

      const stillHashed = await prisma.otpCode.findFirst({ where: { phone: REAL_BUSINESS_PHONE } });
      expect(stillHashed).not.toBeNull();
      await prisma.otpCode.deleteMany({ where: { phone: REAL_BUSINESS_PHONE } });
    });

    it('an EXPIRED test code reveals nothing and the expired row is left in place', async () => {
      await putTestCode(TEST_BUSINESS_PHONE, '222333', new Date(Date.now() - 1000));

      const res = await reveal(TEST_BUSINESS);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(JSON.stringify(res.body)).not.toContain('222333');

      const rows = await auditRows(TEST_BUSINESS);
      expect(rows).toHaveLength(1);
      expect(rows[0].after).toMatchObject({ outcome: 'refused', reason: 'no-active-code' });

      // Admin never purges rows the app owns; expiry is a filter, not a delete.
      expect(await prisma.otpTestCode.findUnique({ where: { phone: TEST_BUSINESS_PHONE } }))
        .not.toBeNull();
    });

    it('every refusal returns the identical envelope, so test accounts cannot be probed', async () => {
      const [missing, real, expired] = await Promise.all([
        reveal(MISSING_BUSINESS),
        reveal(REAL_BUSINESS),
        reveal(TEST_BUSINESS),
      ]);
      expect(missing.body).toEqual(real.body);
      expect(real.body).toEqual(expired.body);
      expect(missing.status).toBe(404);
    });
  });
});
