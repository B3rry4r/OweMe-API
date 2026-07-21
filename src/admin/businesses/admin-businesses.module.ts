import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BvumModule } from '../../bvum/bvum.module';
import { AdminCommonModule } from '../common';
import { AdminBusinessesController } from './admin-businesses.controller';
import { AdminBusinessesService } from './admin-businesses.service';

/**
 * Business monitor feature module. Aggregated by AdminModule only. Imports the LIVE
 * BvumModule read-only for its exported BvumService, so the admin table's business
 * value and effective ceiling are the same numbers create-time enforcement uses -
 * no second implementation to drift. Exports the service so sibling admin modules
 * (business actions) can reuse the views without duplicating the derivations.
 */
@Module({
  imports: [PrismaModule, AdminCommonModule, BvumModule],
  controllers: [AdminBusinessesController],
  providers: [AdminBusinessesService],
  exports: [AdminBusinessesService],
})
export class AdminBusinessesModule {}
