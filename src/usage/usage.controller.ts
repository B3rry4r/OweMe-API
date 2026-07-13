import { Controller, Get } from '@nestjs/common';
import { UsageResponse } from '../shared';
import { Roles, BusinessId } from '../common';
import { UsageService } from './usage.service';

/**
 * GET /usage — the ONE unified "OweMe credits" meter (used/limit) for the JWT businessId
 * (model rev 2). Owner-only surface (subscription/usage screen). Ledger lazily initialized on read.
 */
@Controller('usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  @Roles('owner')
  get(@BusinessId() businessId: string): Promise<UsageResponse> {
    return this.usage.getUsage(businessId);
  }
}
