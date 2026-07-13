import { Module } from '@nestjs/common';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';

/** Plans (reference/catalog) module. PrismaService comes from the global PrismaModule. */
@Module({
  controllers: [PlansController],
  providers: [PlansService],
})
export class PlansModule {}
