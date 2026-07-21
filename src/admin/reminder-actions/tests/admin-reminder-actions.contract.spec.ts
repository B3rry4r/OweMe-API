import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { PrismaModule } from '../../../prisma/prisma.module';
import { PrismaService } from '../../../prisma/prisma.service';
import { CommonModule } from '../../../common/common.module';
import { HttpExceptionFilter } from '../../../common/filters/http-exception.filter';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import {
  MESSAGE_SENDER,
  MessageSender,
  OTP_SENDER,
  OtpSender,
  SendMessageInput,
  SendMessageResult,
  uuidv7,
} from '../../../common';
import { AuthModule } from '../../../auth/auth.module';
import { currentPeriodStart } from '../../../usage/period.util';
import { CREDIT_WEIGHTS } from '../../../usage/credit-ledger.service';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { hashPassword } from '../../common';
import { AdminReminderActionsModule } from '../admin-reminder-actions.module';

// Admin secrets are env-driven with no insecure fallback; specs boot with explicit
// test values, mirroring how test/setenv.ts boots the user-auth specs.
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'test-admin-access-secret';
process.env.ADMIN_JWT_REFRESH_SECRET =
  process.env.ADMIN_JWT_REFRESH_SECRET ?? 'test-admin-refresh-secret';

/** Spy OtpSender so the spec can mint a REAL user session for cross-rejection. */
class SpyOtpSender implements OtpSender {
  readonly codes = new Map<string, string>();
  async sendOtp(phone: string, code: string): Promise<void> {
    this.codes.set(phone, code);
  }
}

/** Spy MessageSender: proves whether a retry really dispatched, and to whom. */
class SpyMessageSender implements MessageSender {
  readonly sent: SendMessageInput[] = [];
  async send(input: SendMessageInput): Promise<SendMessageResult> {
    this.sent.push(input);
    return { providerMessageId: `spy-${this.sent.length}`, accepted: true };
  }
}

/**
 * AdminReminderActions (contract). Same boot as app.module (global user guards,
 * ValidationPipe, HttpExceptionFilter) plus admin auth and this resource, which the
 * integrator later aggregates into AdminModule.
 *
 * Covers: the auth gate (no token, user token, garbage, disabled admin), the registry
 * role gate (superadmin AND support may retry), the cross-tenant happy path asserting
 * BOTH the row transition and the audit row, the unmetered-channel path, all three
 * refusals (404, 422 not-failed, 422 whatsapp, 403 PLAN_REQUIRED) proving nothing is
 * debited, dispatched or audit-logged, and re-run safety on a repeated retry.
 */
