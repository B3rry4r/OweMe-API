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
import { SendAllowanceService } from '../send-allowance.service';
import { Role } from '../../shared';

/**
 * Usage / ledgers (contract). Boots a real Nest app with the SAME global guards
 * (JwtAuthGuard + RolesGuard), HttpExceptionFilter and ValidationPipe as app.module, and
 * exercises BOTH the GET /usage HTTP contract AND the exported ledger services directly
 * (the key downstream deliverable). Plan catalog is seeded by the jest globalSetup.
 */
describe('Usage / ledgers (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let credits: CreditLedgerService;
  let sends: SendAllowanceService;

  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';

  // Distinctive tenant ids so this suite never collides with other waves' seeded rows.
  const BIZ_MARKET = '01912aaa-bbbb-7ccc-8ddd-usage00market'; // GET /usage shape (untouched)
  const BIZ_CREDIT = '01912aaa-bbbb-7ccc-8ddd-usage00credit'; // service debit/PLAN_REQUIRED
  const BIZ_SEND = '01912aaa-bbbb-7ccc-8ddd-usage000send00'; // service debitSend metering
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
    sends = app.get(SendAllowanceService);
    await app.init();

    await seedBusiness(BIZ_MARKET, 'market');
    await seedBusiness(BIZ_CREDIT, 'market');
    await seedBusiness(BIZ_SEND, 'market');
    await seedBusiness(BIZ_FAIR, 'enterprise');
  });

  afterAll(async () => {
    await app.close();
  });

  // --- HTTP contract: GET /usage -------------------------------------------
  it('GET /usage as owner -> 200 + both meters, plan-derived grants initialized', async () => {
    const res = await request(app.getHttpServer())
      .get('/usage')
      .set('Authorization', `Bearer ${mintToken('owner', BIZ_MARKET)}`);

    expect(res.status).toBe(200);

    // shape: sendAllowance { used, remaining, monthlyGrant, periodStart }
    const send = res.body.sendAllowance;
    expect(typeof send.used).toBe('number');
    expect(typeof send.remaining).toBe('number');
    expect(typeof send.monthlyGrant).toBe('number');
    expect(typeof send.periodStart).toBe('string');

    // shape: aiCredits { used, balance, monthlyGrant, periodStart }
    const ai = res.body.aiCredits;
    expect(typeof ai.used).toBe('number');
    expect(typeof ai.balance).toBe('number');
    expect(typeof ai.monthlyGrant).toBe('number');
    expect(typeof ai.periodStart).toBe('string');

    // market grants (conventions §Metering): sends 50, credits 100 — freshly initialized
    expect(send.monthlyGrant).toBe(50);
    expect(send.remaining).toBe(50);
    expect(send.used).toBe(0);
    expect(ai.monthlyGrant).toBe(100);
    expect(ai.balance).toBe(100);
    expect(ai.used).toBe(0);
  });

  it('GET /usage with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer()).get('/usage');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('GET /usage as staff -> 403 FORBIDDEN (owner-only surface)', async () => {
    const res = await request(app.getHttpServer())
      .get('/usage')
      .set('Authorization', `Bearer ${mintToken('staff', BIZ_MARKET)}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  // --- Service contract: CreditLedgerService -------------------------------
  it('CreditLedgerService.debitCredits reduces balance (weighted, debit-on-success)', async () => {
    expect(await credits.getBalance(BIZ_CREDIT)).toBe(100); // market grant, lazily initialized
    const after = await credits.debitCredits(BIZ_CREDIT, 5, 'risk'); // weight 5 (risk)
    expect(after).toBe(95);
    expect(await credits.getBalance(BIZ_CREDIT)).toBe(95);
  });

  it('CreditLedgerService.debitCredits beyond balance -> PLAN_REQUIRED', async () => {
    await expect(credits.debitCredits(BIZ_CREDIT, 1000, 'insight')).rejects.toMatchObject({
      code: 'PLAN_REQUIRED',
    });
    expect(await credits.getBalance(BIZ_CREDIT)).toBe(95); // unchanged — debit did not apply
  });

  // --- Service contract: SendAllowanceService ------------------------------
  it('SendAllowanceService.debitSend meters sms; call/manual do NOT', async () => {
    expect(await sends.getRemaining(BIZ_SEND)).toBe(50); // market grant

    expect(await sends.debitSend(BIZ_SEND, 'sms')).toBe(49); // metered
    expect(await sends.debitSend(BIZ_SEND, 'whatsapp')).toBe(48); // metered

    await sends.debitSend(BIZ_SEND, 'call'); // free
    await sends.debitSend(BIZ_SEND, 'manual'); // free
    await sends.debitSend(BIZ_SEND, 'printable'); // free
    expect(await sends.getRemaining(BIZ_SEND)).toBe(48); // unchanged by free channels
  });

  // --- Service contract: fair-use (-1) never blocks ------------------------
  it('fair-use plan (-1) never blocks either ledger', async () => {
    // credits: monthlyGrant -1, huge debits never throw
    expect(await credits.getBalance(BIZ_FAIR)).toBe(-1);
    await expect(credits.debitCredits(BIZ_FAIR, 9999, 'insight')).resolves.toBeDefined();
    expect(await credits.getBalance(BIZ_FAIR)).toBe(-1); // unmetered, unchanged

    // sends: monthlyGrant -1, repeated metered sends never throw
    expect(await sends.getRemaining(BIZ_FAIR)).toBe(-1);
    for (let i = 0; i < 25; i++) {
      await expect(sends.debitSend(BIZ_FAIR, 'sms')).resolves.toBeDefined();
    }
    expect(await sends.getRemaining(BIZ_FAIR)).toBe(-1); // unmetered, unchanged
  });
});
