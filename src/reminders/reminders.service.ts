import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateReminderDto,
  ListRemindersQueryDto,
  PAGINATION_DEFAULT_LIMIT,
  Paginated,
  Reminder,
  ReminderChannel,
  ReminderListItem,
  ReminderStatus,
} from '../shared';
import {
  ForbiddenAppException,
  MESSAGE_SENDER,
  MessageSender,
  NotFoundAppException,
  ValidationException,
} from '../common';
import { SendAllowanceService } from '../usage/send-allowance.service';

/** Channels that consume the automated-send allowance (mirrors SendAllowanceService). */
const METERED_CHANNELS: ReadonlySet<ReminderChannel> = new Set<ReminderChannel>(['sms', 'whatsapp']);

type CustomerStub = { id: string; name: string; phone: string };

type ReminderRow = {
  id: string;
  businessId: string;
  debtId: string;
  channel: string;
  status: string;
  message: string | null;
  scheduledFor: Date | null;
  sentAt: Date | null;
  payLinkUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

type ReminderRowWithJoins = ReminderRow & {
  debt: { id: string; amount: number; customer: CustomerStub };
};

/**
 * Reminders service. Tenant-scoped by the JWT businessId (owner|staff). Owns the actual
 * scheduled/sent/failed Reminder rows + (stubbed) delivery via the MESSAGE_SENDER provider.
 *
 * Metering (conventions §Metering / §Reminder engine):
 *   - sms|whatsapp are metered — an IMMEDIATE send debits the SendAllowanceLedger BEFORE the
 *     row is recorded (exhaustion -> 403 PLAN_REQUIRED, no sent row persisted).
 *   - call|manual|printable are recorded-only + FREE (never touch the ledger).
 * A future scheduledFor records a 'scheduled' row and does NOT meter/send yet (the delivery
 * worker meters at dispatch time; it MAY ship as a stub). Idempotent on the client-minted id.
 *
 * The derived reminder-SCHEDULE card (-3/due/+3/+7) is owned by the Debt module, not here.
 */
@Injectable()
export class RemindersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly allowance: SendAllowanceService,
    @Inject(MESSAGE_SENDER) private readonly sender: MessageSender,
  ) {}

  /** GET /reminders — status filter + cursor pagination; each row joined to its debt+customer. */
  async list(businessId: string, query: ListRemindersQueryDto): Promise<Paginated<ReminderListItem>> {
    const rows = (await this.prisma.reminder.findMany({
      where: { businessId, ...(query.status ? { status: query.status } : {}) },
      include: {
        debt: {
          select: {
            id: true,
            amount: true,
            customer: { select: { id: true, name: true, phone: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })) as unknown as ReminderRowWithJoins[];

    const items = rows.map((r) => this.toListItem(r));

    // --- cursor pagination (opaque base64 offset over the deterministic sorted list) ---
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;
    const offset = decodeCursor(query.cursor);
    const page = items.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    const nextCursor = nextOffset < items.length ? encodeCursor(nextOffset) : null;
    return { data: page, nextCursor };
  }

  /**
   * POST /reminders — records reminder history. Idempotent on the client-minted id (a re-seen
   * id returns the existing row, rendered 200). A future scheduledFor -> 'scheduled' (no meter/
   * send). Otherwise an immediate send: metered channels debit the allowance + dispatch via the
   * MESSAGE_SENDER stub -> 'sent'; free channels (call/manual/printable) are recorded 'sent'.
   */
  async create(
    businessId: string,
    dto: CreateReminderDto,
  ): Promise<{ reminder: Reminder; created: boolean }> {
    const existing = await this.prisma.reminder.findUnique({ where: { id: dto.id } });
    if (existing) {
      if (existing.businessId !== businessId) {
        throw new ForbiddenAppException('Reminder id already exists in another business');
      }
      return { reminder: serializeReminder(existing as unknown as ReminderRow), created: false };
    }

    const debt = await this.prisma.debt.findFirst({
      where: { id: dto.debtId, businessId },
      include: { customer: { select: { id: true, name: true, phone: true } } },
    });
    if (!debt) throw new NotFoundAppException('Debt not found in this business');

    const channel = dto.channel;
    const scheduledFor = dto.scheduledFor ? new Date(dto.scheduledFor) : null;
    const isFuture = scheduledFor !== null && scheduledFor.getTime() > Date.now();

    let status: ReminderStatus;
    let sentAt: Date | null = null;

    if (isFuture) {
      // Scheduled for later — recorded only; the (stubbed) delivery worker meters + sends at dispatch.
      status = 'scheduled';
    } else {
      // Immediate. Metered channels debit BEFORE recording (exhaustion -> 403, no row persisted).
      if (METERED_CHANNELS.has(channel)) {
        await this.allowance.debitSend(businessId, channel);
        await this.sender.send({
          phone: (debt as unknown as { customer: CustomerStub }).customer.phone,
          message: dto.message ?? defaultMessage(),
          channel: channel as 'sms' | 'whatsapp',
        });
      }
      // call/manual/printable are recorded-only + FREE (no debit, no delivery contract).
      status = 'sent';
      sentAt = new Date();
    }

    const created = (await this.prisma.reminder.create({
      data: {
        id: dto.id,
        businessId,
        debtId: dto.debtId,
        channel,
        status,
        message: dto.message ?? null,
        scheduledFor: scheduledFor,
        sentAt,
        payLinkUrl: dto.payLinkUrl ?? null,
      },
    })) as unknown as ReminderRow;

    return { reminder: serializeReminder(created), created: true };
  }

  /**
   * POST /reminders/:id/retry — failed rows only. Re-attempts delivery: metered channels debit
   * the allowance again + re-dispatch via MESSAGE_SENDER, then mark the row 'sent' (sentAt=now).
   * Non-failed rows -> 422. Exhausted allowance -> 403 PLAN_REQUIRED (row stays failed).
   */
  async retry(businessId: string, id: string): Promise<Reminder> {
    const row = (await this.prisma.reminder.findFirst({
      where: { id, businessId },
      include: {
        debt: { select: { id: true, customer: { select: { id: true, name: true, phone: true } } } },
      },
    })) as unknown as (ReminderRow & { debt: { customer: CustomerStub } }) | null;
    if (!row) throw new NotFoundAppException('Reminder not found');
    if (row.status !== 'failed') {
      throw new ValidationException('Only failed reminders can be retried');
    }

    const channel = row.channel as ReminderChannel;
    if (METERED_CHANNELS.has(channel)) {
      await this.allowance.debitSend(businessId, channel);
      await this.sender.send({
        phone: row.debt.customer.phone,
        message: row.message ?? defaultMessage(),
        channel: channel as 'sms' | 'whatsapp',
      });
    }

    const updated = (await this.prisma.reminder.update({
      where: { id },
      data: { status: 'sent', sentAt: new Date(), version: { increment: 1 } },
    })) as unknown as ReminderRow;
    return serializeReminder(updated);
  }

  // --- helpers ---------------------------------------------------------------

  private toListItem(row: ReminderRowWithJoins): ReminderListItem {
    return {
      ...serializeReminder(row),
      debt: { id: row.debt.id, amount: row.debt.amount },
      customer: {
        id: row.debt.customer.id,
        name: row.debt.customer.name,
        phone: row.debt.customer.phone,
      },
    };
  }
}

/** Fallback delivery body when the client did not supply a composed message. */
function defaultMessage(): string {
  return 'Reminder: you have an outstanding balance. Please arrange payment. Thank you.';
}

function serializeReminder(r: ReminderRow): Reminder {
  return {
    id: r.id,
    businessId: r.businessId,
    debtId: r.debtId,
    channel: r.channel as ReminderChannel,
    status: r.status as ReminderStatus,
    message: r.message,
    scheduledFor: r.scheduledFor ? r.scheduledFor.toISOString() : null,
    sentAt: r.sentAt ? r.sentAt.toISOString() : null,
    payLinkUrl: r.payLinkUrl,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    version: r.version,
  };
}

/** Opaque cursor = base64url(offset). */
function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const o = Number(parsed?.o);
    return Number.isInteger(o) && o >= 0 ? o : 0;
  } catch {
    return 0;
  }
}
