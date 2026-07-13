import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

/**
 * Sync feature module — offline-first delta pull. Register in app.module: `SyncModule`.
 *
 * Owns no table of its own; reads the Customer/Debt/Payment/Reminder tables via PrismaService.
 * Imports:
 *   - PrismaModule for table access.
 *   - CommonModule for the global guards/tenancy helpers used by the controller.
 */
@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
