import { Controller, Get } from '@nestjs/common';
import { Roles, BusinessId } from '../common';
import { InsightsService } from './insights.service';

/**
 * Insights — AI dashboard insight slot. Owner-only surface; tenancy always from the JWT.
 *   GET /insights/dashboard -> 501 NOT IMPLEMENTED (scaffold; screens rendering it are stubs).
 *
 * Auth + role are enforced by the global JwtAuthGuard + RolesGuard BEFORE the 501:
 *   - no token  -> 401 UNAUTHENTICATED
 *   - staff     -> 403 FORBIDDEN
 *   - owner     -> 501 (ErrorEnvelope-shaped)
 */
@Controller('insights')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get('dashboard')
  @Roles('owner')
  dashboard(@BusinessId() businessId: string): never {
    return this.insights.getDashboard(businessId);
  }
}
