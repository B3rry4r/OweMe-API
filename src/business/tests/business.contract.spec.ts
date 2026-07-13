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
import { BusinessModule } from '../business.module';
import { REMINDER_TONE_VALUES, Role } from '../../shared';

/**
 * Business (contract). Boots a real Nest app with the SAME global guards
 * (JwtAuthGuard + RolesGuard as APP_GUARD), HttpExceptionFilter and ValidationPipe
 * as app.module, so auth/role behavior is exercised for real. Business rows are
 * seeded via PrismaService; owner/staff JWTs are minted with the JwtStrategy's secret.
 */
describe('Business (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  // Distinctive tenant id so this suite never collides with other waves' seeded rows.
  const BUSINESS_ID = '01912aaa-bbbb-7ccc-8ddd-business0001';
  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';

  const mintToken = (role: Role, businessId: string | null = BUSINESS_ID): string =>
    jwt.sign(
      { sub: `user-${role}`, businessId, role },
      { secret: JWT_SECRET, expiresIn: '1h' },
    );

  let ownerToken: string;
  let staffToken: string;

  /** Assert an object matches the Business wire shape (key presence + types). */
  const expectBusinessShape = (b: Record<string, unknown>): void => {
    expect(typeof b.id).toBe('string');
    expect(typeof b.businessName).toBe('string');
    expect(typeof b.ownerName).toBe('string');
    expect(typeof b.phone).toBe('string');
    expect(typeof b.category).toBe('string');
    expect(typeof b.currency).toBe('string');
    expect(REMINDER_TONE_VALUES).toContain(b.reminderTone);
    expect(typeof b.plan).toBe('string');
    // nullable display/reserved fields
    expect(b.paystackSubaccount === null || typeof b.paystackSubaccount === 'string').toBe(true);
    expect(b.logoUrl === null || typeof b.logoUrl === 'string').toBe(true);
    expect(b.branchId === null || typeof b.branchId === 'string').toBe(true);
    expect(typeof b.createdAt).toBe('string');
    expect(typeof b.updatedAt).toBe('string');
    expect(typeof b.version).toBe('number');
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, BusinessModule],
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

    // Seed the tenant profile row this suite operates on.
    await prisma.business.upsert({
      where: { id: BUSINESS_ID },
      create: {
        id: BUSINESS_ID,
        businessName: 'Seeded Traders',
        ownerName: 'Ada Owner',
        phone: '08010000000',
        category: 'Retail',
        currency: 'NGN (₦)',
        reminderTone: 'gentle',
      },
      update: {},
    });

    ownerToken = mintToken('owner');
    staffToken = mintToken('staff');
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /business as owner -> 200 + Business shape', async () => {
    const res = await request(app.getHttpServer())
      .get('/business')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(BUSINESS_ID);
    expectBusinessShape(res.body);
  });

  it('GET /business as staff -> 200 + Business shape', async () => {
    const res = await request(app.getHttpServer())
      .get('/business')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(200);
    expectBusinessShape(res.body);
  });

  it('GET /business with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer()).get('/business');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('PUT /business as owner -> 200 + updated Business shape', async () => {
    const res = await request(app.getHttpServer())
      .put('/business')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ businessName: 'Renamed Traders', reminderTone: 'final', currency: 'USD ($)' });
    expect(res.status).toBe(200);
    expectBusinessShape(res.body);
    expect(res.body.businessName).toBe('Renamed Traders');
    expect(res.body.reminderTone).toBe('final');
    expect(res.body.currency).toBe('USD ($)');
    // tenancy: id is the JWT businessId, never a client value
    expect(res.body.id).toBe(BUSINESS_ID);
  });

  it('PUT /business with invalid body -> 422 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .put('/business')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ businessName: 'Ok Name', reminderTone: 'loud' }); // 'loud' not in enum
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PUT /business as staff -> 403 FORBIDDEN', async () => {
    const res = await request(app.getHttpServer())
      .put('/business')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ businessName: 'Staff Should Not' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('PUT /business with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer())
      .put('/business')
      .send({ businessName: 'No Auth' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('PUT /business creates the row on first call for a new tenant (upsert)', async () => {
    const NEW_ID = '01912aaa-bbbb-7ccc-8ddd-business0002';
    const token = mintToken('owner', NEW_ID);
    const res = await request(app.getHttpServer())
      .put('/business')
      .set('Authorization', `Bearer ${token}`)
      .send({ businessName: 'Fresh Onboarded Co' });
    expect(res.status).toBe(200);
    expectBusinessShape(res.body);
    expect(res.body.id).toBe(NEW_ID);
    expect(res.body.businessName).toBe('Fresh Onboarded Co');
    expect(res.body.plan).toBe('starter'); // fail-closed default
  });
});
