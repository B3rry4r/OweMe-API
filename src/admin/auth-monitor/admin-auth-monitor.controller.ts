import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import { AdminJwtGuard, AdminRoles, AdminRolesGuard } from '../common';
import { AdminAuthMonitorService } from './admin-auth-monitor.service';
import {
  AdminOtpRequestView,
  AdminOtpSeriesView,
  AdminOtpStatsView,
  AdminSessionSecurityView,
  AdminTestNumberView,
  Paged,
} from './admin-auth-monitor.views';
import {
  OtpRequestsQueryDto,
  OtpSeriesQueryDto,
  SessionsQueryDto,
} from './dto/admin-auth-monitor.dto';

/**
 * OTP + session monitoring, READ-ONLY (registry AdminAuthMonitorView). Support reads
 * the monitor surfaces; the test-number list is superadmin only (method-level gate wins
 * over the class-level one) because it exposes full phone numbers, and even then ONLY
 * for businesses flagged isTest server-side.
 *   GET /admin/auth-monitor/stats        -> 200 AdminOtpStatsView.
 *   GET /admin/auth-monitor/series       -> 200 AdminOtpSeriesView.
 *   GET /admin/auth-monitor/requests     -> 200 Paged<AdminOtpRequestView>.
 *   GET /admin/auth-monitor/test-numbers -> 200 AdminTestNumberView[] (superadmin).
 *   GET /admin/auth-monitor/sessions     -> 200 AdminSessionSecurityView.
 */
@Controller('admin/auth-monitor')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin', 'support')
export class AdminAuthMonitorController {
  constructor(private readonly monitor: AdminAuthMonitorService) {}

  @Get('stats')
  stats(): Promise<AdminOtpStatsView> {
    return this.monitor.stats();
  }

  @Get('series')
  series(@Query() query: OtpSeriesQueryDto): Promise<AdminOtpSeriesView> {
    return this.monitor.series(query);
  }

  @Get('requests')
  requests(@Query() query: OtpRequestsQueryDto): Promise<Paged<AdminOtpRequestView>> {
    return this.monitor.requests(query);
  }

  @Get('test-numbers')
  @AdminRoles('superadmin')
  testNumbers(): Promise<AdminTestNumberView[]> {
    return this.monitor.testNumbers();
  }

  @Get('sessions')
  sessions(@Query() query: SessionsQueryDto): Promise<AdminSessionSecurityView> {
    return this.monitor.sessions(query);
  }
}
