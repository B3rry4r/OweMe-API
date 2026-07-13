import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { PrismaModule } from '../../prisma/prisma.module';
import { CommonModule } from '../../common/common.module';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { PlansModule } from '../plans.module';

/**
 * Contract test for GET /plans (Plan reference/catalog resource).
 * Boots PlansModule + PrismaModule + the global infra (CommonModule provides the JWT
 * strategy/guards) with JwtAuthGuard + RolesGuard as APP_GUARD and the HttpExceptionFilter,
 * against the fresh migrated+seeded test DB. Asserts SHAPES, not snapshots.
 */
describe('Plans (contract)', () => {
  let app: INestApplication;
  let ownerToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, PlansModule],
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
    await app.init();

    // Mint a valid owner access token (same secret the JwtStrategy validates against).
    const jwt = app.get(JwtService);
    ownerToken = jwt.sign(
      { sub: 'owner-user-1', businessId: 'biz-1', role: 'owner' },
      { secret: process.env.JWT_ACCESS_SECRET },
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /plans (authenticated owner) -> 200 + array of the 4 plans matching the Plan shape', async () => {
    const res = await request(app.getHttpServer())
      .get('/plans')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(4);

    const ids = res.body.map((p: { id: string }) => p.id).sort();
    expect(ids).toEqual(['business', 'enterprise', 'market', 'starter']);

    for (const plan of res.body) {
      // Key presence + types.
      expect(typeof plan.id).toBe('string');
      expect(['starter', 'market', 'business', 'enterprise']).toContain(plan.id);
      expect(typeof plan.name).toBe('string');
      expect(typeof plan.pricePerMonth).toBe('number');
      expect(Number.isInteger(plan.pricePerMonth)).toBe(true); // int kobo
      expect(plan.pricePerMonth).toBeGreaterThanOrEqual(0);
      expect(typeof plan.tagline).toBe('string');

      // features is string[].
      expect(Array.isArray(plan.features)).toBe(true);
      for (const f of plan.features) expect(typeof f).toBe('string');

      // productId string|null.
      expect(plan.productId === null || typeof plan.productId === 'string').toBe(true);
      expect(typeof plan.talkToSales).toBe('boolean');
      expect(typeof plan.recommended).toBe('boolean');

      // limits present with correct types + sentinels.
      expect(plan.limits).toBeDefined();
      expect(typeof plan.limits.sendsPerMonth).toBe('number');
      expect(typeof plan.limits.aiCreditsPerMonth).toBe('number');
      expect(typeof plan.limits.staffSeats).toBe('number');
      expect(Number.isInteger(plan.limits.sendsPerMonth)).toBe(true);
      expect(
        plan.limits.bvumCeiling === null || typeof plan.limits.bvumCeiling === 'number',
      ).toBe(true);
    }

    // Sentinel correctness on the fair-use/unlimited enterprise tier.
    const enterprise = res.body.find((p: { id: string }) => p.id === 'enterprise');
    expect(enterprise.talkToSales).toBe(true);
    expect(enterprise.productId).toBeNull();
    expect(enterprise.limits.sendsPerMonth).toBe(-1); // fair-use
    expect(enterprise.limits.aiCreditsPerMonth).toBe(-1); // fair-use
    expect(enterprise.limits.staffSeats).toBe(-1); // unlimited
    expect(enterprise.limits.bvumCeiling).toBeNull(); // unlimited

    // Free tier sentinel.
    const starter = res.body.find((p: { id: string }) => p.id === 'starter');
    expect(starter.pricePerMonth).toBe(0);
  });

  it('GET /plans with NO token -> 401 UNAUTHENTICATED ErrorEnvelope', async () => {
    const res = await request(app.getHttpServer()).get('/plans');

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toHaveProperty('code', 'UNAUTHENTICATED');
    expect(typeof res.body.error.message).toBe('string');
  });
});
