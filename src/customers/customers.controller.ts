import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ActivityItem,
  CreateCustomerDto,
  Customer,
  CustomerView,
  ListCustomersQueryDto,
  Paginated,
} from '../shared';
import { BusinessId, Roles } from '../common';
import { CustomersService } from './customers.service';

/**
 * Customers — the debtor roster. Tenant-scoped from the JWT businessId.
 *   GET    /customers            -> Paginated<CustomerView> (filter/sort/q + cursor). owner|staff
 *   GET    /customers/:id        -> CustomerView (404 if not in tenant).            owner|staff
 *   POST   /customers            -> 201 Customer (200 + existing when idempotent).  owner|staff
 *   DELETE /customers/:id        -> Customer; cascade soft-archives debts.          OWNER-only
 *   GET    /customers/:id/activity -> ActivityItem[] (payments+debts+reminders).    owner|staff
 *   GET    /customers/:id/risk   -> 501 scaffold (debits 5 AI credits when live).   owner|staff
 */
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @Roles('owner', 'staff')
  list(
    @BusinessId() businessId: string,
    @Query() query: ListCustomersQueryDto,
  ): Promise<Paginated<CustomerView>> {
    return this.customers.list(businessId, query);
  }

  @Get(':id')
  @Roles('owner', 'staff')
  getOne(@BusinessId() businessId: string, @Param('id') id: string): Promise<CustomerView> {
    return this.customers.getOne(businessId, id);
  }

  @Post()
  @Roles('owner', 'staff')
  async create(
    @BusinessId() businessId: string,
    @Body() dto: CreateCustomerDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Customer> {
    const { customer, created } = await this.customers.create(businessId, dto);
    res.status(created ? 201 : 200); // idempotent re-POST returns the existing row (200)
    return customer;
  }

  @Delete(':id')
  @Roles('owner')
  remove(@BusinessId() businessId: string, @Param('id') id: string): Promise<Customer> {
    return this.customers.remove(businessId, id);
  }

  @Get(':id/activity')
  @Roles('owner', 'staff')
  activity(@BusinessId() businessId: string, @Param('id') id: string): Promise<ActivityItem[]> {
    return this.customers.activity(businessId, id);
  }

  @Get(':id/risk')
  @Roles('owner', 'staff')
  risk(): never {
    // 501 scaffold (sourceScreens: []). When live: debits 5 AI credits behind LlmProvider.
    throw new HttpException('Customer risk scoring is not implemented yet', 501);
  }
}
