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
import { PAYSTACK_GATEWAY, PaystackGateway } from '../../common';
import { PayoutAccountModule } from '../payout-account.module';
import { Role } from '../../shared';

/**
 * PayoutAccount (contract). Boots a real Nest app with the SAME global guards
 * (JwtAuthGuard + RolesGuard as APP_GUARD), HttpExceptionFilter and ValidationPipe as
 * app.module. Overrides PAYSTACK_GATEWAY with a deterministic stub. Seeds a Business +
 * owner, mints owner/staff JWTs, and asserts the owner-only surface + wire SHAPES.
 */

const FIXED_BANKS = [
  { code: '044', name: 'Access Bank' },
  { code: '058', name: 'Guaranty Trust Bank' },
];
const RESOLVED_NAME = 'ADAEZE OKONKWO';
const SUBACCOUNT_CODE = 'ACCT_test_subaccount';

class FixturePaystackGateway implements PaystackGateway {
  async listBanks() {
    return FIXED_BANKS;
  }
  async resolveAccount(_bankCode: string, accountNumber: string) {
    if (accountNumber === '0000000000') {
      throw new Error('invalid account');
    }
    return { accountName: RESOLVED_NAME };
  }
  async createSubaccount() {
    return { subaccountCode: SUBACCOUNT_CODE };
  }
  async createPaymentRequest(input: { reference: string }) {
    return { url: `https://paystack.test/pay/${input.reference}`, reference: input.reference };
  }
  verifySignature() {
    return true;
  }
}

describe('PayoutAccount (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const BUSINESS_ID = '01912aaa-bbbb-7ccc-8ddd-payout000001';
  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';

  const mintToken = (role: Role, businessId: string | null = BUSINESS_ID): string =>
    jwt.sign({ sub: `user-${role}`, businessId, role }, { secret: JWT_SECRET, expiresIn: '1h' });

  let ownerToken: string;
  let staffToken: string;

  const expectPayoutShape = (a: Record<string, unknown>): void => {
    expect(typeof a.businessId).toBe('string');
    expect(typeof a.bankCode).toBe('string');
    expect(typeof a.accountNumber).toBe('string');
    expect(typeof a.accountName).toBe('string');
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, PayoutAccountModule],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(PAYSTACK_GATEWAY)
      .useClass(FixturePaystackGateway)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    await app.init();

    await prisma.payoutAccount.deleteMany({ where: { businessId: BUSINESS_ID } });
    await prisma.business.upsert({
      where: { id: BUSINESS_ID },
      create: {
        id: BUSINESS_ID,
        businessName: 'Payout Traders',
        ownerName: 'Ada Owner',
        phone: '08030000000',
        category: 'Retail',
        currency: 'NGN (₦)',
        reminderTone: 'gentle',
        plan: 'starter',
      },
      update: { paystackSubaccount: null },
    });

    ownerToken = mintToken('owner');
    staffToken = mintToken('staff');
  });

  afterAll(async () => {
    await app.close();
  });

  // --- GET /banks ------------------------------------------------------------
  it('GET /banks as owner -> 200 Bank[] {code,name}', async () => {
    const res = await request(app.getHttpServer())
      .get('/banks')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    res.body.forEach((b: Record<string, unknown>) => {
      expect(typeof b.code).toBe('string');
      expect(typeof b.name).toBe('string');
    });
  });

  it('GET /banks as staff -> 403 FORBIDDEN', async () => {
    const res = await request(app.getHttpServer())
      .get('/banks')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('GET /banks with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer()).get('/banks');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  // --- POST /payout-account/resolve -----------------------------------------
  it('POST /payout-account/resolve as owner -> 200 {accountName}', async () => {
    const res = await request(app.getHttpServer())
      .post('/payout-account/resolve')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ bankCode: '044', accountNumber: '0123456789' });
    expect(res.status).toBe(200);
    expect(typeof res.body.accountName).toBe('string');
    expect(res.body.accountName).toBe(RESOLVED_NAME);
  });

  it('POST /payout-account/resolve with a non-10-digit number -> 422 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post('/payout-account/resolve')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ bankCode: '044', accountNumber: '123' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /payout-account/resolve for an unresolvable account -> error envelope', async () => {
    const res = await request(app.getHttpServer())
      .post('/payout-account/resolve')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ bankCode: '044', accountNumber: '0000000000' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /payout-account/resolve as staff -> 403 FORBIDDEN', async () => {
    const res = await request(app.getHttpServer())
      .post('/payout-account/resolve')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ bankCode: '044', accountNumber: '0123456789' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('POST /payout-account/resolve with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer())
      .post('/payout-account/resolve')
      .send({ bankCode: '044', accountNumber: '0123456789' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  // --- GET /payout-account (empty) ------------------------------------------
  it('GET /payout-account as owner before setup -> 200 null', async () => {
    const res = await request(app.getHttpServer())
      .get('/payout-account')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    // No account yet: body carries no PayoutAccount fields.
    expect(res.body.bankCode).toBeUndefined();
  });

  // --- PUT /payout-account --------------------------------------------------
  it('PUT /payout-account as owner -> 200 PayoutAccount; Business.paystackSubaccount set', async () => {
    const res = await request(app.getHttpServer())
      .put('/payout-account')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ bankCode: '058', accountNumber: '0123456789', accountName: RESOLVED_NAME });
    expect(res.status).toBe(200);
    expectPayoutShape(res.body);
    expect(res.body.businessId).toBe(BUSINESS_ID);
    expect(res.body.bankCode).toBe('058');
    expect(res.body.accountNumber).toBe('0123456789');
    expect(res.body.accountName).toBe(RESOLVED_NAME);

    const business = await prisma.business.findUnique({ where: { id: BUSINESS_ID } });
    expect(business?.paystackSubaccount).toBe(SUBACCOUNT_CODE);
  });

  it('GET /payout-account after PUT -> 200 the stored PayoutAccount', async () => {
    const res = await request(app.getHttpServer())
      .get('/payout-account')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expectPayoutShape(res.body);
    expect(res.body.bankCode).toBe('058');
    expect(res.body.accountName).toBe(RESOLVED_NAME);
  });

  it('PUT /payout-account updates (not duplicates) the single row', async () => {
    const res = await request(app.getHttpServer())
      .put('/payout-account')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ bankCode: '044', accountNumber: '9876543210', accountName: 'NEW NAME' });
    expect(res.status).toBe(200);
    expect(res.body.bankCode).toBe('044');

    const rows = await prisma.payoutAccount.findMany({ where: { businessId: BUSINESS_ID } });
    expect(rows.length).toBe(1);
  });

  it('PUT /payout-account with invalid body -> 422 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .put('/payout-account')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ bankCode: '044' }); // missing accountNumber + accountName
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PUT /payout-account as staff -> 403 FORBIDDEN', async () => {
    const res = await request(app.getHttpServer())
      .put('/payout-account')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ bankCode: '044', accountNumber: '0123456789', accountName: RESOLVED_NAME });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('PUT /payout-account with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer())
      .put('/payout-account')
      .send({ bankCode: '044', accountNumber: '0123456789', accountName: RESOLVED_NAME });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('GET /payout-account as staff -> 403 FORBIDDEN', async () => {
    const res = await request(app.getHttpServer())
      .get('/payout-account')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
