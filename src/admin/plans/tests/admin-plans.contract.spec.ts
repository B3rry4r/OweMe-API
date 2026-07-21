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
import { AdminPlansModule } from '../admin-plans.module';

// Admin secrets are env-driven with no insecure fallback; specs boot with explicit
// test values, mirroring how test/setenv.ts boots the user-auth specs.
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'test-admin-access-secret';
process.env.ADMIN_JWT_REFRESH_SECRET =
  process.env.ADMIN_JWT_REFRESH_SECRET ?? 'test-admin-refresh-secret';

/** Spy OtpSender so the spec can mint a REAL user session for the cross-rejection gate. */
class SpyOtpSender implements OtpSender {
  readonly codes = new Map<string, string>();
  async sendOtp(phone: string, code: string): Promise<void> {
    this.codes.set(phone, code);
  }
}

/**
 * AdminPlansView (contract). Same boot as app.module (global user guards,
 * ValidationPipe, HttpExceptionFilter) plus the AdminModule aggregate (for admin
 * login), the user AuthModule (for a real user token) and this resource's module,
 * which the integrator later folds into AdminModule. Covers the seeded catalog
 * shape in fixed ladder order, the fair-use and ceiling mappings, both role gates
 * and the empty-catalog read.
 */
describe('AdminPlansView (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sender = new SpyOtpSender();

  const ROOT_EMAIL = 'root-plans@oweme.app';
  const ROOT_PASSWORD = 'RootPass!2026';
  const SUPPORT_EMAIL = 'support-plans@oweme.app';
  const SUPPORT_PASSWORD = 'SupportPass!1';
  const USER_PHONE = '2348039990077';
  let rootAccess: string;
  let supportAccess: string;

  const login = async (email: string, password: string) =>
    request(app.getHttpServer()).post('/admin/auth/login').send({ email, password });

  const list = async (token: string = rootAccess) =>
    request(app.getHttpServer()).get('/admin/plans').set('Authorization', `Bearer ${token}`);

  const expectPlanShape = (p: Record<string, unknown>): void => {
    expect(Object.keys(p).sort()).toEqual([
      'ceilingKobo',
      'creditsPerMonth',
      'label',
      'monthlyKobo',
      'planId',
      'planOrder',
      'staffSeats',
    ]);
    expect(typeof p.planId).toBe('string');
    expect(typeof p.label).toBe('string');
    expect(typeof p.monthlyKobo).toBe('number');
    expect(p.ceilingKobo === null || typeof p.ceilingKobo === 'number').toBe(true);
    expect(p.creditsPerMonth === null || typeof p.creditsPerMonth === 'number').toBe(true);
    expect(typeof p.staffSeats).toBe('number');
    expect(typeof p.planOrder).toBe('number');
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, AdminModule, AdminPlansModule, AuthModule],
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

    await prisma.adminAuditLog.deleteMany({});
    await prisma.adminRefreshToken.deleteMany({});
    await prisma.adminUser.deleteMany({});
    for (const [email, name, role, password] of [
      [ROOT_EMAIL, 'Plans Root', 'superadmin', ROOT_PASSWORD],
      [SUPPORT_EMAIL, 'Plans Support', 'support', SUPPORT_PASSWORD],
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

  describe('GET /admin/plans (seeded catalog)', () => {
    it('returns the five canonical tiers in fixed ladder order', async () => {
      const res = await list();
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(5);
      for (const plan of res.body) expectPlanShape(plan);

      expect(res.body.map((p: Record<string, unknown>) => p.planId)).toEqual([
        'starter',
        'market',
        'business',
        'wholesale',
        'enterprise',
      ]);
      expect(res.body.map((p: Record<string, unknown>) => p.planOrder)).toEqual([0, 1, 2, 3, 4]);
    });

    it('projects the seeded columns onto the admin field names', async () => {
      const res = await list();
      const byId = new Map<string, Record<string, unknown>>(
        res.body.map((p: Record<string, unknown>) => [p.planId as string, p]),
      );

      expect(byId.get('starter')).toEqual({
        planId: 'starter',
        label: 'Starter',
        monthlyKobo: 0,
        ceilingKobo: 30_000_000,
        creditsPerMonth: 50,
        staffSeats: 0,
        planOrder: 0,
      });
      expect(byId.get('market')!.monthlyKobo).toBe(250_000);
      expect(byId.get('market')!.creditsPerMonth).toBe(300);
      expect(byId.get('market')!.staffSeats).toBe(1);
      expect(byId.get('business')!.ceilingKobo).toBe(600_000_000);
      expect(byId.get('wholesale')!.creditsPerMonth).toBe(3_000);
      // BigInt ceilings beyond 32-bit survive the wire as plain numbers.
      expect(byId.get('enterprise')!.ceilingKobo).toBe(4_000_000_000);
    });

    it('maps the -1 fair-use sentinel to null credits (enterprise)', async () => {
      const res = await list();
      const enterprise = res.body.find((p: Record<string, unknown>) => p.planId === 'enterprise');
      expect(enterprise.creditsPerMonth).toBeNull();
      expect(enterprise.monthlyKobo).toBe(2_500_000);
      // staffSeats keeps its stored -1 (unlimited) - only the credits contract is nullable.
      expect(enterprise.staffSeats).toBe(-1);
    });

    it('is a read-only surface: no write route and no audit rows', async () => {
      const attempts: ['post' | 'put' | 'patch' | 'delete', string][] = [
        ['post', '/admin/plans'],
        ['put', '/admin/plans/starter'],
        ['patch', '/admin/plans/starter'],
        ['delete', '/admin/plans/starter'],
      ];
      for (const [method, path] of attempts) {
        const res = await request(app.getHttpServer())
          [method](path)
          .set('Authorization', `Bearer ${rootAccess}`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      expect(await prisma.adminAuditLog.count({ where: { targetType: 'Plan' } })).toBe(0);
    });
  });

  describe('auth and role gates', () => {
    it('no token -> 401 UNAUTHENTICATED', async () => {
      const res = await request(app.getHttpServer()).get('/admin/plans');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('garbage token -> 401', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/plans')
        .set('Authorization', 'Bearer not-a-token');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('a valid USER access token is rejected on the admin route -> 401', async () => {
      const otpReq = await request(app.getHttpServer())
        .post('/auth/request-otp')
        .send({ phone: USER_PHONE });
      expect(otpReq.status).toBe(202);
      const code = sender.codes.get(USER_PHONE)!;
      const userSession = await request(app.getHttpServer())
        .post('/auth/verify-otp')
        .send({ phone: USER_PHONE, code });
      expect(userSession.status).toBe(200);

      const res = await request(app.getHttpServer())
        .get('/admin/plans')
        .set('Authorization', `Bearer ${userSession.body.accessToken}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('both registry roles may read: superadmin and support -> 200', async () => {
      const root = await list(rootAccess);
      expect(root.status).toBe(200);
      const support = await list(supportAccess);
      expect(support.status).toBe(200);
      expect(support.body).toEqual(root.body);
    });
  });

  // Ordered last: it empties the catalog table for the rest of this isolated DB.
  describe('empty catalog', () => {
    it('reads gracefully when no plan rows exist', async () => {
      await prisma.plan.deleteMany({});
      const res = await list();
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });
});
