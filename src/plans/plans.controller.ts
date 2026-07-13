import { Controller, Get } from '@nestjs/common';
import { Plan } from '../shared';
import { Roles } from '../common';
import { PlansService } from './plans.service';

/** GET /plans — server-authoritative plan/pricing catalog (owner|staff authenticated). */
@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @Roles('owner', 'staff')
  list(): Promise<Plan[]> {
    return this.plans.list();
  }
}
