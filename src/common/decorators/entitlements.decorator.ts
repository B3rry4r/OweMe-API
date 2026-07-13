import { SetMetadata } from '@nestjs/common';
import { PlanId } from '../../shared';

export const REQUIRES_PLAN_KEY = 'requiresPlan';
export const METERED_KEY = 'metered';

/** Minimum plan required to access a route. Policy enforced by EntitlementsGuard. */
export const RequiresPlan = (plan: PlanId) => SetMetadata(REQUIRES_PLAN_KEY, plan);

/** Kinds of metered spend a route consumes (allowance sends / AI credits). */
export type MeterKind = 'send' | 'ai-credit';

export interface MeterSpec {
  meter: MeterKind;
  /** weight/cost (e.g. voice=1, insight/risk=5); default 1. */
  cost?: number;
}

/** Declares a route consumes a metered resource. Debit policy filled by build agents (debit-on-success). */
export const Metered = (meter: MeterKind, cost = 1) =>
  SetMetadata(METERED_KEY, { meter, cost } as MeterSpec);
