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

// Admin secrets are env-driven with no insecure fallback; specs boot with explicit
// test values, mirroring how test/setenv.ts boots the user-auth specs.
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'test-admin-access-secret';
process.env.ADMIN_JWT_REFRESH_SECRET =
  process.env.ADMIN_JWT_REFRESH_SECRET ?? 'test-admin-refresh-secret';

/**
 * AdminUserManagement (contract). Same boot as app.module (global user guards,
 * ValidationPipe, HttpExceptionFilter) + the AdminModule aggregate. Covers the
 * superadmin-only gate (support blocked), create-with-temp-password, disable/enable
 * with session revocation, self-disable refusal, revoke-invite delete rules and the
 * audit trail every write leaves behind.
 */
describe('AdminUserManagement (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const ROOT_EMAIL = 'root-mgmt@oweme.app';
  const ROOT_PASSWORD = 'RootPass!2026';
  const SUPPORT_EMAIL = 'support-mgmt@oweme.app';
  const SUPPORT_PASSWORD = 'SupportPass!1';
  let rootAccess: string;
  let supportAccess: string;

  const expectUserViewShape = (a: Record<string, unknown>): void => {
    expect(typeof a.id).toBe('string');
    expect(typeof a.name).toBe('string');
    expect(typeof a.email).toBe('string');
    expect(['superadmin', 'support']).toContain(a.role);
    expect(['active', 'disabled']).toContain(a.status);
    expect(typeof a.pendingFirstLogin).toBe('boolean');
    expect(a.lastActiveAt === null || typeof a.lastActiveAt === 'string').toBe(true);
  };

  const login = async (email: string, password: string) =>
    request(app.getHttpServer()).post('/admin/auth/login').send({ email, password });

  const createAdmin = async (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/admin/admin-users')
      .set('Authorization', `Bearer ${rootAccess}`)
      .send(body);

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
    await app.init();

    await prisma.adminAuditLog.deleteMany({});
    await prisma.adminRefreshToken.deleteMany({});
    await prisma.adminUser.deleteMany({});
    for (const [email, name, role, password] of [
      [ROOT_EMAIL, 'Mgmt Root', 'superadmin', ROOT_PASSWORD],
      [SUPPORT_EMAIL, 'Mgmt Support', 'support', SUPPORT_PASSWORD],
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

  describe('role gate (superadmin only)', () => {
    it('support is 403 FORBIDDEN on every admin-users route; no token is 401', async () => {
      const list = await request(app.getHttpServer())
        .get('/admin/admin-users')
        .set('Authorization', `Bearer ${supportAccess}`);
      expect(list.status).toBe(403);
      expect(list.body.error.code).toBe('FORBIDDEN');

      const create = await request(app.getHttpServer())
        .post('/admin/admin-users')
        .set('Authorization', `Bearer ${supportAccess}`)
        .send({ email: 'x@oweme.app', name: 'X', role: 'support' });
      expect(create.status).toBe(403);

      const noAuth = await request(app.getHttpServer()).get('/admin/admin-users');
      expect(noAuth.status).toBe(401);
      expect(noAuth.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('GET /admin/admin-users', () => {
    it('superadmin -> 200 AdminUserView[] (no passwordHash leakage)', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/admin-users')
        .set('Authorization', `Bearer ${rootAccess}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
      for (const row of res.body) {
        expectUserViewShape(row);
        expect(row.passwordHash).toBeUndefined();
      }
    });
  });

  describe('POST /admin/admin-users (create with temp password)', () => {
    it('201 { admin, tempPassword }; temp password logs in locked to the change-password pair', async () => {
      const res = await createAdmin({
        email: 'new-admin@oweme.app',
        name: 'New Admin',
        role: 'superadmin',
      });
      expect(res.status).toBe(201);
      expectUserViewShape(res.body.admin);
      expect(res.body.admin.pendingFirstLogin).toBe(true); // the screen's 'invited' state
      expect(typeof res.body.tempPassword).toBe('string');
      expect(res.body.tempPassword.length).toBeGreaterThanOrEqual(8);

      // Temp password is real and hashed at rest, never stored in clear.
      const row = await prisma.adminUser.findUnique({ where: { email: 'new-admin@oweme.app' } });
      expect(row!.mustChangePassword).toBe(true);
      expect(row!.passwordHash).not.toContain(res.body.tempPassword);

      // The new admin can log in but is locked out of everything except the exempt pair.
      const session = await login('new-admin@oweme.app', res.body.tempPassword);
      expect(session.status).toBe(200);
      const blocked = await request(app.getHttpServer())
        .get('/admin/admin-users')
        .set('Authorization', `Bearer ${session.body.accessToken}`);
      expect(blocked.status).toBe(403);

      // After changing the password the (superadmin) account is fully usable.
      const change = await request(app.getHttpServer())
        .post('/admin/auth/change-password')
        .set('Authorization', `Bearer ${session.body.accessToken}`)
        .send({ currentPassword: res.body.tempPassword, newPassword: 'ChangedPass!9' });
      expect(change.status).toBe(200);
      const unblocked = await request(app.getHttpServer())
        .get('/admin/admin-users')
        .set('Authorization', `Bearer ${session.body.accessToken}`);
      expect(unblocked.status).toBe(200);
      const self = (unblocked.body as Record<string, unknown>[]).find(
        (a) => a.email === 'new-admin@oweme.app',
      );
      expect(self!.pendingFirstLogin).toBe(false);
    });

    it('duplicate email -> 422; unknown role -> 422', async () => {
      const dup = await createAdmin({ email: ROOT_EMAIL, name: 'Dup', role: 'support' });
      expect(dup.status).toBe(422);
      expect(dup.body.error.code).toBe('VALIDATION_ERROR');

      const badRole = await createAdmin({ email: 'r@oweme.app', name: 'R', role: 'owner' });
      expect(badRole.status).toBe(422);
    });
  });

  describe('disable / enable', () => {
    const TARGET_EMAIL = 'target@oweme.app';
    let targetId: string;
    let targetPassword: string;

    beforeAll(async () => {
      const created = await createAdmin({
        email: TARGET_EMAIL,
        name: 'Target Admin',
        role: 'support',
      });
      expect(created.status).toBe(201);
      targetId = created.body.admin.id as string;
      targetPassword = created.body.tempPassword as string;
    });

    it('disable -> status disabled, live sessions revoked immediately; unknown id -> 404', async () => {
      const session = await login(TARGET_EMAIL, targetPassword);
      expect(session.status).toBe(200);

      const res = await request(app.getHttpServer())
        .post(`/admin/admin-users/${targetId}/disable`)
        .set('Authorization', `Bearer ${rootAccess}`);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('disabled');

      // Existing access token dies immediately (guard re-reads the row) and the
      // refresh chain is revoked; a fresh login is rejected like bad credentials.
      const access = await request(app.getHttpServer())
        .get('/admin/auth/me')
        .set('Authorization', `Bearer ${session.body.accessToken}`);
      expect(access.status).toBe(401);
      const refresh = await request(app.getHttpServer())
        .post('/admin/auth/refresh')
        .send({ refreshToken: session.body.refreshToken });
      expect(refresh.status).toBe(401);
      expect((await login(TARGET_EMAIL, targetPassword)).status).toBe(401);

      const missing = await request(app.getHttpServer())
        .post(`/admin/admin-users/${uuidv7()}/disable`)
        .set('Authorization', `Bearer ${rootAccess}`);
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('NOT_FOUND');
    });

    it('self-disable is refused server-side -> 422', async () => {
      const root = await prisma.adminUser.findUnique({ where: { email: ROOT_EMAIL } });
      const res = await request(app.getHttpServer())
        .post(`/admin/admin-users/${root!.id}/disable`)
        .set('Authorization', `Bearer ${rootAccess}`);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      const after = await prisma.adminUser.findUnique({ where: { email: ROOT_EMAIL } });
      expect(after!.status).toBe('active');
    });

    it('enable -> active again and login works', async () => {
      const res = await request(app.getHttpServer())
        .post(`/admin/admin-users/${targetId}/enable`)
        .set('Authorization', `Bearer ${rootAccess}`);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      expect((await login(TARGET_EMAIL, targetPassword)).status).toBe(200);
    });
  });

  describe('DELETE /admin/admin-users/:id (revoke-invite analog)', () => {
    it('never-activated admin -> { ok: true } and the row is gone', async () => {
      const created = await createAdmin({
        email: 'never-logged-in@oweme.app',
        name: 'Never Logged In',
        role: 'support',
      });
      const id = created.body.admin.id as string;

      const res = await request(app.getHttpServer())
        .delete(`/admin/admin-users/${id}`)
        .set('Authorization', `Bearer ${rootAccess}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(await prisma.adminUser.findUnique({ where: { id } })).toBeNull();
    });

    it('activated admin (has logged in) -> 422, disable instead', async () => {
      const root = await prisma.adminUser.findUnique({ where: { email: ROOT_EMAIL } });
      const res = await request(app.getHttpServer())
        .delete(`/admin/admin-users/${root!.id}`)
        .set('Authorization', `Bearer ${rootAccess}`);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('unknown id -> 404', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/admin/admin-users/${uuidv7()}`)
        .set('Authorization', `Bearer ${rootAccess}`);
      expect(res.status).toBe(404);
    });
  });

  describe('audit trail', () => {
    it('every management write left an admin_audit_log row with the registry actionType', async () => {
      const root = await prisma.adminUser.findUnique({ where: { email: ROOT_EMAIL } });
      for (const actionType of ['create-admin', 'disable-admin', 'enable-admin', 'revoke-admin']) {
        const row = await prisma.adminAuditLog.findFirst({
          where: { adminUserId: root!.id, actionType },
        });
        expect(row).not.toBeNull();
        expect(row!.adminRoleSnapshot).toBe('superadmin');
        expect(row!.targetType).toBe('AdminUser');
        expect(typeof row!.action).toBe('string');
      }
    });
  });
});
