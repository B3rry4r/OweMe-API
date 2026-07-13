import { Module } from '@nestjs/common';
import { BvumController } from './bvum.controller';
import { BvumService } from './bvum.service';

/**
 * BVUM module (bvum-engine). Derived surface — owns no table; reads Debt/Payment/Business/Plan
 * via the global PrismaModule. app.module imports it as `BvumModule` from './bvum/bvum.module'.
 */
@Module({
  controllers: [BvumController],
  providers: [BvumService],
})
export class BvumModule {}
