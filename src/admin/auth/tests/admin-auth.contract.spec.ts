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
import { seedFirstAdmin } from '../seed-admin.command';

// Admin secrets are env-driven with no insecure fallback; specs boot with explicit
// test values, mirroring how test/setenv.ts boots the user-auth specs.
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'test-admin-access-secret';
process.env.ADMIN_JWT_REFRESH_SECRET =
  process.env.ADMIN_JWT_REFRESH_SECRET ?? 'test-admin-refresh-secret';

/**
 * AdminAuth (contract). Boots a real Nest app with the SAME global guards
 * (JwtAuthGuard + RolesGuard as APP_GUARD), HttpExceptionFilter and ValidationPipe
 * as app.module, plus the whole AdminModule AND the user AuthModule so
 * cross-rejection is proven against the real user surface in both directions.
 */

/** Spy OtpSender so the spec can mint a REAL user session for cross-rejection. */
class SpyOtpSender implements OtpSender {
  readonly codes = new Map<string, string>();
  async sendOtp(phone: string, code: string): Promise<void> {
    this.codes.set(phone, code);
  }
}

describe('AdminAuth (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sender = new SpyOtpSender();

  const SEED_EMAIL = 'root@oweme.app';
  const SEED_PASSWORD = 'RootPass!2026';
  const SEED_NAME = 'Root Admin';
  const USER_PHONE = '2348039990001';

  const expectSelfViewShape = (a: Record<string, unknown>): void => {
    expect(typeof a.id).toBe('string');
    expect(typeof a.name).toBe('string');
    expect(typeof a.email).toBe('string');
    expect(['superadmin', 'support']).toContain(a.role);
    expect(a.org).toBe('OweMe');
    expect(typeof a.mustChangePassword).toBe('boolean');
  };

  const login = async (email: string, password: string) =>
    request(app.getHttpServer()).post('/admin/auth/login').send({ email, password });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, AdminModule, AuthModule],
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

    // Clean admin state, then seed the first superadmin through the real seed command.
    await prisma.adminAuditLog.deleteMany({});
    await prisma.adminRefreshToken.deleteMany({});
    await prisma.adminUser.deleteMany({});
    process.env.ADMIN_SEED_EMAIL = SEED_EMAIL;
    process.env.ADMIN_SEED_PASSWORD = SEED_PASSWORD;
    process.env.ADMIN_SEED_NAME = SEED_NAME;
    const seeded = await seedFirstAdmin(prisma);
    expect(seeded.role).toBe('superadmin');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('seed command', () => {
    it('refuses when any AdminUser already exists', async () => {
      await expect(seedFirstAdmin(prisma)).rejects.toThrow(/Refusing to seed/);
      expect(await prisma.adminUser.count()).toBe(1);
    });
  });

  describe('POST /admin/auth/login', () => {
    it('bad email format -> 422 VALIDATION_ERROR', async () => {
      const res = await login('not-an-email', SEED_PASSWORD);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('unknown email, wrong password and disabled account -> identical 401', async () => {
      const unknown = await login('nobody@oweme.app', SEED_PASSWORD);
      expect(unknown.status).toBe(401);
      expect(unknown.body.error.code).toBe('UNAUTHENTICATED');

      const wrong = await login(SEED_EMAIL, 'wrong-password');
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).toBe('UNAUTHENTICATED');

      await prisma.adminUser.create({
        data: {
          id: uuidv7(),
          email: 'disabled@oweme.app',
          name: 'Disabled Admin',
          passwordHash: hashPassword('DisabledPass1'),
          role: 'support',
          status: 'disabled',
          mustChangePassword: false,
        },
      });
      const disabled = await login('disabled@oweme.app', 'DisabledPass1');
      expect(disabled.status).toBe(401);
      expect(disabled.body).toEqual(wrong.body); // indistinguishable, no enumeration
    });

    it('valid credentials -> 200 AdminSessionView, stamps lastLoginAt, audit-logs login', async () => {
      const res = await login(SEED_EMAIL, SEED_PASSWORD);
      expect(res.status).toBe(200);
      expect(typeof res.body.accessToken).toBe('string');
      expect(typeof res.body.refreshToken).toBe('string');
      expectSelfViewShape(res.body.admin);
      expect(res.body.admin.email).toBe(SEED_EMAIL);
      expect(res.body.admin.role).toBe('superadmin');
      expect(res.body.admin.mustChangePassword).toBe(false);

      const row = await prisma.adminUser.findUnique({ where: { email: SEED_EMAIL } });
      expect(row!.lastLoginAt).not.toBeNull();
      expect(row!.lastActiveAt).not.toBeNull();

      const audit = await prisma.adminAuditLog.findFirst({
        where: { adminUserId: row!.id, actionType: 'login' },
      });
      expect(audit).not.toBeNull();
      expect(audit!.adminNameSnapshot).toBe(SEED_NAME);
    });
  });

  describe('GET /admin/auth/me', () => {
    it('bearer admin token -> 200 AdminSelfView; missing/garbage token -> 401', async () => {
      const session = await login(SEED_EMAIL, SEED_PASSWORD);
      const me = await request(app.getHttpServer())
        .get('/admin/auth/me')
        .set('Authorization', `Bearer ${session.body.accessToken}`);
      expect(me.status).toBe(200);
      expectSelfViewShape(me.body);
      expect(me.body.org).toBe('OweMe');

      const noAuth = await request(app.getHttpServer()).get('/admin/auth/me');
      expect(noAuth.status).toBe(401);
      expect(noAuth.body.error.code).toBe('UNAUTHENTICATED');

      const garbage = await request(app.getHttpServer())
        .get('/admin/auth/me')
        .set('Authorization', 'Bearer not-a-jwt');
      expect(garbage.status).toBe(401);
    });
  });

  describe('POST /admin/auth/refresh (rotation + reuse detection)', () => {
    it('valid token -> 200 new AdminSessionView; reuse revokes the whole chain', async () => {
      const session = await login(SEED_EMAIL, SEED_PASSWORD);
      const oldRefresh = session.body.refreshToken as string;

      const rotated = await request(app.getHttpServer())
        .post('/admin/auth/refresh')
        .send({ refreshToken: oldRefresh });
      expect(rotated.status).toBe(200);
      expect(typeof rotated.body.accessToken).toBe('string');
      expect(typeof rotated.body.refreshToken).toBe('string');
      expect(rotated.body.refreshToken).not.toBe(oldRefresh);
      expectSelfViewShape(rotated.body.admin);

      const reuse = await request(app.getHttpServer())
        .post('/admin/auth/refresh')
        .send({ refreshToken: oldRefresh });
      expect(reuse.status).toBe(401);
      expect(reuse.body.error.code).toBe('UNAUTHENTICATED');

      // Reuse detection revoked the chain: the rotated token is dead too.
      const chainDead = await request(app.getHttpServer())
        .post('/admin/auth/refresh')
        .send({ refreshToken: rotated.body.refreshToken });
      expect(chainDead.status).toBe(401);
    });

    it('garbage token -> 401', async () => {
      const res = await request(app.getHttpServer())
        .post('/admin/auth/refresh')
        .send({ refreshToken: 'not-a-jwt' });
      expect(res.status).toBe(401);
    });
  });

  describe('cross-rejection (admin and user identities never interchange)', () => {
    it('a valid ADMIN access token fails the user JwtAuthGuard on a user route', async () => {
      const session = await login(SEED_EMAIL, SEED_PASSWORD);
      const res = await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', `Bearer ${session.body.accessToken}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('a valid USER access token fails AdminJwtGuard on an admin route', async () => {
      // Mint a REAL user session via the live OTP flow.
      const otpReq = await request(app.getHttpServer())
        .post('/auth/request-otp')
        .send({ phone: USER_PHONE });
      expect(otpReq.status).toBe(202);
      const code = sender.codes.get(USER_PHONE)!;
      const userSession = await request(app.getHttpServer())
        .post('/auth/verify-otp')
        .send({ phone: USER_PHONE, code });
      expect(userSession.status).toBe(200);

      // The user token passes ITS OWN guard...
      const userMe = await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', `Bearer ${userSession.body.accessToken}`);
      expect(userMe.status).toBe(200);

      // ...but is rejected on the admin surface.
      const res = await request(app.getHttpServer())
        .get('/admin/auth/me')
        .set('Authorization', `Bearer ${userSession.body.accessToken}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');

      // The USER refresh token is equally dead on the admin refresh endpoint.
      const refresh = await request(app.getHttpServer())
        .post('/admin/auth/refresh')
        .send({ refreshToken: userSession.body.refreshToken });
      expect(refresh.status).toBe(401);
    });
  });

  describe('POST /admin/auth/change-password + mustChangePassword lockout', () => {
    const PENDING_EMAIL = 'pending@oweme.app';
    const TEMP_PASSWORD = 'TempPass!234';
    const NEW_PASSWORD = 'FreshPass!567';

    beforeAll(async () => {
      await prisma.adminUser.create({
        data: {
          id: uuidv7(),
          email: PENDING_EMAIL,
          name: 'Pending Admin',
          passwordHash: hashPassword(TEMP_PASSWORD),
          role: 'superadmin',
          status: 'active',
          mustChangePassword: true,
        },
      });
    });

    it('a pending admin reaches ONLY auth/me + change-password; everything else is 403', async () => {
      const session = await login(PENDING_EMAIL, TEMP_PASSWORD);
      expect(session.status).toBe(200); // session IS issued
      expect(session.body.admin.mustChangePassword).toBe(true);
      const access = session.body.accessToken as string;

      // Any other admin endpoint (superadmin role notwithstanding) -> 403 FORBIDDEN.
      const blocked = await request(app.getHttpServer())
        .get('/admin/admin-users')
        .set('Authorization', `Bearer ${access}`);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('FORBIDDEN');

      // The exempt pair still works.
      const me = await request(app.getHttpServer())
        .get('/admin/auth/me')
        .set('Authorization', `Bearer ${access}`);
      expect(me.status).toBe(200);
      expect(me.body.mustChangePassword).toBe(true);
    });

    it('wrong current password -> 401; short new password -> 422', async () => {
      const session = await login(PENDING_EMAIL, TEMP_PASSWORD);
      const access = session.body.accessToken as string;

      const wrong = await request(app.getHttpServer())
        .post('/admin/auth/change-password')
        .set('Authorization', `Bearer ${access}`)
        .send({ currentPassword: 'not-the-password', newPassword: NEW_PASSWORD });
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).toBe('UNAUTHENTICATED');

      const short = await request(app.getHttpServer())
        .post('/admin/auth/change-password')
        .set('Authorization', `Bearer ${access}`)
        .send({ currentPassword: TEMP_PASSWORD, newPassword: 'short' });
      expect(short.status).toBe(422);
      expect(short.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('change-password clears the lockout, revokes other sessions, audit-logs', async () => {
      const older = await login(PENDING_EMAIL, TEMP_PASSWORD); // a second live session
      const session = await login(PENDING_EMAIL, TEMP_PASSWORD);
      const access = session.body.accessToken as string;

      const res = await request(app.getHttpServer())
        .post('/admin/auth/change-password')
        .set('Authorization', `Bearer ${access}`)
        .send({ currentPassword: TEMP_PASSWORD, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      // Lockout cleared: the previously-blocked route now serves this superadmin.
      const unblocked = await request(app.getHttpServer())
        .get('/admin/admin-users')
        .set('Authorization', `Bearer ${access}`);
      expect(unblocked.status).toBe(200);

      // The caller's own session leg survived change-password (checked FIRST: presenting
      // the revoked token below triggers reuse detection, which nukes the whole chain).
      const ownAlive = await request(app.getHttpServer())
        .post('/admin/auth/refresh')
        .send({ refreshToken: session.body.refreshToken });
      expect(ownAlive.status).toBe(200);
      // The OTHER session's refresh chain was revoked by change-password.
      const otherDead = await request(app.getHttpServer())
        .post('/admin/auth/refresh')
        .send({ refreshToken: older.body.refreshToken });
      expect(otherDead.status).toBe(401);

      // Old password is dead, new one works, mustChangePassword stays cleared.
      expect((await login(PENDING_EMAIL, TEMP_PASSWORD)).status).toBe(401);
      const relogin = await login(PENDING_EMAIL, NEW_PASSWORD);
      expect(relogin.status).toBe(200);
      expect(relogin.body.admin.mustChangePassword).toBe(false);

      const row = await prisma.adminUser.findUnique({ where: { email: PENDING_EMAIL } });
      const audit = await prisma.adminAuditLog.findFirst({
        where: { adminUserId: row!.id, actionType: 'change-password' },
      });
      expect(audit).not.toBeNull();
    });
  });
});
