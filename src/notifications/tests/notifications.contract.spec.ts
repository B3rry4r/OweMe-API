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
import { NotificationsModule } from '../notifications.module';
import { NOTIFICATION_KIND_VALUES, Role } from '../../shared';

/**
 * Notifications (contract). Boots a real Nest app with the SAME global guards
 * (JwtAuthGuard + RolesGuard as APP_GUARD), HttpExceptionFilter and ValidationPipe
 * as app.module. Seeds a business + owner + a mix of read/unread notifications, then
 * asserts the owner-only feed shape, createdAt-desc ordering, and mark-all-read.
 */
describe('Notifications (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const BUSINESS_ID = '01912ccc-dddd-7eee-8fff-notif00000001';
  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';

  const mintToken = (role: Role, businessId: string | null = BUSINESS_ID): string =>
    jwt.sign({ sub: `user-${role}`, businessId, role }, { secret: JWT_SECRET, expiresIn: '1h' });

  let ownerToken: string;

  /** Assert an object matches the Notification wire shape (key presence + types). */
  const expectNotificationShape = (n: Record<string, unknown>): void => {
    expect(typeof n.id).toBe('string');
    expect(typeof n.title).toBe('string');
    expect(typeof n.body).toBe('string');
    expect(NOTIFICATION_KIND_VALUES).toContain(n.kind);
    expect(typeof n.read).toBe('boolean');
    expect(typeof n.createdAt).toBe('string');
  };

  // Seed rows oldest->newest so the expected desc feed is the reverse.
  const seeds = [
    { id: '01912ccc-dddd-7eee-8fff-notif00000010', title: 'Welcome', kind: 'info', read: true, min: 50 },
    { id: '01912ccc-dddd-7eee-8fff-notif00000011', title: 'Payment in', kind: 'payment', read: false, min: 40 },
    { id: '01912ccc-dddd-7eee-8fff-notif00000012', title: 'Overdue debt', kind: 'overdue', read: false, min: 30 },
    { id: '01912ccc-dddd-7eee-8fff-notif00000013', title: 'Weekly insight', kind: 'insight', read: true, min: 20 },
    { id: '01912ccc-dddd-7eee-8fff-notif00000014', title: 'Reminder sent', kind: 'reminder', read: false, min: 10 },
  ];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, NotificationsModule],
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

    await prisma.notification.deleteMany({ where: { businessId: BUSINESS_ID } });
    await prisma.business.upsert({
      where: { id: BUSINESS_ID },
      create: {
        id: BUSINESS_ID,
        businessName: 'Notify Traders',
        ownerName: 'Ada Owner',
        phone: '08030000000',
        category: 'Retail',
        currency: 'NGN (₦)',
        reminderTone: 'gentle',
        plan: 'market',
      },
      update: {},
    });

    const now = Date.now();
    for (const s of seeds) {
      await prisma.notification.create({
        data: {
          id: s.id,
          businessId: BUSINESS_ID,
          title: s.title,
          body: `${s.title} body`,
          kind: s.kind,
          read: s.read,
          createdAt: new Date(now - s.min * 60_000),
        },
      });
    }

    ownerToken = mintToken('owner');
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /notifications as owner -> 200 Paginated<Notification>, createdAt desc + shape', async () => {
    const res = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect('nextCursor' in res.body).toBe(true);
    expect(res.body.data.length).toBe(seeds.length);
    res.body.data.forEach((n: Record<string, unknown>) => expectNotificationShape(n));

    // newest first — the last seed (min:10) is the most recent.
    const titles = res.body.data.map((n: Record<string, unknown>) => n.title);
    expect(titles).toEqual(['Reminder sent', 'Weekly insight', 'Overdue debt', 'Payment in', 'Welcome']);

    // strictly non-increasing createdAt
    const times = res.body.data.map((n: { createdAt: string }) => new Date(n.createdAt).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
    }
  });

  it('GET /notifications honors ?limit and returns a usable nextCursor', async () => {
    const first = await request(app.getHttpServer())
      .get('/notifications?limit=2')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(first.status).toBe(200);
    expect(first.body.data.length).toBe(2);
    expect(typeof first.body.nextCursor).toBe('string');

    const second = await request(app.getHttpServer())
      .get(`/notifications?limit=2&cursor=${first.body.nextCursor}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(second.status).toBe(200);
    expect(second.body.data.length).toBe(2);
    // no overlap with the first page
    const firstIds = first.body.data.map((n: { id: string }) => n.id);
    const secondIds = second.body.data.map((n: { id: string }) => n.id);
    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);
  });

  it('GET /notifications with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer()).get('/notifications');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('POST /notifications/mark-all-read as owner -> 204; subsequent GET all read', async () => {
    const res = await request(app.getHttpServer())
      .post('/notifications/mark-all-read')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(204);

    const list = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBe(seeds.length);
    list.body.data.forEach((n: Record<string, unknown>) => expect(n.read).toBe(true));
  });

  it('POST /notifications/mark-all-read with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer()).post('/notifications/mark-all-read');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
