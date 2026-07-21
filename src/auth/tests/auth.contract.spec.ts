import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { CommonModule } from '../../common/common.module';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OTP_SENDER, OtpSender } from '../../common';
import { AuthModule } from '../auth.module';

/**
 * Auth (contract). Boots a real Nest app with the SAME global guards (JwtAuthGuard +
 * RolesGuard as APP_GUARD), HttpExceptionFilter and ValidationPipe as app.module.
 * OTP_SENDER is overridden with a spy stub so the test can read the issued code.
 * Asserts SHAPES (key presence + types) + status + auth/role behaviour — not snapshots.
 */

/** Spy OtpSender that records the last code issued per phone. */
class SpyOtpSender implements OtpSender {
  readonly codes = new Map<string, string>();
  async sendOtp(phone: string, code: string): Promise<void> {
    this.codes.set(phone, code);
  }
}

describe('Auth (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sender = new SpyOtpSender();

  const NEW_PHONE = '2348030000001';
  const KNOWN_PHONE = '2348030000002';

  const expectStaffShape = (u: Record<string, unknown>): void => {
    expect(typeof u.id).toBe('string');
    expect(typeof u.businessId).toBe('string');
    expect(typeof u.name).toBe('string');
    expect(typeof u.phone).toBe('string');
    expect(['owner', 'staff']).toContain(u.role);
    expect(typeof u.active).toBe('boolean');
    expect(typeof u.createdAt).toBe('string');
    expect(typeof u.version).toBe('number');
  };

  const expectBusinessShape = (b: Record<string, unknown>): void => {
    expect(typeof b.id).toBe('string');
    expect(typeof b.businessName).toBe('string');
    expect(typeof b.phone).toBe('string');
    expect(typeof b.plan).toBe('string');
    expect(typeof b.version).toBe('number');
  };

  const requestAndReadCode = async (phone: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/auth/request-otp').send({ phone });
    expect(res.status).toBe(202);
    const code = sender.codes.get(phone);
    expect(typeof code).toBe('string');
    return code as string;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, AuthModule],
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

    // Clean any prior state for the phones under test.
    for (const phone of [NEW_PHONE, KNOWN_PHONE]) {
      const staff = await prisma.staff.findFirst({ where: { phone } });
      if (staff) {
        await prisma.refreshToken.deleteMany({ where: { userId: staff.id } });
        await prisma.staff.deleteMany({ where: { businessId: staff.businessId } });
        await prisma.business.deleteMany({ where: { id: staff.businessId } });
      }
      await prisma.otpCode.deleteMany({ where: { phone } });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  describe('request-otp (no enumeration)', () => {
    it('returns identical 202 {} for unknown and known phones', async () => {
      const unknown = await request(app.getHttpServer())
        .post('/auth/request-otp')
        .send({ phone: NEW_PHONE });
      expect(unknown.status).toBe(202);
      expect(unknown.body).toEqual({});

      const known = await request(app.getHttpServer())
        .post('/auth/request-otp')
        .send({ phone: KNOWN_PHONE });
      expect(known.status).toBe(202);
      expect(known.body).toEqual({});
    });

    it('stores the OTP hashed (never plaintext) at rest', async () => {
      const code = await requestAndReadCode(NEW_PHONE);
      const row = await prisma.otpCode.findFirst({
        where: { phone: NEW_PHONE },
        orderBy: { createdAt: 'desc' },
      });
      expect(row).not.toBeNull();
      expect(row!.codeHash).not.toBe(code);
      expect(row!.attempts).toBe(0);
    });
  });

  describe('verify-otp', () => {
    it('wrong code -> 401 UNAUTHENTICATED', async () => {
      await requestAndReadCode(NEW_PHONE);
      const res = await request(app.getHttpServer())
        .post('/auth/verify-otp')
        .send({ phone: NEW_PHONE, code: '000000' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('expired code -> 401 UNAUTHENTICATED', async () => {
      await requestAndReadCode(NEW_PHONE);
      await prisma.otpCode.updateMany({
        where: { phone: NEW_PHONE },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const code = sender.codes.get(NEW_PHONE)!;
      const res = await request(app.getHttpServer())
        .post('/auth/verify-otp')
        .send({ phone: NEW_PHONE, code });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('over 5 attempts -> 429 RATE_LIMITED', async () => {
      await requestAndReadCode(NEW_PHONE);
      await prisma.otpCode.updateMany({ where: { phone: NEW_PHONE }, data: { attempts: 5 } });
      const code = sender.codes.get(NEW_PHONE)!;
      const res = await request(app.getHttpServer())
        .post('/auth/verify-otp')
        .send({ phone: NEW_PHONE, code });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    });

    it('correct code on a NEW phone -> 200 session + creates Business + owner Staff', async () => {
      const code = await requestAndReadCode(NEW_PHONE);
      const res = await request(app.getHttpServer())
        .post('/auth/verify-otp')
        .send({ phone: NEW_PHONE, code });

      expect(res.status).toBe(200);
      expect(typeof res.body.accessToken).toBe('string');
      expect(typeof res.body.refreshToken).toBe('string');
      expectStaffShape(res.body.user);
      expectBusinessShape(res.body.business);
      expect(res.body.user.role).toBe('owner');
      expect(res.body.user.phone).toBe(NEW_PHONE);

      // A Business + owner Staff were persisted and linked.
      const staff = await prisma.staff.findFirst({ where: { phone: NEW_PHONE } });
      expect(staff).not.toBeNull();
      expect(staff!.role).toBe('owner');
      expect(staff!.active).toBe(true);
      const business = await prisma.business.findUnique({ where: { id: staff!.businessId } });
      expect(business).not.toBeNull();

      // OTP codes consumed on success.
      const remaining = await prisma.otpCode.count({ where: { phone: NEW_PHONE } });
      expect(remaining).toBe(0);
    });

    it('correct code on a KNOWN phone -> 200 returns the existing user + business', async () => {
      // Bootstrap the known account via a first verify.
      const first = await requestAndReadCode(KNOWN_PHONE);
      const boot = await request(app.getHttpServer())
        .post('/auth/verify-otp')
        .send({ phone: KNOWN_PHONE, code: first });
      expect(boot.status).toBe(200);
      const businessId = boot.body.user.businessId;

      // Second login on the same phone reuses the same tenant.
      const again = await requestAndReadCode(KNOWN_PHONE);
      const res = await request(app.getHttpServer())
        .post('/auth/verify-otp')
        .send({ phone: KNOWN_PHONE, code: again });
      expect(res.status).toBe(200);
      expect(res.body.user.businessId).toBe(businessId);
      expect(res.body.business.id).toBe(businessId);
    });
  });

  describe('refresh (rotation + reuse detection)', () => {
    it('valid token -> 200 new pair; reusing the revoked token -> 401', async () => {
      const code = await requestAndReadCode(NEW_PHONE);
      const session = await request(app.getHttpServer())
        .post('/auth/verify-otp')
        .send({ phone: NEW_PHONE, code });
      expect(session.status).toBe(200);
      const oldRefresh = session.body.refreshToken as string;

      const rotated = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: oldRefresh });
      expect(rotated.status).toBe(200);
      expect(typeof rotated.body.accessToken).toBe('string');
      expect(typeof rotated.body.refreshToken).toBe('string');
      expect(rotated.body.refreshToken).not.toBe(oldRefresh);

      // Reuse of the now-revoked token -> 401.
      const reuse = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: oldRefresh });
      expect(reuse.status).toBe(401);
      expect(reuse.body.error.code).toBe('UNAUTHENTICATED');

      // Reuse detection revoked the chain: the rotated token is now dead too.
      const chainDead = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: rotated.body.refreshToken });
      expect(chainDead.status).toBe(401);
    });

    it('garbage token -> 401', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: 'not-a-jwt' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /me + logout', () => {
    it('bearer access token -> 200 { user, business }; no token -> 401; logout kills the refresh', async () => {
      const code = await requestAndReadCode(NEW_PHONE);
      const session = await request(app.getHttpServer())
        .post('/auth/verify-otp')
        .send({ phone: NEW_PHONE, code });
      expect(session.status).toBe(200);
      const access = session.body.accessToken as string;
      const refresh = session.body.refreshToken as string;

      const me = await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', `Bearer ${access}`);
      expect(me.status).toBe(200);
      expectStaffShape(me.body.user);
      expectBusinessShape(me.body.business);

      const noAuth = await request(app.getHttpServer()).get('/me');
      expect(noAuth.status).toBe(401);
      expect(noAuth.body.error.code).toBe('UNAUTHENTICATED');

      const logout = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${access}`);
      expect(logout.status).toBe(204);

      // Refresh is dead after logout.
      const dead = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: refresh });
      expect(dead.status).toBe(401);
    });
  });

  // Admin-surface instrumentation: otp_request_log, otp_test_codes, RefreshToken.revokedReason.
  describe('admin instrumentation (best-effort, never alters the auth contract)', () => {
    const TEST_PHONE = '2348030000003';
    const REAL_PHONE = '2348030000004';
    const TEST_BIZ = '01912aaa-0000-7000-8000-authinstr001';
    const REAL_BIZ = '01912aaa-0000-7000-8000-authinstr002';

    const seedBusiness = async (id: string, phone: string, isTest: boolean): Promise<void> => {
      await prisma.business.upsert({
        where: { id },
        create: {
          id,
          businessName: 'Instr Traders',
          ownerName: 'Owner',
          phone,
          category: 'Retail',
          currency: 'NGN (₦)',
          reminderTone: 'gentle',
          plan: 'starter',
          isTest,
        },
        update: { phone, isTest },
      });
      await prisma.staff.upsert({
        where: { id: `${id}-staff` },
        create: {
          id: `${id}-staff`,
          businessId: id,
          name: 'Owner',
          phone,
          role: 'owner',
          active: true,
        },
        update: {},
      });
    };

    beforeAll(async () => {
      await seedBusiness(TEST_BIZ, TEST_PHONE, true);
      await seedBusiness(REAL_BIZ, REAL_PHONE, false);
    });

    beforeEach(async () => {
      await prisma.otpRequestLog.deleteMany({});
      await prisma.otpTestCode.deleteMany({});
    });

    it('request-otp logs a MASKED-phone otp_request_log row and mirrors the code for TEST businesses only', async () => {
      const testCode = await requestAndReadCode(TEST_PHONE);

      const log = await prisma.otpRequestLog.findFirst({
        where: { businessId: TEST_BIZ },
        orderBy: { createdAt: 'desc' },
      });
      expect(log).not.toBeNull();
      expect(log!.outcome).toBe('requested');
      expect(log!.attempts).toBe(0);
      // Masked: last 4 digits only, and the full number is NEVER stored.
      expect(log!.phoneMasked).toBe(`${'*'.repeat(TEST_PHONE.length - 4)}${TEST_PHONE.slice(-4)}`);
      expect(log!.phoneMasked).not.toBe(TEST_PHONE);
      expect(JSON.stringify(log)).not.toContain(testCode);

      // Test-flagged business -> the plaintext mirror exists (this is what the admin reveal reads).
      const mirror = await prisma.otpTestCode.findUnique({ where: { phone: TEST_PHONE } });
      expect(mirror).not.toBeNull();
      expect(mirror!.codePlain).toBe(testCode);

      // Real business -> logged, but NEVER mirrored in plaintext.
      await requestAndReadCode(REAL_PHONE);
      const realLog = await prisma.otpRequestLog.findFirst({ where: { businessId: REAL_BIZ } });
      expect(realLog).not.toBeNull();
      expect(await prisma.otpTestCode.findUnique({ where: { phone: REAL_PHONE } })).toBeNull();
    });

    it('verify-otp logs failed then verified outcomes and consumes the test-code mirror', async () => {
      const code = await requestAndReadCode(TEST_PHONE);

      const wrong = await request(app.getHttpServer())
        .post('/auth/verify-otp')
        .send({ phone: TEST_PHONE, code: code === '000000' ? '111111' : '000000' });
      expect(wrong.status).toBe(401);
      const failed = await prisma.otpRequestLog.findFirst({
        where: { outcome: 'failed' },
        orderBy: { createdAt: 'desc' },
      });
      expect(failed).not.toBeNull();
      expect(failed!.attempts).toBe(1);

      const ok = await request(app.getHttpServer())
        .post('/auth/verify-otp')
        .send({ phone: TEST_PHONE, code });
      expect(ok.status).toBe(200);
      const verified = await prisma.otpRequestLog.findFirst({
        where: { outcome: 'verified' },
        orderBy: { createdAt: 'desc' },
      });
      expect(verified).not.toBeNull();
      expect(verified!.businessId).toBe(TEST_BIZ);
      // The mirror is consumed alongside the OTP itself.
      expect(await prisma.otpTestCode.findUnique({ where: { phone: TEST_PHONE } })).toBeNull();
    });

    it('stamps RefreshToken.revokedReason on rotation and logout', async () => {
      const code = await requestAndReadCode(REAL_PHONE);
      const session = await request(app.getHttpServer())
        .post('/auth/verify-otp')
        .send({ phone: REAL_PHONE, code });
      expect(session.status).toBe(200);

      const rotated = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: session.body.refreshToken as string });
      expect(rotated.status).toBe(200);
      const userId = `${REAL_BIZ}-staff`;
      expect(
        await prisma.refreshToken.count({ where: { userId, revokedReason: 'rotation' } }),
      ).toBe(1);

      const logout = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${rotated.body.accessToken as string}`);
      expect(logout.status).toBe(204);
      expect(await prisma.refreshToken.count({ where: { userId, revokedReason: 'logout' } })).toBe(
        1,
      );
    });
  });
});
