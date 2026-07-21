import { Module } from '@nestjs/common';
import { AdminCommonModule } from './common';
import { AdminAuditModule } from './audit/admin-audit.module';
import { AdminAuthModule } from './auth/admin-auth.module';
import { AdminUsersModule } from './admin-users/admin-users.module';
import { AdminOverviewModule } from './overview/admin-overview.module';
import { AdminBusinessesModule } from './businesses/admin-businesses.module';
import { AdminPlansModule } from './plans/admin-plans.module';
import { AdminDebtsModule } from './debts/admin-debts.module';
import { AdminRemindersModule } from './reminders/admin-reminders.module';
import { AdminBillingModule } from './billing/admin-billing.module';
import { AdminCreditsModule } from './credits/admin-credits.module';
import { AdminPayLinksModule } from './pay-links/admin-pay-links.module';
import { AdminPayoutsModule } from './payouts/admin-payouts.module';
import { AdminAuthMonitorModule } from './auth-monitor/admin-auth-monitor.module';
import { AdminAiUsageModule } from './ai-usage/admin-ai-usage.module';
import { AdminSyncHealthModule } from './sync-health/admin-sync-health.module';

/**
 * The ONE admin aggregation module (conventions: single app.module.ts registration
 * line for the whole admin surface). Wave agents add their src/admin/<resource>
 * modules HERE, never to app.module.ts. All routes live under /admin/* behind the
 * controller-level admin guards; the shipped app surface is untouched.
 */
@Module({
  imports: [
    AdminCommonModule,
    // Wave 1:
    AdminAuditModule,
    AdminAuthModule,
    AdminUsersModule,
    // Wave 2 (read modules):
    AdminOverviewModule,
    AdminBusinessesModule,
    AdminPlansModule,
    AdminDebtsModule,
    AdminRemindersModule,
    AdminBillingModule,
    AdminCreditsModule,
    AdminPayLinksModule,
    AdminPayoutsModule,
    AdminAuthMonitorModule,
    AdminAiUsageModule,
    AdminSyncHealthModule,
  ],
})
export class AdminModule {}
