import { Injectable } from '@nestjs/common';
import { Plan, PlanId } from '../shared';
import { PrismaService } from '../prisma/prisma.service';

/** Row shape returned by Prisma for the Plan model (limits flattened, features as JSON). */
interface PlanRow {
  id: string;
  name: string;
  pricePerMonth: number;
  tagline: string;
  features: unknown; // Prisma Json — string[] once deserialized
  productId: string | null;
  talkToSales: boolean;
  recommended: boolean;
  creditsPerMonth: number;
  staffSeats: number;
  bvumCeiling: bigint | null; // BigInt column; serialized to number (< 2^53) for the wire
}

/**
 * Server-authoritative plan/pricing catalog (replaces the frontend's inline kPlans/_tiers).
 * Reads the seeded Plan table and maps flat rows to the shared Plan shape (nested limits,
 * features deserialized to string[]). Reference/catalog resource — not tenant-scoped.
 */
@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<Plan[]> {
    const rows = (await this.prisma.plan.findMany({
      orderBy: { pricePerMonth: 'asc' },
    })) as unknown as PlanRow[];
    return rows.map((r) => this.toPlan(r));
  }

  private toPlan(r: PlanRow): Plan {
    return {
      id: r.id as PlanId,
      name: r.name,
      pricePerMonth: r.pricePerMonth,
      tagline: r.tagline,
      features: this.toFeatures(r.features),
      productId: r.productId,
      talkToSales: r.talkToSales,
      recommended: r.recommended,
      limits: {
        creditsPerMonth: r.creditsPerMonth,
        staffSeats: r.staffSeats,
        bvumCeiling: r.bvumCeiling === null ? null : Number(r.bvumCeiling),
      },
    };
  }

  /** Prisma deserializes the Json column already; parse defensively if a raw string arrives. */
  private toFeatures(value: unknown): string[] {
    if (Array.isArray(value)) return value.map((v) => String(v));
    if (typeof value === 'string') {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
    }
    return [];
  }
}
