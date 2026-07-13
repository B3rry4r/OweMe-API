import { Controller, Get } from '@nestjs/common';
import { BvumResponse } from '../shared';
import { Roles, BusinessId } from '../common';
import { BvumService } from './bvum.service';

/**
 * GET /bvum — "Business Value Under Management" for the JWT businessId (owner-only surface;
 * subscription screen). 30-day observation window; output is an upgrade RECOMMENDATION only —
 * the plan is never auto-changed (was computed client-side before this endpoint).
 */
@Controller('bvum')
export class BvumController {
  constructor(private readonly bvum: BvumService) {}

  @Get()
  @Roles('owner')
  get(@BusinessId() businessId: string): Promise<BvumResponse> {
    return this.bvum.compute(businessId);
  }
}
