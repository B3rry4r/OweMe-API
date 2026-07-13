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
import { LLM_PROVIDER, LlmProvider, VoiceParseInput, VoiceParseOutput } from '../../common';
import { UsageModule } from '../../usage/usage.module';
import { CreditLedgerService } from '../../usage/credit-ledger.service';
import { VoiceModule } from '../voice.module';
import { Role } from '../../shared';

/**
 * Voice / parse (contract). Boots a real Nest app with the SAME global guards
 * (JwtAuthGuard + RolesGuard), HttpExceptionFilter and ValidationPipe as app.module, and
 * overrides LLM_PROVIDER with a deterministic stub. Asserts the parse SHAPE and the
 * debit-on-success behavior (1 AI credit) + PLAN_REQUIRED exhaustion. Plan catalog is
 * seeded by the jest globalSetup.
 */
describe('Voice / parse (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let credits: CreditLedgerService;

  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';

  // Distinctive tenant ids so this suite never collides with other waves' seeded rows.
  const BIZ_VOICE = '01912aaa-bbbb-7ccc-8ddd-voice00parse0'; // happy-path debit
  const BIZ_EMPTY = '01912aaa-bbbb-7ccc-8ddd-voice00empty0'; // depleted -> PLAN_REQUIRED

  // Deterministic parsed debt returned by the overridden LLM stub.
  const PARSED: VoiceParseOutput = {
    customerName: 'John Doe',
    amount: 500000, // kobo (₦5,000)
    description: 'two bags of rice',
    dueDate: '2026-08-01T00:00:00.000Z',
  };

  class DeterministicLlm implements LlmProvider {
    async parseVoiceDebt(_input: VoiceParseInput): Promise<VoiceParseOutput> {
      return { ...PARSED };
    }
    async generateInsights(): Promise<Record<string, unknown>> {
      return {};
    }
    async scoreCustomerRisk(): Promise<{ score: number; band: string }> {
      return { score: 0, band: 'unknown' };
    }
  }

  const mintToken = (role: Role, businessId: string): string =>
    jwt.sign({ sub: `user-${role}`, businessId, role }, { secret: JWT_SECRET, expiresIn: '1h' });

  const seedBusiness = (id: string, plan: string): Promise<unknown> =>
    prisma.business.upsert({
      where: { id },
      create: {
        id,
        businessName: `Voice Co ${plan}`,
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
      imports: [PrismaModule, CommonModule, UsageModule, VoiceModule],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(LLM_PROVIDER)
      .useClass(DeterministicLlm)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    credits = app.get(CreditLedgerService);
    await app.init();

    await seedBusiness(BIZ_VOICE, 'market'); // 100 AI credits (market grant)
    await seedBusiness(BIZ_EMPTY, 'market');

    // Deplete BIZ_EMPTY to exactly 0 so the next debit throws PLAN_REQUIRED.
    const bal = await credits.getBalance(BIZ_EMPTY); // lazily initializes to 100
    await credits.debitCredits(BIZ_EMPTY, bal, 'test-deplete');
    expect(await credits.getBalance(BIZ_EMPTY)).toBe(0);
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /voice/parse as owner -> 200 + parsed shape; debits 1 AI credit', async () => {
    const before = await credits.getBalance(BIZ_VOICE); // 100

    const res = await request(app.getHttpServer())
      .post('/voice/parse')
      .set('Authorization', `Bearer ${mintToken('owner', BIZ_VOICE)}`)
      .send({ transcript: 'John Doe owes me five thousand naira for two bags of rice' });

    expect(res.status).toBe(200);

    // shape: { customerName: string|null, amount: int(kobo), description: string|null, dueDate: datetime|null }
    expect(res.body).toEqual({
      customerName: 'John Doe',
      amount: 500000,
      description: 'two bags of rice',
      dueDate: '2026-08-01T00:00:00.000Z',
    });
    expect(typeof res.body.amount).toBe('number');
    expect(Number.isInteger(res.body.amount)).toBe(true);

    // debit-on-success: balance dropped by exactly 1.
    expect(await credits.getBalance(BIZ_VOICE)).toBe(before - 1);
  });

  it('POST /voice/parse with knownCustomers -> 200 (optional field accepted)', async () => {
    const res = await request(app.getHttpServer())
      .post('/voice/parse')
      .set('Authorization', `Bearer ${mintToken('staff', BIZ_VOICE)}`)
      .send({ transcript: 'John owes 5k', knownCustomers: ['John Doe', 'Jane'] });

    expect(res.status).toBe(200);
    expect(res.body.customerName).toBe('John Doe');
  });

  it('POST /voice/parse as staff -> 200 (owner|staff allowed)', async () => {
    const before = await credits.getBalance(BIZ_VOICE);

    const res = await request(app.getHttpServer())
      .post('/voice/parse')
      .set('Authorization', `Bearer ${mintToken('staff', BIZ_VOICE)}`)
      .send({ transcript: 'Jane owes two thousand' });

    expect(res.status).toBe(200);
    expect(await credits.getBalance(BIZ_VOICE)).toBe(before - 1);
  });

  it('POST /voice/parse when credits exhausted -> 403 PLAN_REQUIRED; no debit/parse leak', async () => {
    expect(await credits.getBalance(BIZ_EMPTY)).toBe(0);

    const res = await request(app.getHttpServer())
      .post('/voice/parse')
      .set('Authorization', `Bearer ${mintToken('owner', BIZ_EMPTY)}`)
      .send({ transcript: 'Someone owes me money' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLAN_REQUIRED');
    // No parsed data leaked in the error body.
    expect(res.body.customerName).toBeUndefined();
    expect(res.body.amount).toBeUndefined();
    // Balance unchanged (debit did not apply).
    expect(await credits.getBalance(BIZ_EMPTY)).toBe(0);
  });

  it('POST /voice/parse with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer())
      .post('/voice/parse')
      .send({ transcript: 'John owes 5k' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('POST /voice/parse with missing transcript -> 422 VALIDATION_ERROR; no debit', async () => {
    const before = await credits.getBalance(BIZ_VOICE);

    const res = await request(app.getHttpServer())
      .post('/voice/parse')
      .set('Authorization', `Bearer ${mintToken('owner', BIZ_VOICE)}`)
      .send({ knownCustomers: ['John'] });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    // Rejected before the service ran -> no debit.
    expect(await credits.getBalance(BIZ_VOICE)).toBe(before);
  });
});
