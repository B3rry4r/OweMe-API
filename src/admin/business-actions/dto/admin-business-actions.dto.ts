import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { PLAN_ID_VALUES, PlanId } from '../../../shared';

/** Registry AdminBusinessActions POST /admin/businesses/:id/test-flag body, verbatim. */
export class AdminTestFlagDto {
  @IsBoolean()
  isTest!: boolean;
}

/** Registry AdminBusinessActions POST /admin/businesses/:id/grant-credits body, verbatim. */
export class AdminGrantCreditsDto {
  /** Unified OweMe credits to ADD (never an absolute balance). */
  @IsInt()
  @Min(1)
  credits!: number;
}

/** Registry AdminBusinessActions POST /admin/businesses/:id/force-plan body, verbatim. */
export class AdminForcePlanDto {
  @IsIn(PLAN_ID_VALUES)
  plan!: PlanId;
}

/** Registry AdminBusinessActions POST /admin/businesses/:id/enterprise-bands body, verbatim. */
export class AdminEnterpriseBandsDto {
  /** Bands ABOVE the enterprise base ceiling; 0 clears the banding back to base. */
  @IsInt()
  @Min(0)
  extraBands!: number;
}

/** Registry AdminBusinessActions POST /admin/businesses/:id/reset-test body, verbatim. */
export class AdminResetTestBusinessDto {
  /** Must equal the target business name exactly; a typed confirmation, not a token. */
  @IsString()
  @IsNotEmpty()
  confirm!: string;
}

/** Registry AdminBusinessActions POST /admin/businesses/:id/suspend body, verbatim. */
export class AdminSuspendBusinessDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  note?: string;
}
