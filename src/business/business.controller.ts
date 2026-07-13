import { Body, Controller, Get, Headers, Put } from '@nestjs/common';
import { Business, UpdateBusinessDto } from '../shared';
import { Roles, BusinessId, parseIfMatchVersion } from '../common';
import { BusinessService } from './business.service';

/**
 * Business — the single per-tenant profile.
 *   GET /business  (owner|staff) -> current tenant's Business.
 *   PUT /business  (owner)       -> upsert profile subset for the JWT businessId.
 * Tenancy: businessId always comes from the JWT (@BusinessId), never the client body.
 */
@Controller('business')
export class BusinessController {
  constructor(private readonly business: BusinessService) {}

  @Get()
  @Roles('owner', 'staff')
  get(@BusinessId() businessId: string): Promise<Business> {
    return this.business.get(businessId);
  }

  @Put()
  @Roles('owner')
  update(
    @BusinessId() businessId: string,
    @Body() dto: UpdateBusinessDto,
    @Headers('if-match') ifMatch?: string,
  ): Promise<Business> {
    return this.business.upsert(businessId, dto, parseIfMatchVersion(ifMatch));
  }
}
