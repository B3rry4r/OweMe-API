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
import { StaffModule } from '../staff.module';
import { ROLE_VALUES, Role } from '../../shared';

/**
 * Staff (contract). Boots a real Nest app with the SAME global guards
 * (JwtAuthGuard + RolesGuard as APP_GUARD), HttpExceptionFilter and ValidationPipe
 * as app.module. Seeds a market-plan tenant (staffSeats == 1) + an owner Staff row,
 * then exercises the owner-only surface, seat-cap enforcement, and shapes.
 */
describe('Staff (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const BUSINESS_ID = '01912aaa-bbbb-7ccc-8ddd-staff00000001';
  const OWNER_STAFF_ID = '01912aaa-bbbb-7ccc-8ddd-staffowner001';
  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';
  const MARKET_SEAT_CAP = 1; // seeded plan catalog: market staffSeats == 1

  const mintToken = (role: Role, businessId: string | null = BUSINESS_ID): string =>
    jwt.sign({ sub: `user-${role}`, businessId, role }, { secret: JWT_SECRET, expiresIn: '1h' });

  let ownerToken: string;
  let staffToken: string;

  /** Assert an object matches the Staff wire shape (key presence + types). */
  const expectStaffShape = (s: Record<string, unknown>): void => {
    expect(typeof s.id).toBe('string');
    expect(typeof s.businessId).toBe('string');
    expect(typeof s.name).toBe('string');
    expect(typeof s.phone).toBe('string');
    expect(ROLE_VALUES).toContain(s.role);
    expect(typeof s.active).toBe('boolean');
    expect(typeof s.createdAt).toBe('string');
    expect(typeof s.updatedAt).toBe('string');
    expect(typeof s.version).toBe('number');
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, StaffModule],
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

    // Fresh tenant on the market plan (staffSeats == 1) + its owner member.
    await prisma.staff.deleteMany({ where: { businessId: BUSINESS_ID } });
    await prisma.business.upsert({
      where: { id: BUSINESS_ID },
      create: {
        id: BUSINESS_ID,
        businessName: 'Seat-Capped Traders',
        ownerName: 'Ada Owner',
        phone: '08020000000',
        category: 'Retail',
        currency: 'NGN (₦)',
        reminderTone: 'gentle',
        plan: 'market',
      },
      update: { plan: 'market' },
    });
    await prisma.staff.create({
      data: {
        id: OWNER_STAFF_ID,
        businessId: BUSINESS_ID,
        name: 'Ada Owner',
        phone: '08020000000',
        role: 'owner',
        active: true,
      },
    });

    ownerToken = mintToken('owner');
    staffToken = mintToken('staff');
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /staff as owner -> 200 + members + {seatCap, seatsUsed}', async () => {
    const res = await request(app.getHttpServer())
      .get('/staff')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    res.body.data.forEach((s: Record<string, unknown>) => expectStaffShape(s));
    // owner rendered first
    expect(res.body.data[0].role).toBe('owner');
    expect(res.body.seatCap).toBe(MARKET_SEAT_CAP);
    expect(res.body.seatsUsed).toBe(0); // only the owner exists (owner does not occupy a seat)
  });

  it('GET /staff with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer()).get('/staff');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('GET /staff as staff -> 403 FORBIDDEN (owner-only)', async () => {
    const res = await request(app.getHttpServer())
      .get('/staff')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('POST /staff as owner within cap -> 201 + Staff shape (role coerced to staff)', async () => {
    const res = await request(app.getHttpServer())
      .post('/staff')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ phone: '08021111111', name: 'Bola Staff', role: 'owner' }); // role must coerce
    expect(res.status).toBe(201);
    expectStaffShape(res.body);
    expect(res.body.role).toBe('staff');
    expect(res.body.active).toBe(true);
    expect(res.body.businessId).toBe(BUSINESS_ID);

    // usage now reflects the occupied seat
    const list = await request(app.getHttpServer())
      .get('/staff')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(list.body.seatsUsed).toBe(1);
  });

  it('POST /staff exceeding the market cap -> 403 PLAN_REQUIRED envelope', async () => {
    const res = await request(app.getHttpServer())
      .post('/staff')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ phone: '08022222222', role: 'staff' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLAN_REQUIRED');
    expect(typeof res.body.error.requiredPlan).toBe('string');
    expect(res.body.error.requiredPlan).toBe('business'); // next plan up from market
  });

  it('POST /staff as staff -> 403 FORBIDDEN', async () => {
    const res = await request(app.getHttpServer())
      .post('/staff')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ phone: '08023333333', role: 'staff' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('POST /staff with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer())
      .post('/staff')
      .send({ phone: '08024444444', role: 'staff' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('POST /staff with invalid body -> 422 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post('/staff')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'staff' }); // missing required phone
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH /staff/:id as owner -> 200 active toggled', async () => {
    // Grab the invited (non-owner) member to toggle.
    const list = await request(app.getHttpServer())
      .get('/staff')
      .set('Authorization', `Bearer ${ownerToken}`);
    const member = list.body.data.find((s: Record<string, unknown>) => s.role === 'staff');
    expect(member).toBeDefined();

    const res = await request(app.getHttpServer())
      .patch(`/staff/${member.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ active: false });
    expect(res.status).toBe(200);
    expectStaffShape(res.body);
    expect(res.body.active).toBe(false);
    expect(res.body.version).toBeGreaterThan(member.version);
  });

  it('PATCH /staff/:id with invalid body -> 422 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/staff/${OWNER_STAFF_ID}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ active: 'nope' }); // not a boolean
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH /staff/:id deactivating the owner -> 403 FORBIDDEN', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/staff/${OWNER_STAFF_ID}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ active: false });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
