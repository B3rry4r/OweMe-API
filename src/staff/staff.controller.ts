import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { CreateStaffDto, UpdateStaffDto, Staff, StaffListResponse } from '../shared';
import { Roles, BusinessId, parseIfMatchVersion } from '../common';
import { StaffService } from './staff.service';

/**
 * Staff — business team members. Owner-only surface; tenancy always from the JWT.
 *   GET   /staff       -> members (owner first) + derived seat usage {seatCap, seatsUsed}.
 *   POST  /staff       -> invite (role coerced to staff); seat-cap enforced -> 403 PLAN_REQUIRED.
 *   PATCH /staff/:id   -> activate/deactivate (owner row cannot be deactivated).
 */
@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @Roles('owner')
  list(@BusinessId() businessId: string): Promise<StaffListResponse> {
    return this.staff.list(businessId);
  }

  @Post()
  @Roles('owner')
  @HttpCode(201)
  invite(@BusinessId() businessId: string, @Body() dto: CreateStaffDto): Promise<Staff> {
    return this.staff.invite(businessId, dto);
  }

  @Patch(':id')
  @Roles('owner')
  setActive(
    @BusinessId() businessId: string,
    @Param('id') id: string,
    @Body() dto: UpdateStaffDto,
    @Headers('if-match') ifMatch?: string,
  ): Promise<Staff> {
    return this.staff.setActive(businessId, id, dto, parseIfMatchVersion(ifMatch));
  }
}
