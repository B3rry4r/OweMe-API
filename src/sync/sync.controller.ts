import { Controller, Get, Query } from '@nestjs/common';
import { SyncQueryDto, SyncResponse, SyncStatusResponse } from '../shared';
import { BusinessId, Roles } from '../common';
import { SyncService } from './sync.service';

/**
 * Sync — offline-first delta pull across the four synced entities (Customer/Debt/Payment/Reminder).
 * Owns no table; tenant-scoped from the JWT businessId. Roles owner|staff.
 *   GET /sync?since=<cursor> -> { changes, tombstones, cursor }  (delta since cursor; full when absent)
 *   GET /sync/status         -> { lastSyncedAt, pendingCount:0 } (backs the Backup screen)
 */
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Get()
  @Roles('owner', 'staff')
  pull(
    @BusinessId() businessId: string,
    @Query() query: SyncQueryDto,
  ): Promise<SyncResponse> {
    return this.sync.pull(businessId, query);
  }

  @Get('status')
  @Roles('owner', 'staff')
  status(@BusinessId() businessId: string): Promise<SyncStatusResponse> {
    return this.sync.status(businessId);
  }
}
