import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlanId } from '../../shared';
import { REQUIRES_PLAN_KEY, MeterSpec, METERED_KEY } from '../decorators/entitlements.decorator';

/**
 * SKELETON. Reads @RequiresPlan()/@Metered() metadata. Build agents fill the policy
 * (look up the business's plan + ledgers, then throw PlanRequiredException when a
 * capability is gated or an allowance/credit is exhausted).
 *
 * As shipped it is a no-op pass-through (does NOT block) so the app compiles and
 * contract tests run before the entitlement policy exists. It is wired per-route by
 * feature modules, not registered globally.
 */
@Injectable()
export class EntitlementsGuard implements CanActivate {
  constructor(protected readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPlan = this.reflector.getAllAndOverride<PlanId | undefined>(REQUIRES_PLAN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const meter = this.reflector.getAllAndOverride<MeterSpec | undefined>(METERED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No policy declared -> allow. Policy (plan/ledger checks) is filled by build agents,
    // which subclass this guard or replace canActivate. Throw PlanRequiredException to block.
    void requiredPlan;
    void meter;
    return true;
  }
}
