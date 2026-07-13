import { IsOptional, IsString } from 'class-validator';

/** GET /sync?since=<cursor> — delta pull. */
export class SyncQueryDto {
  @IsOptional()
  @IsString()
  since?: string;
}
