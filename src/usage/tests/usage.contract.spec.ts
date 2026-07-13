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
import { UsageModule } from '../usage.module';
import { CreditLedgerService } from '../credit-ledger.service';
import { Role } from '../../shared';

/**
 * Usage / ledgers (contract) — MODEL REV 2. Boots a real Nest app with the SAME global
 * guards (JwtAuthGuard + RolesGuard), HttpExceptionFilter and ValidationPipe as app.module,
 * and exercises BOTH the GET /usage HTTP contract (ONE unified OweMe-credits meter) AND the
 * exported CreditLedgerService directly. Plan catalog is seeded by the jest globalSetup.
 */
describe('Usage / ledgers (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let credits: CreditLedgerService;

  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';

  // Distinctive tenant ids so this suite never collides with other waves' seeded rows.
  const BIZ_STARTER = '01912aaa-bbbb-7ccc-8ddd-usage0starter'; // GET /usage shape (fresh starter)
  const BIZ_CREDIT = '01912aaa-bbbb-7ccc-8ddd-usage00credit'; // service debit/PLAN_REQUIRED
  const BIZ_FAIR = '01912aaa-bbbb-7ccc-8ddd-usage00fairus'; // enterprise fair-use (-1)

  const mintToken = (role: Role, businessId: string): string =>
    jwt.sign({ sub: `user-${role}`, businessId, role }, { secret: JWT_SECRET, expiresIn: '1h' });

  const seedBusiness = (id: string, plan: string): Promise<unknown> =>
    prisma.business.upsert({
      where: { id },
      create: {
        id,
        businessName: `Usage Co ${plan}`,
        ownerName: 'Ada Owner',
        phone: '08010000000',
        category: 'Retail',
        currency: 'NGN (₦)',
        reminderTone: 'gentle',
        plan,
      },
      update: { plan },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, UsageModule],
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
    credits = app.get(CreditLedgerService);
    await app.init();

    await seedBusiness(BIZ_STARTER, 'starter');
    await seedBusiness(BIZ_CREDIT, 'market');
    await seedBusiness(BIZ_FAIR, 'enterprise');
  });

  afterAll(async () => {
    await app.close();
  });

  // --- HTTP contract: GET /usage -------------------------------------------
  it('GET /usage as owner -> 200 + ONE unified credits meter, plan-derived grant initialized', async () => {
    const res = await request(app.getHttpServer())
      .get('/usage')
      .set('Authorization', `Bearer ${mintToken('owner', BIZ_STARTER)}`);

    expect(res.status).toBe(200);

    // Rev-2 shape: ONE meter { credits: { used, limit, balance, monthlyGrant, periodStart } }.
    const credit = res.body.credits;
    expect(credit).toBeDefined();
    expect(typeof credit.used).toBe('number');
    expect(typeof credit.limit).toBe('number');
    expect(typeof credit.balance).toBe('number');
    expect(typeof credit.monthlyGrant).toBe('number');
    expect(typeof credit.periodStart).toBe('string');

    // Old two-meter shape is GONE.
    expect(res.body.sendAllowance).toBeUndefined();
    expect(res.body.aiCredits).toBeUndefined();

    // Fresh starter business: grant 50, freshly initialized (used = max(0, grant - balance)).
    expect(credit.limit).toBe(50);
    expect(credit.monthlyGrant).toBe(50);
    expect(credit.balance).toBe(50);
    expect(credit.used).toBe(0);
  });

  it('GET /usage with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer()).get('/usage');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('GET /usage as staff -> 403 FORBIDDEN (owner-only surface)', async () => {
    const res = await request(app.getHttpServer())
      .get('/usage')
      .set('Authorization', `Bearer ${mintToken('staff', BIZ_STARTER)}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  // --- Service contract: CreditLedgerService (the ONE unified ledger) -------
  it('CreditLedgerService.debitCredits reduces balance (weighted, debit-on-success)', async () => {
    expect(await credits.getBalance(BIZ_CREDIT)).toBe(300); // market grant, lazily initialized
    const after = await credits.debitCredits(BIZ_CREDIT, 5, 'risk'); // weight 5
    expect(after).toBe(295);
    expect(await credits.getBalance(BIZ_CREDIT)).toBe(295);
  });

  it('CreditLedgerService.debitCredits beyond balance -> PLAN_REQUIRED', async () => {
    await expect(credits.debitCredits(BIZ_CREDIT, 1000, 'insight')).rejects.toMatchObject({
      code: 'PLAN_REQUIRED',
    });
    expect(await credits.getBalance(BIZ_CREDIT)).toBe(295); // unchanged — debit did not apply
  });

  // --- Service contract: fair-use (-1) never blocks ------------------------
  it('fair-use plan (-1) never blocks the ledger', async () => {
    // monthlyGrant -1, huge debits never throw and never change the balance
    expect(await credits.getBalance(BIZ_FAIR)).toBe(-1);
    await expect(credits.debitCredits(BIZ_FAIR, 9999, 'insight')).resolves.toBeDefined();
    expect(await credits.getBalance(BIZ_FAIR)).toBe(-1); // unmetered, unchanged
  });
});
