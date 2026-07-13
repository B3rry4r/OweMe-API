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
import { BvumModule } from '../bvum.module';
import { Role } from '../../shared';

/**
 * BVUM (contract). Boots a real Nest app with the SAME global guards (JwtAuthGuard +
 * RolesGuard), HttpExceptionFilter and ValidationPipe as app.module, and exercises the
 * GET /bvum contract. Plan catalog (with bvumCeiling) is seeded by the jest globalSetup.
 *
 * Asserts: response SHAPE (value int kobo, ceiling concrete kobo, recommendedPlan, windowDays:30),
 * rev-2 per-plan concrete ceilings + the bvumCeilingOverride banding path, that a near-ceiling
 * business gets recommendedPlan set to the next plan up, that the plan is NEVER mutated by the
 * read, and owner-only auth (staff -> 403, no token -> 401).
 */
describe('BVUM (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';

  // Distinctive tenant ids so this suite never collides with other waves' seeded rows.
  const BIZ_SMALL = '01912aaa-bbbb-7ccc-8ddd-bvum000small0'; // market plan, tiny portfolio -> null rec
  const BIZ_NEAR = '01912aaa-bbbb-7ccc-8ddd-bvum0000near0'; // market plan, near/over ceiling -> rec
  const BIZ_OVERRIDE = '01912aaa-bbbb-7ccc-8ddd-bvum00overr0'; // enterprise + bvumCeilingOverride band
  // rev 2: per-plan CONCRETE ceilings (kobo). market = ₦1.5M = 150,000,000 kobo.
  const MARKET_CEILING = 150_000_000; // ₦1.5M in kobo (market plan)
  const OVERRIDE_CEILING = 6_000_000_000; // enterprise banding override (₦60M)

  const CUST_A = '01912aaa-bbbb-7ccc-8ddd-bvumcustA0000';
  const CUST_B = '01912aaa-bbbb-7ccc-8ddd-bvumcustB0000';

  const mintToken = (role: Role, businessId: string): string =>
    jwt.sign({ sub: `user-${role}`, businessId, role }, { secret: JWT_SECRET, expiresIn: '1h' });

  const seedBusiness = (id: string, plan: string): Promise<unknown> =>
    prisma.business.upsert({
      where: { id },
      create: {
        id,
        businessName: `BVUM Co ${plan}`,
        ownerName: 'Ada Owner',
        phone: '08010000000',
        category: 'Retail',
        currency: 'NGN (₦)',
        reminderTone: 'gentle',
        plan,
      },
      update: { plan },
    });

  const seedCustomer = (id: string, businessId: string): Promise<unknown> =>
    prisma.customer.upsert({
      where: { id },
      create: { id, businessId, name: `Cust ${id.slice(-4)}`, phone: '08020000000' },
      update: {},
    });

  const seedDebt = (
    id: string,
    businessId: string,
    customerId: string,
    amount: number,
  ): Promise<unknown> =>
    prisma.debt.upsert({
      where: { id },
      create: { id, businessId, customerId, amount, deleted: false },
      update: { amount, deleted: false, customerId },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, BvumModule],
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

    // BIZ_SMALL: market plan, one tiny open debt -> value well below ceiling -> no recommendation.
    await seedBusiness(BIZ_SMALL, 'market');
    await seedCustomer(CUST_A, BIZ_SMALL);
    await seedDebt('01912aaa-bbbb-7ccc-8ddd-bvumdebtsm000', BIZ_SMALL, CUST_A, 100_000); // ₦1,000

    // BIZ_NEAR: market plan, large fresh receivables -> value >= 0.8 * ceiling -> recommend next.
    await seedBusiness(BIZ_NEAR, 'market');
    await seedCustomer(CUST_B, BIZ_NEAR);
    await seedDebt('01912aaa-bbbb-7ccc-8ddd-bvumdebtnr000', BIZ_NEAR, CUST_B, 500_000_000); // ₦5M

    // BIZ_OVERRIDE: enterprise plan with a sales-provisioned bvumCeilingOverride (banding) —
    // the override must win over the plan's base ₦40M ceiling.
    await seedBusiness(BIZ_OVERRIDE, 'enterprise');
    await prisma.business.update({
      where: { id: BIZ_OVERRIDE },
      data: { bvumCeilingOverride: BigInt(OVERRIDE_CEILING) },
    });
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  it('GET /bvum as owner -> 200 + shape { value int kobo, ceiling kobo, recommendedPlan, windowDays:30 }', async () => {
    const res = await request(app.getHttpServer())
      .get('/bvum')
      .set('Authorization', `Bearer ${mintToken('owner', BIZ_SMALL)}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.value).toBe('number');
    expect(Number.isInteger(res.body.value)).toBe(true);
    expect(res.body.value).toBeGreaterThanOrEqual(0);
    // market ceiling = ₦1.5M = 150,000,000 kobo (rev 2, concrete per-plan ceiling)
    expect(res.body.ceiling).toBe(MARKET_CEILING);
    expect(res.body.windowDays).toBe(30);
    // tiny portfolio -> value far below ceiling -> no recommendation
    expect(res.body.value).toBeLessThan(MARKET_CEILING * 0.8);
    expect(res.body.recommendedPlan).toBeNull();
  });

  it('GET /bvum for a near-ceiling business -> recommendedPlan set to the next plan up; plan NOT changed', async () => {
    const before = await prisma.business.findUnique({ where: { id: BIZ_NEAR } });
    expect(before?.plan).toBe('market');

    const res = await request(app.getHttpServer())
      .get('/bvum')
      .set('Authorization', `Bearer ${mintToken('owner', BIZ_NEAR)}`);

    expect(res.status).toBe(200);
    expect(res.body.ceiling).toBe(MARKET_CEILING);
    // value nears/exceeds ceiling (fraction >= 0.8)
    expect(res.body.value).toBeGreaterThanOrEqual(MARKET_CEILING * 0.8);
    // next plan up with a higher ceiling than market (₦1.5M) is business (₦6M)
    expect(res.body.recommendedPlan).toBe('business');

    // RECOMMENDATION ONLY — the read must not mutate the plan.
    const after = await prisma.business.findUnique({ where: { id: BIZ_NEAR } });
    expect(after?.plan).toBe('market');
  });

  it('GET /bvum with a bvumCeilingOverride -> ceiling is the banded override, not the plan base', async () => {
    const res = await request(app.getHttpServer())
      .get('/bvum')
      .set('Authorization', `Bearer ${mintToken('owner', BIZ_OVERRIDE)}`);

    expect(res.status).toBe(200);
    // enterprise base ceiling is ₦40M = 4,000,000,000; the override (₦60M) must win.
    expect(res.body.ceiling).toBe(OVERRIDE_CEILING);
    expect(res.body.windowDays).toBe(30);
    // no debts + already at the top tier -> no upgrade recommendation.
    expect(res.body.recommendedPlan).toBeNull();
  });

  it('GET /bvum as staff -> 403 FORBIDDEN (owner-only surface)', async () => {
    const res = await request(app.getHttpServer())
      .get('/bvum')
      .set('Authorization', `Bearer ${mintToken('staff', BIZ_SMALL)}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('GET /bvum with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer()).get('/bvum');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
