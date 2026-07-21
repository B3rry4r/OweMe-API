import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminCommonModule } from '../common';
import { AdminCreditsController } from './admin-credits.controller';
import { AdminCreditsService } from './admin-credits.service';

/**
 * Credits monitor feature module (registry AdminCreditsView). Aggregated by AdminModule
 * only. Read-only, so it takes no audit-writer dependency; it reads the live credits
 * surfaces through Prisma and the shipped catalog/weight constants by import.
 */
@Module({
  imports: [PrismaModule, AdminCommonModule],
  controllers: [AdminCreditsController],
  providers: [AdminCreditsService],
  exports: [AdminCreditsService],
})
export class AdminCreditsModule {}