describe('AdminReminderActions (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const otp = new SpyOtpSender();
  const sender = new SpyMessageSender();

  const ROOT_EMAIL = 'root-reminder-actions@oweme.app';
  const ROOT_PASSWORD = 'RootPass!2026';
  const SUPPORT_EMAIL = 'support-reminder-actions@oweme.app';
  const SUPPORT_PASSWORD = 'SupportPass!1';
  const USER_PHONE = '2348039990088';
  let rootAccess: string;
  let supportAccess: string;
  let userAccess: string;

  // Tenant A: healthy balance. Tenant B: the cross-tenant target. Tenant C: out of credits.
  const BUSINESS_A = uuidv7();
  const BUSINESS_B = uuidv7();
  const BUSINESS_C = uuidv7();
  const CUSTOMER_A = uuidv7();
  const CUSTOMER_B = uuidv7();
  const CUSTOMER_C = uuidv7();
  const DEBT_A = uuidv7();
  const DEBT_B = uuidv7();
  const DEBT_C = uuidv7();

  const PHONE_A = '08031112222';
  const PHONE_B = '08031113333';
  const PHONE_C = '08031114444';

  const START_BALANCE_A = 40;
  const START_BALANCE_B = 20;
  const START_BALANCE_C = CREDIT_WEIGHTS.reminderSend - 1;

  const login = async (email: string, password: string) =>
    request(app.getHttpServer()).post('/admin/auth/login').send({ email, password });

  const retry = async (id: string, token: string = rootAccess) =>
    request(app.getHttpServer())
      .post(`/admin/reminders/${id}/retry`)
      .set('Authorization', `Bearer ${token}`);

  const balanceOf = async (businessId: string): Promise<number> => {
    const ledger = await prisma.creditLedger.findUnique({ where: { businessId } });
    return ledger?.balance ?? 0;
  };

  const auditRowsFor = async (reminderId: string) =>
    prisma.adminAuditLog.findMany({
      where: { targetType: 'Reminder', targetId: reminderId },
      orderBy: { createdAt: 'asc' },
    });

  const seedReminder = async (
    businessId: string,
    debtId: string,
    channel: string,
    status: string,
  ): Promise<string> => {
    const id = uuidv7();
    await prisma.reminder.create({
      data: {
        id,
        businessId,
        debtId,
        channel,
        status,
        message: 'Please settle your balance. Thank you.',
        sentAt: status === 'sent' ? new Date('2026-07-01T09:00:00.000Z') : null,
      },
    });
    return id;
  };

  const seedTenant = async (
    businessId: string,
    businessName: string,
    ownerPhone: string,
    customerId: string,
    customerPhone: string,
    debtId: string,
    balance: number,
  ): Promise<void> => {
    await prisma.business.create({
      data: {
        id: businessId,
        businessName,
        ownerName: 'Owner',
        phone: ownerPhone,
        category: 'Retail',
        currency: 'NGN (₦)',
        reminderTone: 'friendly',
        plan: 'starter',
      },
    });
    await prisma.creditLedger.create({
      data: { businessId, balance, monthlyGrant: 50, periodStart: currentPeriodStart() },
    });
    await prisma.customer.create({
      data: { id: customerId, businessId, name: 'Adaeze Umeh', phone: customerPhone },
    });
    await prisma.debt.create({
      data: { id: debtId, businessId, customerId, amount: 100_000 },
    });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // AdminReminderActionsModule is imported explicitly: the integrator aggregates it
      // into AdminModule after this wave, so the spec must not depend on that edit landing.
      imports: [PrismaModule, CommonModule, AuthModule, AdminAuthModule, AdminReminderActionsModule],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(OTP_SENDER)
      .useValue(otp)
      .overrideProvider(MESSAGE_SENDER)
      .useValue(sender)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    prisma = app.get(PrismaService);
    await app.init();

    await prisma.adminAuditLog.deleteMany({});
    await prisma.adminRefreshToken.deleteMany({});
    await prisma.adminUser.deleteMany({});
    for (const [email, name, role, password] of [
      [ROOT_EMAIL, 'Actions Root', 'superadmin', ROOT_PASSWORD],
      [SUPPORT_EMAIL, 'Actions Support', 'support', SUPPORT_PASSWORD],
    ]) {
      await prisma.adminUser.create({
        data: {
          id: uuidv7(),
          email,
          name,
          passwordHash: hashPassword(password),
          role,
          status: 'active',
          mustChangePassword: false,
        },
      });
    }
    rootAccess = (await login(ROOT_EMAIL, ROOT_PASSWORD)).body.accessToken as string;
    supportAccess = (await login(SUPPORT_EMAIL, SUPPORT_PASSWORD)).body.accessToken as string;

    // A REAL user session, to prove a user token cannot act on the admin surface.
    await request(app.getHttpServer()).post('/auth/request-otp').send({ phone: USER_PHONE });
    const userSession = await request(app.getHttpServer())
      .post('/auth/verify-otp')
      .send({ phone: USER_PHONE, code: otp.codes.get(USER_PHONE)! });
    userAccess = userSession.body.accessToken as string;

    await seedTenant(
      BUSINESS_A,
      'Mama Nkechi Provisions',
      '2348031112222',
      CUSTOMER_A,
      PHONE_A,
      DEBT_A,
      START_BALANCE_A,
    );
    await seedTenant(
      BUSINESS_B,
      'Okoro Electronics',
      '2348022223333',
      CUSTOMER_B,
      PHONE_B,
      DEBT_B,
      START_BALANCE_B,
    );
    await seedTenant(
      BUSINESS_C,
      'Sandbox Kitchen',
      '2348099998888',
      CUSTOMER_C,
      PHONE_C,
      DEBT_C,
      START_BALANCE_C,
    );
  });

  afterAll(async () => {
    const businessIds = [BUSINESS_A, BUSINESS_B, BUSINESS_C];
    await prisma.adminAuditLog.deleteMany({});
    await prisma.reminder.deleteMany({ where: { businessId: { in: businessIds } } });
    await prisma.debt.deleteMany({ where: { businessId: { in: businessIds } } });
    await prisma.customer.deleteMany({ where: { businessId: { in: businessIds } } });
    await prisma.creditLedger.deleteMany({ where: { businessId: { in: businessIds } } });
    await prisma.business.deleteMany({ where: { id: { in: businessIds } } });
    await prisma.adminRefreshToken.deleteMany({});
    await prisma.adminUser.deleteMany({});
    await app.close();
  });

  describe('auth gate', () => {
    let target: string;

    beforeAll(async () => {
      target = await seedReminder(BUSINESS_A, DEBT_A, 'sms', 'failed');
    });

    it('no token -> 401 UNAUTHENTICATED and nothing happens', async () => {
      const res = await request(app.getHttpServer()).post(`/admin/reminders/${target}/retry`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('garbage token and a valid USER token -> 401', async () => {
      for (const token of ['not-a-token', userAccess]) {
        const res = await retry(target, token);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('a disabled admin loses access immediately -> 401', async () => {
      await prisma.adminUser.update({
        where: { email: SUPPORT_EMAIL },
        data: { status: 'disabled' },
      });
      const res = await retry(target, supportAccess);
      expect(res.status).toBe(401);
      await prisma.adminUser.update({
        where: { email: SUPPORT_EMAIL },
        data: { status: 'active' },
      });
    });

    it('leaves the row failed and the ledger untouched after every rejection', async () => {
      const row = await prisma.reminder.findUnique({ where: { id: target } });
      expect(row?.status).toBe('failed');
      expect(await balanceOf(BUSINESS_A)).toBe(START_BALANCE_A);
      expect(await auditRowsFor(target)).toHaveLength(0);
      expect(sender.sent).toHaveLength(0);
    });
  });

  describe('POST /admin/reminders/:id/retry - sms happy path', () => {
    let target: string;

    beforeAll(async () => {
      target = await seedReminder(BUSINESS_A, DEBT_A, 'sms', 'failed');
    });

    it('re-dispatches, debits 5 credits and returns the AdminReminderView', async () => {
      const before = await prisma.reminder.findUnique({ where: { id: target } });
      const dispatchedBefore = sender.sent.length;

      const res = await retry(target);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: target,
        businessName: 'Mama Nkechi Provisions',
        channel: 'sms',
        step: null,
        scheduledFor: null,
        sentAt: expect.any(String),
        status: 'sent',
        costKoboEstimate: null,
      });

      // State change: the row itself.
      const after = await prisma.reminder.findUnique({ where: { id: target } });
      expect(after?.status).toBe('sent');
      expect(after?.sentAt).not.toBeNull();
      expect(after?.version).toBe((before?.version ?? 0) + 1);

      // State change: the target tenant's ledger, and a REAL dispatch to the debtor.
      expect(await balanceOf(BUSINESS_A)).toBe(START_BALANCE_A - CREDIT_WEIGHTS.reminderSend);
      expect(sender.sent).toHaveLength(dispatchedBefore + 1);
      expect(sender.sent[dispatchedBefore]).toEqual({
        phone: PHONE_A,
        message: 'Please settle your balance. Thank you.',
        channel: 'sms',
      });
    });

    it('wrote exactly one audit row carrying the truthful before/after', async () => {
      const rows = await auditRowsFor(target);
      expect(rows).toHaveLength(1);
      const entry = rows[0];
      expect(entry.actionType).toBe('retry-reminder');
      expect(entry.adminNameSnapshot).toBe('Actions Root');
      expect(entry.adminRoleSnapshot).toBe('superadmin');
      expect(entry.action).toContain('Mama Nkechi Provisions');
      expect(entry.targetBusinessId).toBe(BUSINESS_A);
      expect(entry.before).toMatchObject({ status: 'failed', sentAt: null });
      expect(entry.after).toMatchObject({
        status: 'sent',
        creditsDebited: CREDIT_WEIGHTS.reminderSend,
        smsDispatched: true,
      });
    });

    it('re-running the same retry is refused, never debited or dispatched twice', async () => {
      const dispatchedBefore = sender.sent.length;
      const res = await retry(target);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');

      expect(await balanceOf(BUSINESS_A)).toBe(START_BALANCE_A - CREDIT_WEIGHTS.reminderSend);
      expect(sender.sent).toHaveLength(dispatchedBefore);
      expect(await auditRowsFor(target)).toHaveLength(1);
    });
  });

  describe('cross-tenant reach and the support role gate', () => {
    it('support retries a reminder in ANOTHER tenant, debiting THAT tenant', async () => {
      const target = await seedReminder(BUSINESS_B, DEBT_B, 'sms', 'failed');
      const balanceABefore = await balanceOf(BUSINESS_A);

      const res = await retry(target, supportAccess);
      expect(res.status).toBe(200);
      expect(res.body.businessName).toBe('Okoro Electronics');
      expect(res.body.status).toBe('sent');

      expect(await balanceOf(BUSINESS_B)).toBe(START_BALANCE_B - CREDIT_WEIGHTS.reminderSend);
      expect(await balanceOf(BUSINESS_A)).toBe(balanceABefore);
      expect(sender.sent[sender.sent.length - 1].phone).toBe(PHONE_B);

      const rows = await auditRowsFor(target);
      expect(rows).toHaveLength(1);
      expect(rows[0].adminRoleSnapshot).toBe('support');
      expect(rows[0].targetBusinessId).toBe(BUSINESS_B);
    });
  });

  describe('unmetered channels', () => {
    it('a failed call reminder is marked sent with no debit and no dispatch', async () => {
      const target = await seedReminder(BUSINESS_A, DEBT_A, 'call', 'failed');
      const balanceBefore = await balanceOf(BUSINESS_A);
      const dispatchedBefore = sender.sent.length;

      const res = await retry(target);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('sent');
      expect(res.body.channel).toBe('call');

      expect(await balanceOf(BUSINESS_A)).toBe(balanceBefore);
      expect(sender.sent).toHaveLength(dispatchedBefore);

      const rows = await auditRowsFor(target);
      expect(rows).toHaveLength(1);
      expect(rows[0].after).toMatchObject({ creditsDebited: 0, smsDispatched: false });
    });
  });

  describe('refusals', () => {
    it('an unknown id -> 404 NOT_FOUND with no audit row', async () => {
      const missing = uuidv7();
      const res = await retry(missing);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(await auditRowsFor(missing)).toHaveLength(0);
    });

    it('a row that is not failed -> 422, unchanged and unlogged', async () => {
      const target = await seedReminder(BUSINESS_A, DEBT_A, 'sms', 'sent');
      const balanceBefore = await balanceOf(BUSINESS_A);
      const dispatchedBefore = sender.sent.length;

      const res = await retry(target);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');

      const row = await prisma.reminder.findUnique({ where: { id: target } });
      expect(row?.status).toBe('sent');
      expect(row?.version).toBe(0);
      expect(await balanceOf(BUSINESS_A)).toBe(balanceBefore);
      expect(sender.sent).toHaveLength(dispatchedBefore);
      expect(await auditRowsFor(target)).toHaveLength(0);
    });

    it('a failed WHATSAPP row -> 422 (no server WhatsApp API), row stays failed', async () => {
      const target = await seedReminder(BUSINESS_A, DEBT_A, 'whatsapp', 'failed');
      const balanceBefore = await balanceOf(BUSINESS_A);
      const dispatchedBefore = sender.sent.length;

      const res = await retry(target);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('WhatsApp');

      const row = await prisma.reminder.findUnique({ where: { id: target } });
      expect(row?.status).toBe('failed');
      // No silent SMS fallback: nothing left the server.
      expect(await balanceOf(BUSINESS_A)).toBe(balanceBefore);
      expect(sender.sent).toHaveLength(dispatchedBefore);
      expect(await auditRowsFor(target)).toHaveLength(0);
    });

    it('an out-of-credits tenant -> 403 PLAN_REQUIRED and the row stays failed', async () => {
      const target = await seedReminder(BUSINESS_C, DEBT_C, 'sms', 'failed');
      const dispatchedBefore = sender.sent.length;

      const res = await retry(target);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PLAN_REQUIRED');
      expect(typeof res.body.error.requiredPlan).toBe('string');

      const row = await prisma.reminder.findUnique({ where: { id: target } });
      expect(row?.status).toBe('failed');
      expect(await balanceOf(BUSINESS_C)).toBe(START_BALANCE_C);
      expect(sender.sent).toHaveLength(dispatchedBefore);
      expect(await auditRowsFor(target)).toHaveLength(0);
    });

    it('the refused row can still be retried once the tenant has credits again', async () => {
      const target = await seedReminder(BUSINESS_C, DEBT_C, 'sms', 'failed');
      await prisma.creditLedger.update({
        where: { businessId: BUSINESS_C },
        data: { balance: 50 },
      });

      const res = await retry(target);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('sent');
      expect(await balanceOf(BUSINESS_C)).toBe(50 - CREDIT_WEIGHTS.reminderSend);
      expect(await auditRowsFor(target)).toHaveLength(1);
    });
  });
});
