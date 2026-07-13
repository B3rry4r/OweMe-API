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
import { NotificationPreferencesModule } from '../notification-preferences.module';
import { Role } from '../../shared';

/**
 * NotificationPreferences (contract). Boots a real Nest app with the SAME global
 * guards (JwtAuthGuard + RolesGuard as APP_GUARD), HttpExceptionFilter and
 * ValidationPipe as app.module. A Business tenant + owner are seeded via Prisma;
 * owner/staff JWTs are minted with the JwtStrategy's secret. Asserts SHAPES.
 */
describe('NotificationPreferences (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  // Distinctive tenant id so this suite never collides with other waves' seeded rows.
  const BUSINESS_ID = '01912aaa-bbbb-7ccc-8ddd-notifpref001';
  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';

  const mintToken = (role: Role, businessId: string | null = BUSINESS_ID): string =>
    jwt.sign({ sub: `user-${role}`, businessId, role }, { secret: JWT_SECRET, expiresIn: '1h' });

  let ownerToken: string;
  let staffToken: string;

  /** Assert an object matches the NotificationPreferences wire shape. */
  const expectPrefsShape = (p: Record<string, unknown>): void => {
    expect(typeof p.businessId).toBe('string');
    expect(typeof p.payments).toBe('boolean');
    expect(typeof p.overdue).toBe('boolean');
    expect(typeof p.delivery).toBe('boolean');
    expect(typeof p.weekly).toBe('boolean');
    expect(typeof p.updatedAt).toBe('string');
    expect(typeof p.version).toBe('number');
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, NotificationPreferencesModule],
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

    // Prefs row FKs to Business — seed the tenant + owner first. Clean any stale prefs row.
    await prisma.notificationPreferences.deleteMany({ where: { businessId: BUSINESS_ID } });
    await prisma.business.upsert({
      where: { id: BUSINESS_ID },
      create: {
        id: BUSINESS_ID,
        businessName: 'Prefs Traders',
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

  it('GET as owner (first call) -> 200 lazily-created defaults', async () => {
    const res = await request(app.getHttpServer())
      .get('/notification-preferences')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expectPrefsShape(res.body);
    expect(res.body.businessId).toBe(BUSINESS_ID);
    expect(res.body.payments).toBe(true);
    expect(res.body.overdue).toBe(true);
    expect(res.body.delivery).toBe(true);
    expect(res.body.weekly).toBe(false);
  });

  it('PUT as owner {weekly:true,...} -> 200 updated; subsequent GET reflects it', async () => {
    const put = await request(app.getHttpServer())
      .put('/notification-preferences')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ payments: false, overdue: true, delivery: false, weekly: true });
    expect(put.status).toBe(200);
    expectPrefsShape(put.body);
    expect(put.body.payments).toBe(false);
    expect(put.body.overdue).toBe(true);
    expect(put.body.delivery).toBe(false);
    expect(put.body.weekly).toBe(true);
    expect(put.body.businessId).toBe(BUSINESS_ID); // tenancy from JWT

    const get = await request(app.getHttpServer())
      .get('/notification-preferences')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(get.status).toBe(200);
    expect(get.body.payments).toBe(false);
    expect(get.body.overdue).toBe(true);
    expect(get.body.delivery).toBe(false);
    expect(get.body.weekly).toBe(true);
  });

  it('PUT with invalid body (non-boolean) -> 422 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .put('/notification-preferences')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ payments: 'yes', overdue: true, delivery: true, weekly: false });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PUT as staff -> 403 FORBIDDEN', async () => {
    const res = await request(app.getHttpServer())
      .put('/notification-preferences')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ payments: true, overdue: true, delivery: true, weekly: false });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('GET as staff -> 403 FORBIDDEN (owner-only surface)', async () => {
    const res = await request(app.getHttpServer())
      .get('/notification-preferences')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('GET with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer()).get('/notification-preferences');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('PUT with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer())
      .put('/notification-preferences')
      .send({ payments: true, overdue: true, delivery: true, weekly: false });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
