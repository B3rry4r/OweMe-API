import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { CommonModule } from '../../common/common.module';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { InsightsModule } from '../insights.module';
import { Role } from '../../shared';

/**
 * Insights (contract). Boots a real Nest app with the SAME global guards
 * (JwtAuthGuard + RolesGuard), HttpExceptionFilter and ValidationPipe as app.module.
 *
 * GET /insights/dashboard is a 501 scaffold (registry: Insights). Asserts:
 *   - owner -> 501 with an ErrorEnvelope-shaped body.
 *   - staff -> 403 FORBIDDEN (role enforced BEFORE the 501).
 *   - no token -> 401 UNAUTHENTICATED.
 */
describe('Insights (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';

  // Distinctive tenant id so this suite never collides with other waves' seeded rows.
  const BIZ = '01912aaa-bbbb-7ccc-8ddd-insightsdash0';

  const mintToken = (role: Role, businessId: string): string =>
    jwt.sign({ sub: `user-${role}`, businessId, role }, { secret: JWT_SECRET, expiresIn: '1h' });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, InsightsModule],
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
    jwt = app.get(JwtService);
    await app.init();

    // Seed a Business + owner so the tenant exists (owner is coarse-role owner via JWT).
    await prisma.business.upsert({
      where: { id: BIZ },
      create: {
        id: BIZ,
        businessName: 'Insights Co',
        ownerName: 'Ada Owner',
        phone: '08010000000',
        category: 'Retail',
        currency: 'NGN (₦)',
        reminderTone: 'gentle',
        plan: 'market',
      },
      update: {},
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /insights/dashboard as owner -> 501 with ErrorEnvelope-shaped body', async () => {
    const res = await request(app.getHttpServer())
      .get('/insights/dashboard')
      .set('Authorization', `Bearer ${mintToken('owner', BIZ)}`);

    expect(res.status).toBe(501);
    // ErrorEnvelope: { error: { code, message } }
    expect(res.body.error).toBeDefined();
    expect(typeof res.body.error.code).toBe('string');
    expect(typeof res.body.error.message).toBe('string');
    // 501 maps through the shared filter's >=500 branch -> INTERNAL.
    expect(res.body.error.code).toBe('INTERNAL');
  });

  it('GET /insights/dashboard as staff -> 403 FORBIDDEN (role enforced before 501)', async () => {
    const res = await request(app.getHttpServer())
      .get('/insights/dashboard')
      .set('Authorization', `Bearer ${mintToken('staff', BIZ)}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('GET /insights/dashboard with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer()).get('/insights/dashboard');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
