import { Controller, Get } from '@nestjs/common';
import { UsageResponse } from '../shared';
import { Roles, BusinessId } from '../common';
import { UsageService } from './usage.service';

/**
 * GET /usage — both metering meters (send allowance + AI credits) for the JWT businessId.
 * Owner-only surface (subscription/usage screen). Ledgers are lazily initialized on read.
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
