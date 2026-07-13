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
import { Role } from '../../shared';
import { SyncModule } from '../sync.module';

/**
 * Sync (contract). Boots a real Nest app with the SAME global guards (JwtAuthGuard + RolesGuard),
 * HttpExceptionFilter and ValidationPipe as app.module. Seeds a tenant with customers/debts/
 * payments/reminders (one debt soft-deleted) and asserts the offline-first delta-pull contract:
 *   - GET /sync (no cursor) -> 200 { changes across all 4 entities, tombstones.debts has the
 *     soft-deleted debt id, cursor set }.
 *   - GET /sync?since=<cursor> -> only rows changed AFTER that cursor (delta behaviour).
 *   - GET /sync/status -> 200 { lastSyncedAt, pendingCount:0 }. No token -> 401.
 * Asserts SHAPES + delta behaviour, never snapshots.
 */
describe('Sync (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const BID = '01912ddd-aaaa-7eee-8fff-sync000000001';
  const OTHER_BID = '01912ddd-aaaa-7eee-8fff-sync000000999';
  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';

  const mint = (role: Role, businessId: string | null = BID): string =>
    jwt.sign({ sub: `user-${role}`, businessId, role }, { secret: JWT_SECRET, expiresIn: '1h' });

  let ownerToken: string;

  const CUST = '01912ddd-0000-7000-8000-sync0000000c1';
  const DEBT_LIVE = '01912ddd-0000-7000-8000-sync000000d01';
  const DEBT_DELETED = '01912ddd-0000-7000-8000-sync000000d02';
  const PAYMENT = '01912ddd-0000-7000-8000-sync000000p01';
  const REMINDER = '01912ddd-0000-7000-8000-sync000000r01';

  // A customer in ANOTHER tenant — must never leak into BID's sync.
  const OTHER_CUST = '01912ddd-0000-7000-8000-sync00000oc1';

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const expectCustomerShape = (c: Record<string, unknown>): void => {
    expect(typeof c.id).toBe('string');
    expect(typeof c.businessId).toBe('string');
    expect(typeof c.name).toBe('string');
    expect(typeof c.phone).toBe('string');
    expect(c.address === null || typeof c.address === 'string').toBe(true);
    expect(c.note === null || typeof c.note === 'string').toBe(true);
    expect(typeof c.updatedAt).toBe('string');
    expect(typeof c.version).toBe('number');
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, SyncModule],
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

    // Clean any prior rows for these tenants (children first).
    for (const b of [BID, OTHER_BID]) {
      await prisma.reminder.deleteMany({ where: { businessId: b } });
      await prisma.payment.deleteMany({ where: { businessId: b } });
      await prisma.debt.deleteMany({ where: { businessId: b } });
      await prisma.customer.deleteMany({ where: { businessId: b } });
    }

    for (const [id, name] of [
      [BID, 'Sync Traders'],
      [OTHER_BID, 'Other Tenant'],
    ] as const) {
      await prisma.business.upsert({
        where: { id },
        create: {
          id,
          businessName: name,
          ownerName: 'Owner',
          phone: '08030000000',
          category: 'Retail',
          currency: 'NGN (₦)',
          reminderTone: 'gentle',
          plan: 'starter',
        },
        update: {},
      });
    }

    await prisma.customer.create({
      data: { id: CUST, businessId: BID, name: 'Amaka Debtor', phone: '08111111111' },
    });
    await prisma.customer.create({
      data: { id: OTHER_CUST, businessId: OTHER_BID, name: 'Leak Guard', phone: '08222222222' },
    });
    await prisma.debt.create({
      data: { id: DEBT_LIVE, businessId: BID, customerId: CUST, amount: 50000 },
    });
    await prisma.debt.create({
      data: { id: DEBT_DELETED, businessId: BID, customerId: CUST, amount: 30000, deleted: true },
    });
    await prisma.payment.create({
      data: { id: PAYMENT, businessId: BID, debtId: DEBT_LIVE, amount: 10000, method: 'Cash', reference: 'OWM-00001' },
    });
    await prisma.reminder.create({
      data: { id: REMINDER, businessId: BID, debtId: DEBT_LIVE, channel: 'sms', status: 'sent', sentAt: new Date() },
    });

    ownerToken = mint('owner');
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /sync with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer()).get('/sync');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('GET /sync (no cursor) -> 200 full pull: all entities, debt tombstone, cursor set', async () => {
    const res = await request(app.getHttpServer())
      .get('/sync')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);

    // shape: changes + tombstones containers with the 4 entity arrays + a string cursor
    const { changes, tombstones, cursor } = res.body;
    expect(typeof cursor).toBe('string');
    for (const key of ['customers', 'debts', 'payments', 'reminders']) {
      expect(Array.isArray(changes[key])).toBe(true);
      expect(Array.isArray(tombstones[key])).toBe(true);
    }

    // all seeded LIVE rows present in changes
    const custIds = changes.customers.map((c: Record<string, unknown>) => c.id);
    const debtIds = changes.debts.map((d: Record<string, unknown>) => d.id);
    const payIds = changes.payments.map((p: Record<string, unknown>) => p.id);
    const remIds = changes.reminders.map((r: Record<string, unknown>) => r.id);
    expect(custIds).toContain(CUST);
    expect(debtIds).toContain(DEBT_LIVE);
    expect(payIds).toContain(PAYMENT);
    expect(remIds).toContain(REMINDER);

    // entity shape check
    changes.customers.forEach(expectCustomerShape);

    // soft-deleted debt -> tombstone (by id), NOT in live changes
    expect(tombstones.debts).toContain(DEBT_DELETED);
    expect(debtIds).not.toContain(DEBT_DELETED);

    // v1 limitation: only Debt has a tombstone source; others always empty
    expect(tombstones.customers).toEqual([]);
    expect(tombstones.payments).toEqual([]);
    expect(tombstones.reminders).toEqual([]);

    // tenancy: never leaks another business's rows
    expect(custIds).not.toContain(OTHER_CUST);
    changes.customers.forEach((c: Record<string, unknown>) => expect(c.businessId).toBe(BID));
  });

  it('GET /sync?since=<cursor> -> only rows changed AFTER the cursor (delta)', async () => {
    // 1) full pull -> capture the watermark cursor
    const full = await request(app.getHttpServer())
      .get('/sync')
      .set('Authorization', `Bearer ${ownerToken}`);
    const cursor: string = full.body.cursor;

    // 2) mutate exactly one row AFTER the cursor (bumps updatedAt via @updatedAt)
    await sleep(10);
    await prisma.customer.update({
      where: { id: CUST },
      data: { note: 'touched after cursor', version: { increment: 1 } },
    });

    // 3) delta pull since the earlier cursor -> only the touched customer, nothing stale
    const delta = await request(app.getHttpServer())
      .get(`/sync?since=${encodeURIComponent(cursor)}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(delta.status).toBe(200);

    const custIds = delta.body.changes.customers.map((c: Record<string, unknown>) => c.id);
    expect(custIds).toEqual([CUST]);
    // rows untouched since the cursor are excluded
    expect(delta.body.changes.debts.map((d: Record<string, unknown>) => d.id)).not.toContain(DEBT_LIVE);
    expect(delta.body.changes.payments).toEqual([]);
    expect(delta.body.changes.reminders).toEqual([]);
    // no new deletes since the cursor
    expect(delta.body.tombstones.debts).not.toContain(DEBT_DELETED);
    // advancing cursor
    expect(typeof delta.body.cursor).toBe('string');
    expect(new Date(delta.body.cursor).getTime()).toBeGreaterThan(new Date(cursor).getTime());
  });

  it('soft-deleted customer -> id in tombstones.customers, NOT in changes.customers (since a prior cursor)', async () => {
    // seed a fresh live customer, then capture a cursor BEFORE deleting it
    const TOMB_CUST = '01912ddd-0000-7000-8000-sync0000tomb1';
    await prisma.customer.create({
      data: { id: TOMB_CUST, businessId: BID, name: 'Doomed Debtor', phone: '08333333333' },
    });
    const before = await request(app.getHttpServer())
      .get('/sync')
      .set('Authorization', `Bearer ${ownerToken}`);
    const cursor: string = before.body.cursor;
    // live customer is a normal change, no tombstone yet
    expect(before.body.changes.customers.map((c: Record<string, unknown>) => c.id)).toContain(TOMB_CUST);
    expect(before.body.tombstones.customers).not.toContain(TOMB_CUST);

    // soft-delete it (bumps updatedAt via @updatedAt) AFTER the cursor
    await sleep(10);
    await prisma.customer.update({
      where: { id: TOMB_CUST },
      data: { deleted: true, version: { increment: 1 } },
    });

    // delta pull since the earlier cursor: the id surfaces as a customer tombstone, not a change
    const delta = await request(app.getHttpServer())
      .get(`/sync?since=${encodeURIComponent(cursor)}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(delta.status).toBe(200);
    expect(delta.body.tombstones.customers).toContain(TOMB_CUST);
    expect(delta.body.changes.customers.map((c: Record<string, unknown>) => c.id)).not.toContain(TOMB_CUST);
    // the cursor advanced past the delete
    expect(new Date(delta.body.cursor).getTime()).toBeGreaterThan(new Date(cursor).getTime());
  });

  it('GET /sync/status -> 200 { lastSyncedAt, pendingCount:0 }', async () => {
    const res = await request(app.getHttpServer())
      .get('/sync/status')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.lastSyncedAt === null || typeof res.body.lastSyncedAt === 'string').toBe(true);
    expect(typeof res.body.lastSyncedAt).toBe('string'); // tenant has synced rows
    expect(res.body.pendingCount).toBe(0);
  });

  it('GET /sync/status with no token -> 401', async () => {
    const res = await request(app.getHttpServer()).get('/sync/status');
    expect(res.status).toBe(401);
  });
});
