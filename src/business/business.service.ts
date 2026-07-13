import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Business, UpdateBusinessDto } from '../shared';
import { assertVersion, NotFoundAppException } from '../common';

/**
 * Business (tenant profile) service. Owns ONLY the single per-tenant Business row,
 * scoped to the JWT businessId (== Business.id). Never trusts a client-sent businessId.
 * PUT is an upsert-by-businessId (create the row if missing, else update the profile subset).
 */
@Injectable()
export class BusinessService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /business — the current tenant's profile (single row). */
  async get(businessId: string): Promise<Business> {
    const row = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!row) throw new NotFoundAppException('Business profile not found');
    return row as unknown as Business;
  }

  /**
   * PUT /business — upsert the profile fields for this tenant.
   * Create the row on first call (onboarding), else update the provided subset and
   * bump version. Honors optimistic concurrency (If-Match: version=N) on updates.
   */
  async upsert(
    businessId: string,
    dto: UpdateBusinessDto,
    expectedVersion: number | null,
  ): Promise<Business> {
    const existing = await this.prisma.business.findUnique({ where: { id: businessId } });

    if (!existing) {
      // First call: create the tenant profile row. Required schema columns get
      // sensible fallbacks when the onboarding payload omits them; plan defaults to 'starter'.
      const created = await this.prisma.business.create({
        data: {
          id: businessId,
          businessName: dto.businessName,
          ownerName: dto.ownerName ?? '',
          phone: dto.phone ?? '',
          category: dto.category ?? '',
          currency: dto.currency ?? '',
          reminderTone: dto.reminderTone ?? 'gentle',
        },
      });
      return created as unknown as Business;
    }

    assertVersion(expectedVersion, existing);

    const updated = await this.prisma.business.update({
      where: { id: businessId },
      data: {
        businessName: dto.businessName,
        ...(dto.ownerName !== undefined ? { ownerName: dto.ownerName } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
        ...(dto.reminderTone !== undefined ? { reminderTone: dto.reminderTone } : {}),
        version: { increment: 1 },
      },
    });
    return updated as unknown as Business;
  }
}
