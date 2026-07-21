import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateStaffDto,
  UpdateStaffDto,
  Staff,
  StaffListResponse,
  PLAN_ID_VALUES,
  PlanId,
} from '../shared';
import {
  assertVersion,
  uuidv7,
  ForbiddenAppException,
  NotFoundAppException,
  PlanRequiredException,
} from '../common';

/**
 * Staff (team members) service. Tenant-scoped by the JWT businessId. Owner-only surface.
 * Seat usage is derived from the business's plan (Plan.staffSeats: starter 0 / market 1 /
 * business 5 / wholesale 15 / enterprise -1 unlimited). seatsUsed counts non-owner ACTIVE staff.
 */
@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /staff — members (owner first) + derived seat usage. */
  async list(businessId: string): Promise<StaffListResponse> {
    // 'owner' < 'staff' alphabetically, so role asc renders the owner first.
    const rows = await this.prisma.staff.findMany({
      where: { businessId },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });
    const seatCap = await this.seatCap(businessId);
    const seatsUsed = this.countSeatsUsed(rows);
    return { data: rows as unknown as Staff[], seatCap, seatsUsed };
  }

  /**
   * POST /staff — invite a member. role is coerced to 'staff' (owner is unique).
   * Seat-cap enforced: when the plan's seatCap is finite and already reached ->
   * 403 PLAN_REQUIRED { requiredPlan: <next plan up> }. Idempotent on the
   * (businessId, phone) natural key: a re-invite of the same phone returns the existing row.
   */
  async invite(businessId: string, dto: CreateStaffDto): Promise<Staff> {
    // Idempotent-friendly: same phone within the business returns the existing member.
    const existing = await this.prisma.staff.findUnique({
      where: { businessId_phone: { businessId, phone: dto.phone } },
    });
    if (existing) return existing as unknown as Staff;

    const [seatCap, currentRows] = await Promise.all([
      this.seatCap(businessId),
      this.prisma.staff.findMany({ where: { businessId } }),
    ]);
    const seatsUsed = this.countSeatsUsed(currentRows);
    if (seatCap !== -1 && seatsUsed >= seatCap) {
      throw new PlanRequiredException(
        this.nextPlanUp(await this.plan(businessId)),
        'Staff seat limit reached for your plan',
      );
    }

    const created = await this.prisma.staff.create({
      data: {
        id: uuidv7(),
        businessId,
        name: dto.name ?? `Invited · ${dto.phone}`,
        phone: dto.phone,
        role: 'staff', // coerced — owner is unique
        active: true,
      },
    });
    return created as unknown as Staff;
  }

  /**
   * PATCH /staff/:id — activate/deactivate. The owner row can never be deactivated.
   * Honors optimistic concurrency (If-Match: version=N).
   */
  async setActive(
    businessId: string,
    id: string,
    dto: UpdateStaffDto,
    expectedVersion: number | null,
  ): Promise<Staff> {
    const row = await this.prisma.staff.findFirst({ where: { id, businessId } });
    if (!row) throw new NotFoundAppException('Staff member not found');

    if (row.role === 'owner' && dto.active === false) {
      throw new ForbiddenAppException('The business owner cannot be deactivated');
    }

    assertVersion(expectedVersion, row);

    const updated = await this.prisma.staff.update({
      where: { id },
      data: { active: dto.active, version: { increment: 1 } },
    });
    return updated as unknown as Staff;
  }

  // --- helpers -------------------------------------------------------------

  /** Non-owner active members occupy seats. */
  private countSeatsUsed(rows: Array<{ role: string; active: boolean }>): number {
    return rows.filter((r) => r.role !== 'owner' && r.active).length;
  }

  private async plan(businessId: string): Promise<PlanId> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { plan: true },
    });
    // Fail-closed to starter for an unknown/absent plan (conventions Entitlements).
    const plan = business?.plan;
    return (PLAN_ID_VALUES as readonly string[]).includes(plan ?? '')
      ? (plan as PlanId)
      : 'starter';
  }

  /** The plan's staffSeats limit (-1 = unlimited); fail-closed to 0 seats when unknown. */
  private async seatCap(businessId: string): Promise<number> {
    const planId = await this.plan(businessId);
    const row = await this.prisma.plan.findUnique({
      where: { id: planId },
      select: { staffSeats: true },
    });
    return row?.staffSeats ?? 0;
  }

  /** Next plan up in canonical order (starter->market->business->enterprise). */
  private nextPlanUp(current: PlanId): PlanId {
    const idx = PLAN_ID_VALUES.indexOf(current);
    return PLAN_ID_VALUES[Math.min(idx + 1, PLAN_ID_VALUES.length - 1)];
  }
}
