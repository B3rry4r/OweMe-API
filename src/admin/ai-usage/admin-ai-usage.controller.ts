import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import { AdminJwtGuard, AdminRoles, AdminRolesGuard } from '../common';
import { AdminAiUsageService } from './admin-ai-usage.service';
import {
  AdminAiBusinessView,
  AdminAiParseEventView,
  AdminAiStatsView,
  AdminAiWeekPointView,
  Paged,
} from './admin-ai-usage.views';
import {
  AiByBusinessQueryDto,
  AiRecentParsesQueryDto,
  AiSeriesQueryDto,
} from './dto/admin-ai-usage.dto';

/**
 * AI-usage monitor reads, superadmin + support (registry AdminAiUsageView). GET-only:
 * usage_events is append-only and written exclusively by protected-path instrumentation.
 *   GET /admin/ai-usage/stats          -> 200 AdminAiStatsView
 *   GET /admin/ai-usage/series         -> 200 AdminAiWeekPointView[]
 *   GET /admin/ai-usage/by-business    -> 200 Paged<AdminAiBusinessView>
 *   GET /admin/ai-usage/recent-parses  -> 200 Paged<AdminAiParseEventView>
 */
@Controller('admin/ai-usage')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin', 'support')
export class AdminAiUsageController {
  constructor(private readonly aiUsage: AdminAiUsageService) {}

  @Get('stats')
  stats(): Promise<AdminAiStatsView> {
    return this.aiUsage.stats();
  }

  @Get('series')
  series(@Query() query: AiSeriesQueryDto): Promise<AdminAiWeekPointView[]> {
    return this.aiUsage.series(query);
  }

  @Get('by-business')
  byBusiness(@Query() query: AiByBusinessQueryDto): Promise<Paged<AdminAiBusinessView>> {
    return this.aiUsage.byBusiness(query);
  }

  @Get('recent-parses')
  recentParses(@Query() query: AiRecentParsesQueryDto): Promise<Paged<AdminAiParseEventView>> {
    return this.aiUsage.recentParses(query);
  }
}
