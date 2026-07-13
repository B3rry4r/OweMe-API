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

  it('GET /plans (authenticated owner) -> 200 + array of the 5 rev-2 plans matching the Plan shape', async () => {
    const res = await request(app.getHttpServer())
      .get('/plans')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Rev 2: FIVE canonical tiers.
    expect(res.body).toHaveLength(5);

    const ids = res.body.map((p: { id: string }) => p.id).sort();
    expect(ids).toEqual(['business', 'enterprise', 'market', 'starter', 'wholesale']);

    // Returned ascending by price (money is integer kobo).
    const prices = res.body.map((p: { pricePerMonth: number }) => p.pricePerMonth);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    // Which, for rev-2 prices, is exactly this order:
    expect(res.body.map((p: { id: string }) => p.id)).toEqual([
      'starter',
      'market',
      'business',
      'wholesale',
      'enterprise',
    ]);

    for (const plan of res.body) {
      // Key presence + types.
      expect(typeof plan.id).toBe('string');
      expect(['starter', 'market', 'business', 'wholesale', 'enterprise']).toContain(plan.id);
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

      // Rev-2 limits shape: { creditsPerMonth, staffSeats, bvumCeiling }.
      expect(plan.limits).toBeDefined();
      expect(typeof plan.limits.creditsPerMonth).toBe('number');
      expect(typeof plan.limits.staffSeats).toBe('number');
      expect(Number.isInteger(plan.limits.creditsPerMonth)).toBe(true);
      expect(Number.isInteger(plan.limits.staffSeats)).toBe(true);
      // bvumCeiling is now a concrete number on the wire for EVERY tier (never null).
      expect(typeof plan.limits.bvumCeiling).toBe('number');
      expect(Number.isInteger(plan.limits.bvumCeiling)).toBe(true);

      // Old rev-1 fields are GONE.
      expect(plan.limits.sendsPerMonth).toBeUndefined();
      expect(plan.limits.aiCreditsPerMonth).toBeUndefined();
    }

    // Exact per-plan rev-2 contract (prices are kobo).
    const byId = Object.fromEntries(res.body.map((p: { id: string }) => [p.id, p]));

    expect(byId.starter).toMatchObject({
      pricePerMonth: 0,
      productId: null,
      talkToSales: false,
      limits: { creditsPerMonth: 50, staffSeats: 0, bvumCeiling: 30_000_000 },
    });

    expect(byId.market).toMatchObject({
      pricePerMonth: 250_000,
      productId: 'oweme_market_monthly',
      recommended: true,
      limits: { creditsPerMonth: 300, staffSeats: 1, bvumCeiling: 150_000_000 },
    });

    expect(byId.business).toMatchObject({
      pricePerMonth: 600_000,
      productId: 'oweme_business_monthly',
      limits: { creditsPerMonth: 1_200, staffSeats: 5, bvumCeiling: 600_000_000 },
    });

    expect(byId.wholesale).toMatchObject({
      pricePerMonth: 1_200_000,
      productId: 'oweme_wholesale_monthly',
      limits: { creditsPerMonth: 3_000, staffSeats: 15, bvumCeiling: 2_000_000_000 },
    });

    // Fair-use / banded enterprise tier: fair-use credits & seats (-1), concrete ceiling.
    expect(byId.enterprise).toMatchObject({
      pricePerMonth: 2_500_000,
      productId: null,
      talkToSales: true,
      limits: { creditsPerMonth: -1, staffSeats: -1, bvumCeiling: 4_000_000_000 },
    });
  });

  it('GET /plans with NO token -> 401 UNAUTHENTICATED ErrorEnvelope', async () => {
    const res = await request(app.getHttpServer()).get('/plans');

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toHaveProperty('code', 'UNAUTHENTICATED');
    expect(typeof res.body.error.message).toBe('string');
  });
});
